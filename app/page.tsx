import {
  getMetrics,
  getFleet,
  getProviderMix,
  getSavingsBreakdown,
  getRecent,
  topFailoverReasons,
  asWindow,
  WINDOWS,
  type WindowKey,
  type CallRow,
  type FleetRow,
  type Metrics,
} from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── formatting ──
const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const pct = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
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

// ── controls ──
function Controls({ projects, project, win }: { projects: string[]; project: string; win: WindowKey }) {
  return (
    <div className="controls">
      <div className="group">
        <span className="label">project</span>
        <a className={`pill${project === "all" ? " active" : ""}`} href={qs("all", win)}>
          all
        </a>
        {projects.map((p) => (
          <a key={p} className={`pill${project === p ? " active" : ""}`} href={qs(p, win)}>
            {p}
          </a>
        ))}
      </div>
      <div className="group">
        <span className="label">window</span>
        {(Object.keys(WINDOWS) as WindowKey[]).map((w) => (
          <a key={w} className={`pill${win === w ? " active" : ""}`} href={qs(project, w)}>
            {w}
          </a>
        ))}
      </div>
    </div>
  );
}

// ── hero cards ──
function Hero({ m }: { m: Metrics }) {
  return (
    <div className="cards">
      <div className="card">
        <div className="k">Saved (vs baseline)</div>
        <div className="v" style={{ color: "var(--green)" }}>
          {money(m.savedUsd)} <small>▼ {pct(m.savePct)}</small>
        </div>
      </div>
      <div className="card">
        <div className="k">Spent</div>
        <div className="v">{money(m.costUsd)}</div>
      </div>
      <div className="card">
        <div className="k">Calls</div>
        <div className="v">
          {compact(m.calls)} <small>· {ms(m.avgLatencyMs)} avg</small>
        </div>
      </div>
      <div className="card">
        <div className="k">Failover health</div>
        <div className="v">
          {pct(m.failoverRate)} <small>· {compact(m.failovers)} caught</small>
        </div>
      </div>
    </div>
  );
}

// ── live feed row ──
function FeedRow({ r }: { r: CallRow }) {
  const failed = r.attempts.filter((a) => !a.ok);
  const cls = !r.ok ? "fail" : r.failed_over ? "warn" : "ok";
  const glyph = !r.ok ? "✗" : r.failed_over ? "⚠" : "✓";
  return (
    <div className="line">
      <span className={`g ${cls}`}>{glyph}</span>
      <span className="model">{r.model}</span>
      <span className="chain">
        {r.attempts.map((a, i) => (
          <span key={i}>
            {i > 0 && <span className="arrow"> → </span>}
            {a.provider}
          </span>
        ))}
      </span>
      <span className="ms">{ms(r.latency_ms)}</span>
      <span className="cost">{r.ok ? money(r.cost_usd) : "FAILED"}</span>
      {failed.length > 0 && (
        <span className="reason">⤷ {failed.map((a) => `${a.provider} ${a.errorClass ?? "error"}`).join(", ")}</span>
      )}
    </div>
  );
}

function SetupNotice({ error }: { error: string }) {
  return (
    <div className="setup">
      <p>
        <b>Storage not ready.</b> Set <code>DATABASE_URL</code> (any Postgres, or a{" "}
        <a href="https://db9.ai">db9</a> connection string) and create the table:
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
    headers: { authorization: \`Bearer \${process.env.LCR_INGEST_KEY}\` },
    project: process.env.LCR_PROJECT,
    dispatch: after,
  }),
});`}</pre>
    </div>
  );
}

