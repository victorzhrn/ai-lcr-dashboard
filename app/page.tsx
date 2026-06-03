import {
  getMetrics,
  getTimeSeries,
  getProjectTimeline,
  getFleet,
  getProjects,
  getProviders,
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
import { providerDomainFor } from "@/lib/providers";
import { CollapsibleLog } from "./collapsible-log";
import { TimeChart } from "./time-chart";

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

// ── provider identity: same favicon-over-monogram treatment, so a provider pill
// reads just like a project pill (lib/providers resolves the provider's domain) ──
function ProviderIcon({ provider, size = 14 }: { provider: string; size?: number }) {
  const domain = providerDomainFor(provider);
  const { bg, initial } = monogram(provider);
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

// ── brand mark — the same routing-graph glyph as the favicon, inlined so the
// header logo needs no extra request and scales crisply. ──
function LcrLogo({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden className="logo">
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="#0b1120" stroke="#273253" />
      <g fill="none" strokeLinecap="round" strokeWidth="2.6">
        <path d="M8 16 H15" stroke="#4fe39a" />
        <path d="M15 16 C20 16 20 9.5 24 9.5" stroke="#4fe39a" />
        <path d="M15 16 C20 16 20 22.5 24 22.5" stroke="#62a0ff" />
      </g>
      <circle cx="8" cy="16" r="3" fill="#4fe39a" />
      <circle cx="24" cy="9.5" r="2.7" fill="#4fe39a" />
      <circle cx="24" cy="22.5" r="2.3" fill="#62a0ff" />
    </svg>
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
function qs(project: string, win: WindowKey, provider = "all"): string {
  const base = `?project=${encodeURIComponent(project)}&w=${win}`;
  return provider && provider !== "all" ? `${base}&provider=${encodeURIComponent(provider)}` : base;
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
function Controls({
  projects,
  providers,
  project,
  provider,
  win,
}: {
  projects: string[];
  providers: string[];
  project: string;
  provider: string;
  win: WindowKey;
}) {
  return (
    <div className="controls">
      <div className="group">
        <span className="label">project</span>
        <a className={`pill${project === "all" ? " active" : ""}`} href={qs("all", win, provider)}>
          all
        </a>
        {projects.map((p) => (
          <a key={p} className={`pill pill-p${project === p ? " active" : ""}`} href={qs(p, win, provider)}>
            <ProjectIcon project={p} size={14} />
            {p}
          </a>
        ))}
      </div>
      {providers.length > 0 && (
        <div className="group">
          <span className="label">provider</span>
          <a className={`pill${provider === "all" ? " active" : ""}`} href={qs(project, win, "all")}>
            all
          </a>
          {providers.map((p) => (
            <a key={p} className={`pill pill-p${provider === p ? " active" : ""}`} href={qs(project, win, p)}>
              <ProviderIcon provider={p} size={14} />
              {p}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ── window selector — compact segmented control, top-right ──────────────────
function WindowSelect({ project, provider, win }: { project: string; provider: string; win: WindowKey }) {
  return (
    <div className="wsel">
      {(Object.keys(WINDOWS) as WindowKey[]).map((w) => (
        <a key={w} className={`wopt${win === w ? " active" : ""}`} href={qs(project, w, provider)}>
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
  hint,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "ok" | "warn" | "down";
  spark?: number[];
  sparkTone?: string;
  /** Plain-language explainer shown on hover (native tooltip over the whole tile). */
  hint?: string;
}) {
  return (
    <div className="stat" title={hint}>
      <div className={`s-label${hint ? " hinted" : ""}`}>{label}</div>
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
  const saved = series.map((b) => Math.max(0, b.baseline - b.baseCost));
  const spend = series.map((b) => b.cost);
  const calls = series.map((b) => b.calls);
  // Tone only when a number needs attention — healthy values stay neutral.
  // Save % is always a win (savePct is floored at 0 in queries) — green when
  // there's something saved, neutral at 0. Never red: low savings isn't a fault.
  //
  // Failover caps at warn (yellow), never down (red): a failover is a request
  // that SURVIVED — the first provider failed but a fallback served it, so the
  // user wasn't affected. Red is reserved for the one metric that means a user
  // actually saw an error (Leaked), so red keeps its alarm value. Matches the
  // Fleet table, which already colors failover yellow-only.
  const foTone = m.failoverRate < 0.03 ? undefined : "warn";
  // Of the calls that failed over, the share a fallback caught — green above 99%,
  // since "nearly every hiccup absorbed" is the healthy state. "—" when nothing
  // failed over: there was nothing to catch.
  const caughtPct = m.failovers > 0 ? m.caught / m.failovers : null;
  return (
    <div className="stat-row">
      <Stat
        label="Saved"
        value={<span className="pos">{money(m.savedUsd)}</span>}
        sub={<DeltaSub d={delta(m.savedUsd, prev.savedUsd)} />}
        spark={saved}
        sparkTone="var(--green)"
        hint="What routing saved: each call's cost vs. what the always-on fallback (the list-price provider you'd use without routing) would have charged for the same tokens. When the fallback itself served, this is 0 — no routing happened."
      />
      <Stat
        label="Save %"
        value={m.savePct > 0 ? <span className="pos">{pct(m.savePct)}</span> : pct(m.savePct)}
        sub="vs direct"
        hint="Routing saved as a share of that would-be direct (fallback) cost."
      />
      <Stat
        label="Cache saved"
        value={<span className="cachev">{money(m.cachedSavingUsd)}</span>}
        sub={
          m.cachedInputTokens > 0 ? (
            <span className="cachev">{pct(m.cacheHitRate)} input cached</span>
          ) : (
            <DeltaSub d={delta(m.cachedSavingUsd, prev.cachedSavingUsd)} />
          )
        }
        hint="What prompt caching saved: cached input tokens billed at the provider's discounted cache-read rate instead of full input. The sub-line shows the cache HIT RATE (share of input tokens served from cache) — which can be >0 while the saving reads $0 if that route has no cacheRead rate configured (caching is happening, just not priced). Separate from routing — caching is the provider's own benefit, so it's never folded into Saved."
      />
      <Stat
        label="Spent"
        value={money(m.costUsd)}
        sub={<DeltaSub d={delta(m.costUsd, prev.costUsd)} />}
        spark={spend}
        sparkTone="var(--dim)"
        hint="Actual spend across every call in this window."
      />
      <Stat
        label="Calls"
        value={compact(m.calls)}
        sub={<DeltaSub d={delta(m.calls, prev.calls)} />}
        spark={calls}
        hint="Total requests routed in this window."
      />
      <Stat
        label="Failover"
        value={pct(m.failoverRate)}
        sub={caughtPct == null ? "—" : <span className={caughtPct > 0.99 ? "up" : undefined}>{pct(caughtPct)} caught</span>}
        tone={foTone}
        hint="Calls whose first-choice provider failed, so ai-lcr retried on a fallback. Almost all are 'caught' — the user still got a response. Shown in yellow, never red: the request survived."
      />
      <Stat
        label="Leaked"
        value={m.failures}
        sub={m.failures === 0 ? "all caught" : "reached users"}
        tone={m.failures === 0 ? undefined : "down"}
        hint="Calls where every provider failed, so the error reached the user — a failover that wasn't caught. The only failures users actually felt, which is why this is the metric that turns red."
      />
      <Stat
        label="Tokens"
        value={
          <span className="dual" title={`${m.inputTokens.toLocaleString()} in · ${m.outputTokens.toLocaleString()} out`}>
            {compact(m.inputTokens)}
            <i>/</i>
            {compact(m.outputTokens)}
          </span>
        }
        sub="in / out"
        hint="Input + output tokens across all calls, shown as in / out."
      />
      <Stat
        label="TTFT"
        value={m.ttftMs == null ? "—" : ms(m.ttftMs)}
        hint="Time to first token — mean over streaming calls in this window. The industry-standard responsiveness metric; failover overhead and generation time are excluded. — = no streaming sample yet."
      />
    </div>
  );
}

// ── time-series chart (saved area + spend line) ─────────────────────────────
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

// Success rate as a tinted number. Same thresholds as the health buckets
// (<2% fail = ok, <15% = warn, else down) so the % and the strip agree. Tooltip
// spells out the raw ok/total so a small sample reads honestly.
function SuccessRate({ attempts, failRate }: { attempts: number; failRate: number }) {
  if (!attempts) return <td className="r dim">—</td>;
  const ok = 1 - failRate;
  const tone = failRate < 0.02 ? "pos" : failRate < 0.15 ? "warn" : "bad";
  const okCount = Math.round(ok * attempts);
  return (
    <td className={`r ${tone}`} title={`${okCount}/${attempts} attempts ok · ${pct(failRate)} failed`}>
      {pct(ok)}
    </td>
  );
}

// ── providers table (who served · cost · health), the provider axis ─────────
interface ProviderRow {
  provider: string;
  share: number;
  calls: number;
  tokens: number;
  spentUsd: number; // total cost on this provider
  costPerCall: number;
  savedUsd: number;
  cacheHitRate: number; // share of this provider's input tokens served from cache
  attempts: number; // total attempts on this provider (winner + failed-over-away)
  failRate: number; // fraction of those attempts that errored
  buckets: (ProjectStatus | "none")[];
}

// Merge the winner-based stats (served / cost / saved) with the attempts-based
// health (buckets) — keyed by provider. Union of both: a provider that only ever
// failed (never won a call) still appears, with a red health strip.
function mergeProviders(stats: ProviderStat[], health: ProviderHealthRow[]): ProviderRow[] {
  const m = new Map<string, ProviderRow>();
  for (const h of health) {
    m.set(h.provider, { provider: h.provider, share: 0, calls: 0, tokens: 0, spentUsd: 0, costPerCall: 0, savedUsd: 0, cacheHitRate: 0, attempts: h.attempts, failRate: h.failRate, buckets: h.buckets });
  }
  for (const s of stats) {
    const base = m.get(s.provider) ?? { provider: s.provider, attempts: 0, failRate: 0, buckets: [] as (ProjectStatus | "none")[] };
    m.set(s.provider, {
      ...base,
      provider: s.provider,
      share: s.share,
      calls: s.calls,
      tokens: s.tokens,
      spentUsd: s.spentUsd,
      costPerCall: s.costPerCall,
      savedUsd: s.savedUsd,
      cacheHitRate: s.cacheHitRate,
    } as ProviderRow);
  }
  return [...m.values()].sort((a, b) => b.calls - a.calls);
}

function ProviderTable({
  rows,
  note,
  project,
  win,
  activeProvider,
}: {
  rows: ProviderRow[];
  note?: string;
  project: string;
  win: WindowKey;
  activeProvider: string;
}) {
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
            <th className="r">spent</th>
            <th className="r">saved</th>
            <th className="r" title="Share of this provider's input tokens served from prompt cache (cached ÷ input).">cache</th>
            <th className="r">reliability</th>
            <th className="hcol">health</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.provider} className="rowlink">
              <td>
                {/* clicking a provider row filters the whole view to it (keeps the
                    current project + window); clicking the active one clears it */}
                <a
                  href={qs(project, win, r.provider === activeProvider ? "all" : r.provider)}
                  className={`cell-link${r.provider === activeProvider ? " active" : ""}`}
                >
                  <ProviderIcon provider={r.provider} size={16} />
                  <span className="pname">{r.provider}</span>
                </a>
              </td>
              <td className="gauge-col">
                <span className="gauge">
                  <span className="gfill" style={{ width: `${(r.share / max) * 100}%` }} />
                </span>
                <span className="gpct">{pct(r.share)}</span>
              </td>
              <td className="r">{compact(r.calls)}</td>
              <td className="r dim">{compact(r.tokens)}</td>
              <td className="r">{money(r.costPerCall)}</td>
              <td className="r">{money(r.spentUsd)}</td>
              <td className="r pos">{money(r.savedUsd)}</td>
              <td className={`r ${r.cacheHitRate > 0 ? "cachev" : "dim"}`}>{r.cacheHitRate > 0 ? pct(r.cacheHitRate) : "—"}</td>
              <SuccessRate attempts={r.attempts} failRate={r.failRate} />
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
// Save % only ever ranges [0, good] — green when saving, muted at 0. Red stays
// reserved for real faults (failover, leaked), so it keeps its alarm value.
function saveTone(p: number): string {
  return p > 0 ? "ok" : "muted";
}

function FleetTable({ fleet, timeline, win, provider }: { fleet: FleetRow[]; timeline: TimelineRow[]; win: WindowKey; provider: string }) {
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
                  <a href={qs(f.project, win, provider)} className="cell-link">
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
  spentUsd: number;
  costPerCall: number;
  avgLatencyMs: number;
  ttftMs: number | null;
  tokensPerSec: number | null;
  savedUsd: number;
  cacheHitRate?: number; // share of input read from cache; omitted on the provider axis
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
  const showCache = rows.some((r) => r.cacheHitRate !== undefined);
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
            <th className="r">spent</th>
            <th className="r">latency</th>
            <th className="r" title="Time to first token — streaming calls only. — = no streaming sample in this window.">ttft</th>
            <th className="r" title="Output throughput: output tokens ÷ generation time (latency − ttft), over streaming calls.">tok/s</th>
            {showCache && (
              <th className="r" title="Share of input tokens served from prompt cache (cached ÷ input). >0 means caching is working even when the $ saving line reads near-zero.">cache</th>
            )}
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
              <td className="r">{money(r.spentUsd)}</td>
              <td className="r dim">{ms(r.avgLatencyMs)}</td>
              <td className="r dim">{r.ttftMs == null ? "—" : ms(r.ttftMs)}</td>
              <td className="r dim">{r.tokensPerSec == null ? "—" : `${Math.round(r.tokensPerSec)}/s`}</td>
              {showCache && (
                <td className={`r ${r.cacheHitRate && r.cacheHitRate > 0 ? "cachev" : "dim"}`}>
                  {r.cacheHitRate && r.cacheHitRate > 0 ? pct(r.cacheHitRate) : "—"}
                </td>
              )}
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
    spentUsd: m.spentUsd,
    costPerCall: m.costPerCall,
    avgLatencyMs: m.avgLatencyMs,
    ttftMs: m.ttftMs,
    tokensPerSec: m.tokensPerSec,
    savedUsd: m.savedUsd,
    cacheHitRate: m.cacheHitRate,
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
        <CollapsibleLog initial={20} step={30}>
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
        </CollapsibleLog>
      )}
    </div>
  );
}

// ── setup / empty notices ───────────────────────────────────────────────────
function SetupNotice({ error }: { error: string }) {
  return (
    <div className="setup">
      <p>
        <b>Storage not ready.</b> Set <code>DATABASE_URL</code> to any Postgres
        (Neon, Supabase, RDS, your own) and create the table:
      </p>
      <pre>{`npm run db:init   # create the lcr_calls table (or it auto-creates on first use)`}</pre>
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
  searchParams: Promise<{ project?: string; w?: string; provider?: string }>;
}) {
  const sp = await searchParams;
  const win = asWindow(sp.w);
  const project = sp.project ?? "all";
  const provider = sp.provider ?? "all";

  let body: React.ReactNode;
  let projects: string[] = [];
  let providers: string[] = [];

  try {
    await ensureSchema(); // fresh deploy: create the table so we show "no calls yet", not a DB error
    // Pill lists are the full window-wide sets, independent of the active filter
    // (so picking one never hides the others). Fleet is provider-scoped.
    const [projectList, providerList, fleet] = await Promise.all([
      getProjects(win),
      getProviders(win),
      getFleet(win, provider),
    ]);
    projects = projectList;
    providers = providerList;
    const [metrics, prev, series] = await Promise.all([
      getMetrics(project, win, false, provider),
      getMetrics(project, win, true, provider),
      getTimeSeries(project, win, provider),
    ]);

    if (metrics.calls === 0 && fleet.length === 0 && projects.length === 0) {
      body = <EmptyNotice />;
    } else if (project === "all") {
      const [timeline, provStats, provHealth, models, events] = await Promise.all([
        getProjectTimeline(win, provider),
        getProviderStats("all", win, provider),
        getProviderHealth("all", win, 8000, provider),
        getModelStats("all", win, provider),
        getFailoverEvents("all", win, 40, provider),
      ]);
      const provs = mergeProviders(provStats, provHealth);
      body = (
        <>
          <StatRow m={metrics} prev={prev} series={series} />
          <TimeChart series={series} win={win} />
          <FleetTable fleet={fleet} timeline={timeline} win={win} provider={provider} />
          {provs.length > 0 && <ProviderTable rows={provs} project="all" win={win} activeProvider={provider} />}
          <BreakdownTable title="Models · what ran" label="model" rows={modelRows(models)} />
          <EventsLog events={events} win={win} scopeLabel={provider === "all" ? "" : `· ${provider}`} showProject />
        </>
      );
    } else {
      const [provStats, provHealth, models, events] = await Promise.all([
        getProviderStats(project, win, provider),
        getProviderHealth(project, win, 8000, provider),
        getModelStats(project, win, provider),
        getFailoverEvents(project, win, 40, provider),
      ]);
      const provs = mergeProviders(provStats, provHealth);
      body = (
        <>
          <StatRow m={metrics} prev={prev} series={series} />
          <TimeChart series={series} win={win} />
          <ProviderTable rows={provs} note="list/call & vetted — coming in P1" project={project} win={win} activeProvider={provider} />
          <BreakdownTable title="Models · what ran" label="model" rows={modelRows(models)} />
          <EventsLog
            events={events}
            win={win}
            scopeLabel={`· ${project}${provider === "all" ? "" : ` · ${provider}`}`}
            showProject={false}
          />
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
            {/* clicking the brand returns to the default home view (all projects,
                all providers), keeping only the current time window */}
            <a className="home" href={qs("all", win)} title="Back to all projects">
              <LcrLogo size={20} />
              ai-lcr
            </a>
            {project !== "all" && (
              <>
                <span className="slash">/</span>
                <span className="hproj">
                  <ProjectIcon project={project} size={18} /> {project}
                </span>
              </>
            )}
            {provider !== "all" && (
              <>
                <span className="slash">·</span>
                <span className="hproj">
                  <ProviderIcon provider={provider} size={16} /> {provider}
                </span>
              </>
            )}
          </h1>
          <span className="sub">least-cost routing · savings &amp; failover health across every provider</span>
        </div>
        <WindowSelect project={project} provider={provider} win={win} />
      </header>
      <Controls projects={projects} providers={providers} project={project} provider={provider} win={win} />
      {body}
    </main>
  );
}
