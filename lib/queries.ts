import { getPool } from "./db";

// Fixed window allowlist → inline interval literal. db9's SQL layer rejects
// parameterized `::interval` casts, so we inline a literal from this map (never
// user input → no injection).
export const WINDOWS = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
} as const;
export type WindowKey = keyof typeof WINDOWS;

export function asWindow(v: string | undefined): WindowKey {
  return v && v in WINDOWS ? (v as WindowKey) : "24h";
}

// project = "all" → no filter. Otherwise filter by the tag.
function scope(project: string): { clause: string; params: string[] } {
  return project === "all"
    ? { clause: "", params: [] }
    : { clause: " AND project = $1", params: [project] };
}

function since(win: WindowKey): string {
  return `ts > now() - interval '${WINDOWS[win]}'`;
}

export interface Metrics {
  calls: number;
  failovers: number;
  failoverRate: number;
  costUsd: number;
  savedUsd: number;
  savePct: number;
  avgLatencyMs: number;
}

export async function getMetrics(project: string, win: WindowKey): Promise<Metrics> {
  const { clause, params } = scope(project);
  const { rows } = await getPool().query(
    `SELECT
        count(*)::int                            AS calls,
        count(*) FILTER (WHERE failed_over)::int AS failovers,
        coalesce(sum(cost_usd), 0)::float8       AS cost_usd,
        coalesce(sum(baseline_usd), 0)::float8   AS baseline_usd,
        coalesce(avg(latency_ms), 0)::float8     AS avg_latency
       FROM lcr_calls
      WHERE ${since(win)}${clause}`,
    params,
  );
  const r = rows[0] ?? { calls: 0, failovers: 0, cost_usd: 0, baseline_usd: 0, avg_latency: 0 };
  const savedUsd = Math.max(0, r.baseline_usd - r.cost_usd);
  return {
    calls: r.calls,
    failovers: r.failovers,
    failoverRate: r.calls > 0 ? r.failovers / r.calls : 0,
    costUsd: r.cost_usd,
    savedUsd,
    savePct: r.baseline_usd > 0 ? savedUsd / r.baseline_usd : 0,
    avgLatencyMs: r.avg_latency,
  };
}

export interface ProviderShare {
  provider: string;
  calls: number;
}

export async function getProviderMix(project: string, win: WindowKey): Promise<ProviderShare[]> {
  const { clause, params } = scope(project);
  const { rows } = await getPool().query(
    `SELECT coalesce(winner, '(failed)') AS provider, count(*)::int AS calls
       FROM lcr_calls
      WHERE ${since(win)}${clause}
      GROUP BY winner
      ORDER BY calls DESC`,
    params,
  );
  return rows as ProviderShare[];
}

export interface SavingsRow {
  model: string;
  provider: string;
  calls: number;
  savedUsd: number;
}

export async function getSavingsBreakdown(project: string, win: WindowKey): Promise<SavingsRow[]> {
  const { clause, params } = scope(project);
  const { rows } = await getPool().query(
    `SELECT model, coalesce(winner, '(failed)') AS provider, count(*)::int AS calls,
            coalesce(sum(baseline_usd - cost_usd), 0)::float8 AS saved_usd
       FROM lcr_calls
      WHERE ${since(win)}${clause}
      GROUP BY model, winner
      ORDER BY saved_usd DESC
      LIMIT 8`,
    params,
  );
  return rows.map((r) => ({ model: r.model, provider: r.provider, calls: r.calls, savedUsd: r.saved_usd }));
}

export interface CallRow {
  id: string;
  project: string;
  ts: string;
  model: string;
  winner: string | null;
  ok: boolean;
  failed_over: boolean;
  latency_ms: number;
  cost_usd: number;
  attempts: { provider: string; ok: boolean; latencyMs: number; errorClass?: string }[];
}

export async function getRecent(project: string, win: WindowKey, limit = 60): Promise<CallRow[]> {
  const { clause, params } = scope(project);
  const { rows } = await getPool().query(
    `SELECT id, project, ts, model, winner, ok, failed_over, latency_ms,
            cost_usd::float8 AS cost_usd, attempts
       FROM lcr_calls
      WHERE ${since(win)}${clause}
      ORDER BY ts DESC
      LIMIT ${limit}`,
    params,
  );
  return rows as CallRow[];
}

export interface FleetRow {
  project: string;
  calls: number;
  costUsd: number;
  savedUsd: number;
  savePct: number;
  failoverRate: number;
  failRate: number; // share of calls where every provider failed (ok = false)
  topProvider: string;
  topProviderPct: number;
}

export type ProjectStatus = "ok" | "warn" | "down";

// down: real failures slipping through · warn: elevated failover (degraded but
// recovering) · ok: healthy.
export function projectStatus(f: { failRate: number; failoverRate: number }): ProjectStatus {
  if (f.failRate > 0.005) return "down";
  if (f.failoverRate > 0.03) return "warn";
  return "ok";
}

// Per-project rollup for the fleet overview. Two db9-safe GROUP BYs merged in JS
// (avoids window functions): totals per project + winner shares per project.
export async function getFleet(win: WindowKey): Promise<FleetRow[]> {
  const pool = getPool();
  const totals = await pool.query(
    `SELECT project,
            count(*)::int                            AS calls,
            count(*) FILTER (WHERE failed_over)::int AS failovers,
            count(*) FILTER (WHERE NOT ok)::int      AS failures,
            coalesce(sum(cost_usd), 0)::float8       AS cost_usd,
            coalesce(sum(baseline_usd), 0)::float8   AS baseline_usd
       FROM lcr_calls
      WHERE ${since(win)}
      GROUP BY project`,
  );
  const mix = await pool.query(
    `SELECT project, coalesce(winner, '(failed)') AS provider, count(*)::int AS calls
       FROM lcr_calls
      WHERE ${since(win)}
      GROUP BY project, winner`,
  );

  const top = new Map<string, { provider: string; calls: number }>();
  for (const m of mix.rows) {
    const cur = top.get(m.project);
    if (!cur || m.calls > cur.calls) top.set(m.project, { provider: m.provider, calls: m.calls });
  }

  return totals.rows
    .map((r): FleetRow => {
      const saved = Math.max(0, r.baseline_usd - r.cost_usd);
      const t = top.get(r.project);
      return {
        project: r.project,
        calls: r.calls,
        costUsd: r.cost_usd,
        savedUsd: saved,
        savePct: r.baseline_usd > 0 ? saved / r.baseline_usd : 0,
        failoverRate: r.calls > 0 ? r.failovers / r.calls : 0,
        failRate: r.calls > 0 ? r.failures / r.calls : 0,
        topProvider: t?.provider ?? "—",
        topProviderPct: t && r.calls > 0 ? t.calls / r.calls : 0,
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

// Top failover reasons, computed in JS from the recent sample — keeps the SQL
// db9-safe (no jsonb_array_elements). Labelled "recent" in the UI.
export function topFailoverReasons(rows: CallRow[], limit = 6): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const a of row.attempts) {
      if (!a.ok) {
        const key = `${a.provider} ${a.errorClass ?? "error"}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