// ── views ──
function FleetView({ fleet }: { fleet: FleetRow[] }) {
  return (
    <div className="section">
      <h2>Projects</h2>
      <div className="feed">
        <div className="line" style={{ color: "var(--dim)" }}>
          <span className="model" style={{ width: 130 }}>
            project
          </span>
          <span style={{ width: 70, textAlign: "right" }}>calls</span>
          <span style={{ width: 80, textAlign: "right" }}>spent</span>
          <span style={{ width: 80, textAlign: "right" }}>saved</span>
          <span style={{ width: 60, textAlign: "right" }}>save%</span>
          <span style={{ width: 80, textAlign: "right" }}>failover</span>
          <span style={{ flex: 1, paddingLeft: 16 }}>top provider</span>
        </div>
        {fleet.map((f) => {
          const hot = f.failoverRate > 0.03;
          return (
            <a key={f.project} className="line" href={qs(f.project, "24h")} style={{ color: "var(--text)" }}>
              <span className="model" style={{ width: 130 }}>
                {f.project}
              </span>
              <span style={{ width: 70, textAlign: "right" }}>{compact(f.calls)}</span>
              <span style={{ width: 80, textAlign: "right" }}>{money(f.costUsd)}</span>
              <span style={{ width: 80, textAlign: "right", color: "var(--green)" }}>{money(f.savedUsd)}</span>
              <span style={{ width: 60, textAlign: "right" }}>{pct(f.savePct)}</span>
              <span style={{ width: 80, textAlign: "right", color: hot ? "var(--yellow)" : undefined }}>
                {hot ? "⚠ " : ""}
                {pct(f.failoverRate)}
              </span>
              <span style={{ flex: 1, paddingLeft: 16, color: "var(--dim)" }}>
                {f.topProvider} {pct(f.topProviderPct)}
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function ProjectView({
  mix,
  savings,
  recent,
}: {
  mix: { provider: string; calls: number }[];
  savings: { model: string; provider: string; calls: number; savedUsd: number }[];
  recent: CallRow[];
}) {
  const total = mix.reduce((s, m) => s + m.calls, 0) || 1;
  const reasons = topFailoverReasons(recent);
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}>
        <div className="section mix">
          <h2>Provider mix (who served)</h2>
          {mix.map((m) => (
            <div key={m.provider} className="row">
              <span className="name">{m.provider}</span>
              <span className="bar" style={{ width: `${Math.round((m.calls / total) * 180)}px` }} />
              <span className="n">{pct(m.calls / total)}</span>
            </div>
          ))}
        </div>
        <div className="section reasons">
          <h2>Top failover reasons (recent)</h2>
          {reasons.length === 0 ? (
            <span>none — no failovers in the recent sample</span>
          ) : (
            reasons.map((r) => (
              <span key={r.reason}>
                {r.reason} <b>×{r.count}</b>
              </span>
            ))
          )}
        </div>
      </div>

      <div className="section">
        <h2>Where the savings come from</h2>
        <div className="feed">
          {savings.map((s, i) => (
            <div key={i} className="line">
              <span className="chain">
                {s.model} <span className="arrow">@</span> {s.provider}
              </span>
              <span className="ms" style={{ width: 90 }}>
                {compact(s.calls)} calls
              </span>
              <span className="cost" style={{ color: "var(--green)" }}>
                saved {money(s.savedUsd)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <h2>Live feed</h2>
        <div className="feed">
          {recent.map((r) => (
            <FeedRow key={r.id} r={r} />
          ))}
        </div>
      </div>
    </>
  );
}

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
    const fleet = await getFleet(win);
    projects = fleet.map((f) => f.project);
    const metrics = await getMetrics(project, win);

    if (metrics.calls === 0 && fleet.length === 0) {
      body = <EmptyNotice />;
    } else if (project === "all") {
      body = (
        <>
          <Hero m={metrics} />
          <FleetView fleet={fleet} />
        </>
      );
    } else {
      const [mix, savings, recent] = await Promise.all([
        getProviderMix(project, win),
        getSavingsBreakdown(project, win),
        getRecent(project, win),
      ]);
      body = (
        <>
          <Hero m={metrics} />
          <ProjectView mix={mix} savings={savings} recent={recent} />
        </>
      );
    }
  } catch (e) {
    body = <SetupNotice error={(e as Error).message} />;
  }

  return (
    <main className="wrap">
      <header className="top">
        <h1>ai-lcr {project === "all" ? "· fleet" : `· ${project}`}</h1>
        <span className="sub">least-cost routing across all your providers — what you saved &amp; failed over</span>
      </header>
      <Controls projects={projects} project={project} win={win} />
      {body}
    </main>
  );
}
