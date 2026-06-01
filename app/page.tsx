import {
  getMetrics,
  getTimeSeries,
  getProjectTimeline,
  getFleet,
  getProviderStats,
  getModelStats,
  getProviderHealth,
  getFailoverEvents,
  asWindow,
  projectStatus,
  WINDOWS,
  type WindowKey,
  type Metrics,
  type Bucket,
  type TimelineRow,
  type FleetRow,
  type ProviderStat,
  type ModelStat,
  type ProviderHealthRow,
  type ProjectStatus,
  type CallRow,
} from "@/lib/queries";
import { ensureSchema } from "@/lib/db";
import { domainFor, monogram } from "@/lib/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── project identity: favicon (via the dashboard's own proxy) over a monogram ──
function ProjectIcon({ project, size = 18 }: { project: string; size?: number }) {
  const domain = domainFor(project);
  const { bg, initial } = monogram(project);
  return (
    <span className="picon" style={{ width: size, height: size, background: bg, fontSize: Math.round(size * 0.52) }}>
      {initial}
      {domain && (
        <span
          className="pfav"
          style={{ backgroundImage: `url(/api/favicon?domain=${encodeURIComponent(domain)})` }}
        />
      )}
    </span>
  );
}

// ── formatting ──────────────────────────────────────────────────────────────
const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const pct = (n: number) => `${(n * 100).toFixed(n < 0.1 && n > 0 ? 1 : 0)}%`;
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}
function qs(project: string, win: WindowKey): string {
  return `?project=${encodeURIComponent(project)}&w=${win}`;
}
function clock(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function dayLabel(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function eventTime(ts: string, win: WindowKey): string {
  const sec = Math.floor(new Date(ts).getTime() / 1000);
  return win === "7d" || win === "30d" ? `${dayLabel(sec)} ${clock(sec)}` : clock(sec);
}

// Δ vs the previous window of the same length.
function delta(cur: number, prev: number): { text: string; up: boolean } | null {
  if (prev <= 0) return null;
  const d = (cur - prev) / prev;
  if (Math.abs(d) < 0.005) return { text: "≈ flat", up: false };
  return { text: `${d > 0 ? "▲" : "▼"} ${Math.abs(d * 100).toFixed(0)}% vs prev`, up: d > 0 };
}

// ── project selector (template var) ─────────────────────────────────────────
function Controls({ projects, project, win }: { projects: string[]; project: string; win: WindowKey }) {
  return (
    <div className="controls">
      <div className="group">
        <span className="label">project</span>
        <a className={`pill${project === "all" ? " active" : ""}`} href={qs("all", win)}>
          all
        </a>
        {projects.map((p) => (
          <a key={p} className={`pill pill-p${project === p ? " active" : ""}`} href={qs(p, win)}>
            <ProjectIcon project={p} size={14} />
            {p}
          </a>
        ))}
      </div>
    </div>
  );
}

// ── window selector — compact segmented control, top-right ──────────────────
function WindowSelect({ project, win }: { project: string; win: WindowKey }) {
  return (
    <div className="wsel">
      {(Object.keys(WINDOWS) as WindowKey[]).map((w) => (
        <a key={w} className={`wopt${win === w ? " active" : ""}`} href={qs(project, w)}>
          {w}
        </a>
      ))}
    </div>
  );
}

// ── sparkline (behind a stat value) ─────────────────────────────────────────
function Sparkline({ data, tone }: { data: number[]; tone?: string }) {
  if (data.length < 2 || data.every((v) => v === 0)) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 100;
  const h = 30;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke={tone ?? "var(--accent)"} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ── stat tile ───────────────────────────────────────────────────────────────
function Stat({
  label,
  value,
  sub,
  tone,
  spark,
  sparkTone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "ok" | "warn" | "down";
  spark?: number[];
  sparkTone?: string;
}) {
  return (
    <div className="stat">
      <div className="s-label">{label}</div>
      <div className={`s-value${tone ? ` v-${tone}` : ""}`}>{value}</div>
      {sub && <div className="s-sub">{sub}</div>}
      {spark && <Sparkline data={spark} tone={sparkTone} />}
    </div>
  );
}

function DeltaSub({ d }: { d: ReturnType<typeof delta> }) {
  if (!d) return null;
  return <span className={d.up ? "up" : "down"}>{d.text}</span>;
}

// ── stat row ────────────────────────────────────────────────────────────────
function StatRow({ m, prev, series }: { m: Metrics; prev: Metrics; series: Bucket[] }) {
  const saved = series.map((b) => Math.max(0, b.baseline - b.cost));
  const spend = series.map((b) => b.cost);
  const calls = series.map((b) => b.calls);
  // Tone only when a number needs attention — healthy values stay neutral.
  const saveTone = m.savePct < 0.2 ? "down" : m.savePct < 0.4 ? "warn" : undefined;
  const foTone = m.failoverRate < 0.03 ? undefined : m.failoverRate < 0.08 ? "warn" : "down";
  return (
    <div className="stat-row">
      <Stat
        label="Saved"
        value={<span className="pos">{money(m.savedUsd)}</span>}
        sub={<DeltaSub d={delta(m.savedUsd, prev.savedUsd)} />}
        spark={saved}
        sparkTone="var(--green)"
      />
      <Stat label="Save %" value={pct(m.savePct)} sub="vs direct" tone={saveTone} />
      <Stat
        label="Spent"
        value={money(m.costUsd)}
        sub={<DeltaSub d={delta(m.costUsd, prev.costUsd)} />}
        spark={spend}
        sparkTone="var(--dim)"
      />
      <Stat
        label="Calls"
        value={compact(m.calls)}
        sub={<DeltaSub d={delta(m.calls, prev.calls)} />}
        spark={calls}
      />
      <Stat label="Failover" value={pct(m.failoverRate)} sub={`${compact(m.caught)} caught`} tone={foTone} />
      <Stat
        label="Leaked"
        value={m.failures}
        sub={m.failures === 0 ? "clear" : "hit users"}
        tone={m.failures === 0 ? undefined : "down"}
      />
      <Stat label="Tokens" value={compact(m.tokens)} sub="in + out" />
      <Stat label="Avg latency" value={ms(m.avgLatencyMs)} />
    </div>
  );
}

// ── time-series chart (saved area + spend line) ─────────────────────────────
function TimeChart({ series, win }: { series: Bucket[]; win: WindowKey }) {
  const saved = series.map((b) => Math.max(0, b.baseline - b.cost));
  const spend = series.map((b) => b.cost);
  const max = Math.max(...saved, ...spend, 1e-9);
  const w = 1000;
  const h = 130;
  const n = series.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * w : 0);
  const y = (v: number) => h - (v / max) * h;
  const area = `0,${h} ${saved.map((v, i) => `${x(i)},${y(v)}`).join(" ")} ${w},${h}`;
  const line = spend.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const ticks = [0, Math.floor(n / 2), n - 1].filter((i, idx, a) => a.indexOf(i) === idx && i >= 0 && i < n);
  const labelAt = (i: number) =>
    win === "7d" || win === "30d" ? dayLabel(series[i].t) : clock(series[i].t);
  return (
    <div className="panel">
      <div className="p-head">
        <span className="p-title">Saved vs spent over time</span>
        <span className="legend">
          <i className="sw green" /> saved <i className="sw dim" /> spent
        </span>
      </div>
      <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <polygon points={area} fill="rgba(63,185,80,.16)" />
        <polyline points={saved.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke="var(--green)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <polyline points={line} fill="none" stroke="var(--dim)" strokeWidth="1.5" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="axis">
        {ticks.map((i) => (
          <span key={i}>{labelAt(i)}</span>
        ))}
      </div>
    </div>
  );
}

// ── inline health strip — per-row health over time, embedded as a column in the
// project & provider tables (replaces the two standalone full-width timelines) ─
function HealthStrip({ buckets }: { buckets: (ProjectStatus | "none")[] }) {
  if (!buckets || buckets.length === 0) return <span className="dim">—</span>;
  const bad = buckets.filter((s) => s === "down").length;
  const warn = buckets.filter((s) => s === "warn").length;
  const title = bad ? `${bad} interval(s) leaked` : warn ? `${warn} interval(s) elevated failover` : "healthy";
  return (
    <span className="hstrip" title={title}>
      {buckets.map((s, i) => (
        <span key={i} className={`seg ${s}`} />
      ))}
    </span>
  );
}

// ── providers table (who served · cost · health), the provider axis ─────────
interface ProviderRow {
  provider: string;
  share: number;
  calls: number;
  tokens: number;
  costPerCall: number;
  savedUsd: number;
  buckets: (ProjectStatus | "none")[];
}

// Merge the winner-based stats (served / cost / saved) with the attempts-based
// health (buckets) — keyed by provider. Union of both: a provider that only ever
// failed (never won a call) still appears, with a red health strip.
function mergeProviders(stats: ProviderStat[], health: ProviderHealthRow[]): ProviderRow[] {
  const m = new Map<string, ProviderRow>();
  for (const h of health) {
    m.set(h.provider, { provider: h.provider, share: 0, calls: 0, tokens: 0, costPerCall: 0, savedUsd: 0, buckets: h.buckets });
  }
  for (const s of stats) {
    const base = m.get(s.provider) ?? { provider: s.provider, buckets: [] as (ProjectStatus | "none")[] };
    m.set(s.provider, {
      ...base,
      provider: s.provider,
      share: s.share,
      calls: s.calls,
      tokens: s.tokens,
      costPerCall: s.costPerCall,
      savedUsd: s.savedUsd,
    } as ProviderRow);
  }
  return [...m.values()].sort((a, b) => b.calls - a.calls);
}

function ProviderTable({ rows, note }: { rows: ProviderRow[]; note?: string }) {
  const max = Math.max(...rows.map((r) => r.share), 1e-9);
  return (
    <div className="panel">
      <div className="p-head">
        <span className="p-title">Providers · who served</span>
        {note && <span className="legend p1">{note}</span>}
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>provider</th>
            <th className="gauge-col">share</th>
            <th className="r">calls</th>
            <th className="r">tokens</th>
            <th className="r">you/call</th>
            <th className="r">saved</th>
            <th className="hcol">health</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.provider}>
              <td>{r.provider}</td>
              <td className="gauge-col">
                <span className="gauge">
                  <span className="gfill" style={{ width: `${(r.share / max) * 100}%` }} />
                </span>
                <span className="gpct">{pct(r.share)}</span>
              </td>
              <td className="r">{compact(r.calls)}</td>
              <td className="r dim">{compact(r.tokens)}</td>
              <td className="r">{money(r.costPerCall)}</td>
              <td className="r pos">{money(r.savedUsd)}</td>
              <td className="hcol">
                <HealthStrip buckets={r.buckets} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── fleet table (projects axis · health embedded as a column) ───────────────
function saveTone(p: number): string {
  return p >= 0.4 ? "ok" : p >= 0.2 ? "warn" : "down";
}

function FleetTable({ fleet, timeline, win }: { fleet: FleetRow[]; timeline: TimelineRow[]; win: WindowKey }) {
  const health = new Map(timeline.map((t) => [t.project, t.buckets]));
  return (
    <div className="panel">
      <div className="p-head">
        <span className="p-title">Projects</span>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>project</th>
            <th className="r">calls</th>
            <th className="r">spent</th>
            <th className="r">saved</th>
            <th className="r">save%</th>
            <th className="r">failover</th>
            <th className="r">leaked</th>
            <th className="hcol">health</th>
          </tr>
        </thead>
        <tbody>
          {fleet.map((f) => {
            const s = projectStatus(f);
            return (
              <tr key={f.project} className="rowlink">
                <td>
                  <a href={qs(f.project, win)} className="cell-link">
                    <span className={`dot ${s}`} />
                    <ProjectIcon project={f.project} size={16} />
                    <span className="pname">{f.project}</span>
                  </a>
                </td>
                <td className="r">{compact(f.calls)}</td>
                <td className="r">{money(f.costUsd)}</td>
                <td className="r pos">{money(f.savedUsd)}</td>
                <td className="r">
                  <span className={`tag t-${saveTone(f.savePct)}`}>{pct(f.savePct)}</span>
                </td>
                <td className={`r${f.failoverRate > 0.03 ? " warn" : ""}`}>{pct(f.failoverRate)}</td>
                <td className={`r${f.failures > 0 ? " bad" : ""}`}>{f.failures}</td>
                <td className="hcol">
                  <HealthStrip buckets={health.get(f.project) ?? []} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── breakdown table — shared by the provider (who served) and model (what ran)
// axes. Same columns; only the title, first column, and optional icon differ. ──
interface BreakdownRow {
  key: string;
  share: number;
  calls: number;
  tokens: number;
  costPerCall: number;
  avgLatencyMs: number;
  savedUsd: number;
}

function BreakdownTable({
  title,
  label,
  rows,
  note,
}: {
  title: string;
  label: string;
  rows: BreakdownRow[];
  note?: string;
}) {
  const max = Math.max(...rows.map((r) => r.share), 1e-9);
  return (
    <div className="panel">
      <div className="p-head">
        <span className="p-title">{title}</span>
        {note && <span className="legend p1">{note}</span>}
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>{label}</th>
            <th className="gauge-col">share</th>
            <th className="r">calls</th>
            <th className="r">tokens</th>
            <th className="r">you/call</th>
            <th className="r">latency</th>
            <th className="r">saved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.key}</td>
              <td className="gauge-col">
                <span className="gauge">
                  <span className="gfill" style={{ width: `${(r.share / max) * 100}%` }} />
                </span>
                <span className="gpct">{pct(r.share)}</span>
              </td>
              <td className="r">{compact(r.calls)}</td>
              <td className="r dim">{compact(r.tokens)}</td>
              <td className="r">{money(r.costPerCall)}</td>
              <td className="r dim">{ms(r.avgLatencyMs)}</td>
              <td className="r pos">{money(r.savedUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const modelRows = (s: ModelStat[]): BreakdownRow[] =>
  s.map((m) => ({
    key: m.model,
    share: m.share,
    calls: m.calls,
    tokens: m.tokens,
    costPerCall: m.costPerCall,
    avgLatencyMs: m.avgLatencyMs,
    savedUsd: m.savedUsd,
  }));

// ── failover events log ─────────────────────────────────────────────────────
function EventsLog({
  events,
  win,
  scopeLabel,
  showProject,
}: {
  events: CallRow[];
  win: WindowKey;
  scopeLabel: string;
  showProject: boolean;
}) {
  return (
    <div className="panel">
      <div className="p-head">
        <span className="p-title">Failover events {scopeLabel}</span>
      </div>
      {events.length === 0 ? (
        <div className="muted">No failovers in this window — every call served on the first provider.</div>
      ) : (
        <div className="log">
          {events.map((e) => {
            const failed = e.attempts.filter((a) => !a.ok);
            const reasons = failed.map((a) => `${a.provider} ${a.errorClass ?? "error"}`).join(", ");
            return (
              <div key={e.id} className={`log-line ${e.ok ? "caught" : "leaked"}`}>
                <span className="lt">{eventTime(e.ts, win)}</span>
                {showProject && (
                  <span className="lp">
                    <ProjectIcon project={e.project} size={13} /> {e.project}
                  </span>
                )}
                <span className="lr">{reasons}</span>
                <span className="larr">→</span>
                <span className="lw">{e.ok ? e.winner : "all failed"}</span>
                <span className="ltok">{compact(e.tokens)} tok</span>
                <span className="lst">{e.ok ? `✓ +${ms(e.latency_ms)}` : "✗ LEAKED"}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── setup / empty notices ───────────────────────────────────────────────────
function SetupNotice({ error }: { error: string }) {
  return (
    <div className="setup">
      <p>
        <b>Storage not ready.</b> Set <code>DATABASE_URL</code> (any Postgres, or a <a href="https://db9.ai">db9</a>{" "}
        connection string) and create the table:
      </p>
      <pre>{`npm run db:init          # any Postgres via DATABASE_URL
npm run db:provision:db9 # or provision a db9 database in seconds`}</pre>
      <p style={{ fontSize: 12 }}>({error})</p>
    </div>
  );
}

function EmptyNotice() {
  return (
    <div className="empty">
      <p>
        <b>No calls yet.</b> Point ai-lcr&apos;s <code>onCall</code> at this dashboard:
      </p>
      <pre>{`import { createLCR, createHttpSink } from "ai-lcr";
import { after } from "next/server";

createLCR({
  models: { /* … */ },
  onCall: createHttpSink({
    url: process.env.LCR_INGEST_URL + "/api/ingest",
    project: process.env.LCR_PROJECT,
    dispatch: after,
  }),
});`}</pre>
    </div>
  );
}

// ── page ────────────────────────────────────────────────────────────────────
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; w?: string }>;
}) {
  const sp = await searchParams;
  const win = asWindow(sp.w);
  const project = sp.project ?? "all";

  let body: React.ReactNode;
  let projects: string[] = [];

  try {
    await ensureSchema(); // fresh deploy: create the table so we show "no calls yet", not a DB error
    const fleet = await getFleet(win);
    projects = fleet.map((f) => f.project);
    const [metrics, prev, series] = await Promise.all([
      getMetrics(project, win),
      getMetrics(project, win, true),
      getTimeSeries(project, win),
    ]);

    if (metrics.calls === 0 && fleet.length === 0) {
      body = <EmptyNotice />;
    } else if (project === "all") {
      const [timeline, provStats, provHealth, models, events] = await Promise.all([
        getProjectTimeline(win),
        getProviderStats("all", win),
        getProviderHealth("all", win),
        getModelStats("all", win),
        getFailoverEvents("all", win),
      ]);
      const providers = mergeProviders(provStats, provHealth);
      body = (
        <>
          <StatRow m={metrics} prev={prev} series={series} />
          <TimeChart series={series} win={win} />
          <FleetTable fleet={fleet} timeline={timeline} win={win} />
          {providers.length > 0 && <ProviderTable rows={providers} />}
          <BreakdownTable title="Models · what ran" label="model" rows={modelRows(models)} />
          <EventsLog events={events} win={win} scopeLabel="" showProject />
        </>
      );
    } else {
      const [provStats, provHealth, models, events] = await Promise.all([
        getProviderStats(project, win),
        getProviderHealth(project, win),
        getModelStats(project, win),
        getFailoverEvents(project, win),
      ]);
      const providers = mergeProviders(provStats, provHealth);
      body = (
        <>
          <StatRow m={metrics} prev={prev} series={series} />
          <TimeChart series={series} win={win} />
          <ProviderTable rows={providers} note="list/call & vetted — coming in P1" />
          <BreakdownTable title="Models · what ran" label="model" rows={modelRows(models)} />
          <EventsLog events={events} win={win} scopeLabel={`· ${project}`} showProject={false} />
        </>
      );
    }
  } catch (e) {
    body = <SetupNotice error={(e as Error).message} />;
  }

  return (
    <main className="wrap">
      <header className="top">
        <div className="brand">
          <h1>
            <span className="live" /> ai-lcr
            {project !== "all" && (
              <>
                <span className="slash">/</span>
                <span className="hproj">
                  <ProjectIcon project={project} size={18} /> {project}
                </span>
              </>
            )}
          </h1>
          <span className="sub">least-cost routing · savings &amp; failover health across every provider</span>
        </div>
        <WindowSelect project={project} win={win} />
      </header>
      <Controls projects={projects} project={project} win={win} />
      {body}
    </main>
  );
}
