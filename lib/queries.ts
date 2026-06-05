import { getPool } from "./db";

// Fixed window allowlist → inline interval literal from this map (never user
// input → no injection), so the window is a constant in the SQL.
export const WINDOWS = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
} as const;
export type WindowKey = keyof typeof WINDOWS;

// The window immediately before the current one, same length — for "Δ vs prev"
// on the stat tiles. Doubled interval as the far bound; the near bound is the
// current window's interval.
const WINDOWS_PREV = {
  "1h": "2 hours",
  "24h": "48 hours",
  "7d": "14 days",
  "30d": "60 days",
} as const;

// Bucket width (seconds) per window → ~12–30 buckets across the range. Used for
// the time-series chart, sparklines, and the state timeline. We bucket on
// epoch-floor (not date_trunc) so non-standard widths like 5min / 6h work.
const BUCKET_SECONDS: Record<WindowKey, number> = {
  "1h": 300, // 5 min  → 12
  "24h": 3600, // 1 hour → 24
  "7d": 21600, // 6 hour → 28
  "30d": 86400, // 1 day  → 30
};
const WINDOW_SECONDS: Record<WindowKey, number> = {
  "1h": 3600,
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
};

export function asWindow(v: string | undefined): WindowKey {
  return v && v in WINDOWS ? (v as WindowKey) : "24h";
}

// Build the WHERE tail for the two filter axes. project = "all" / provider = "all"
// (or undefined) → that axis is unconstrained. provider filters on who SERVED
// (the winner's provider), via PROVIDER_EXPR. Params are numbered in push order
// so callers can append `${clause}` after a paramless `since(win)`.
function scope(project: string, provider?: string): { clause: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (project && project !== "all") {
    params.push(project);
    clauses.push(`project = $${params.length}`);
  }
  if (provider && provider !== "all") {
    params.push(provider);
    clauses.push(`${PROVIDER_EXPR} = $${params.length}`);
  }
  return { clause: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

function since(win: WindowKey): string {
  return `ts > now() - interval '${WINDOWS[win]}'`;
}
function sincePrev(win: WindowKey): string {
  return `ts > now() - interval '${WINDOWS_PREV[win]}' AND ts <= now() - interval '${WINDOWS[win]}'`;
}

// winner / attempts[].provider arrive as `concreteModel@provider` (e.g.
// gemini-2.5-flash-lite@tokenmart) or a bare provider (e.g. runware). Two
// distinct axes live in that one string:
//   provider = who served  → the failover / health axis (cheapest vendor, SLA)
//   model    = what ran     → the cost / usage axis (where the tokens & $ go)
const PROVIDER_EXPR = `CASE WHEN winner LIKE '%@%' THEN split_part(winner, '@', 2) ELSE coalesce(winner, '(failed)') END`;
const MODEL_EXPR = `CASE WHEN winner LIKE '%@%' THEN split_part(winner, '@', 1) ELSE coalesce(nullif(model, ''), winner, '(failed)') END`;

// JS equivalent of PROVIDER_EXPR for the attempts[].provider strings.
export function providerOf(route: string): string {
  const i = route.lastIndexOf("@");
  return i >= 0 ? route.slice(i + 1) : route;
}

// Shared time axis (epoch-second bucket starts) so the chart and the state
// timeline line up column-for-column.
function bucketAxis(win: WindowKey): number[] {
  const sec = BUCKET_SECONDS[win];
  const nowSec = Math.floor(Date.now() / 1000);
  const start = Math.floor((nowSec - WINDOW_SECONDS[win]) / sec) * sec;
  const axis: number[] = [];
  for (let t = start; t <= nowSec; t += sec) axis.push(t);
  return axis;
}

// Filter-pill lists: the full set of projects / providers seen in the window,
// independent of the active filter (so selecting one pill never hides the rest).
export async function getProjects(win: WindowKey): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT project, count(*)::int AS n FROM lcr_calls
      WHERE ${since(win)} GROUP BY project ORDER BY n DESC`,
  );
  return rows.map((r) => r.project as string);
}

export async function getProviders(win: WindowKey): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT ${PROVIDER_EXPR} AS provider, count(*)::int AS n FROM lcr_calls
      WHERE ${since(win)} GROUP BY ${PROVIDER_EXPR} ORDER BY n DESC`,
  );
  return rows.map((r) => r.provider as string).filter((p) => p && p !== "(failed)");
}

// ── stat row ──────────────────────────────────────────────────────────────

export interface Metrics {
  calls: number;
  failovers: number; // failed_over = true (had to try a fallback)
  caught: number; // failed_over AND ok = a hiccup absorbed, user unaffected
  failures: number; // NOT ok = every provider failed, leaked to the user
  failoverRate: number;
  costUsd: number;
  savedUsd: number; // routing saving: baseline (fallback leg) − cost on routed calls
  savePct: number;
  cachedSavingUsd: number; // prompt-cache discount the serving provider gave — NOT routing, shown apart
  cachedInputTokens: number; // input tokens read from cache (present even when no cacheRead rate → saving 0)
  cacheHitRate: number; // cachedInputTokens / inputTokens — share of input served from cache
  avgLatencyMs: number;
  // mean TTFT over streaming calls in the window; null when none carried one
  // (all non-streaming, or only pre-ttft data) — the UI shows "—", not a fake 0.
  ttftMs: number | null;
  tokens: number; // input + output, summed
  inputTokens: number;
  outputTokens: number;
}

export async function getMetrics(project: string, win: WindowKey, prev = false, provider?: string): Promise<Metrics> {
  const { clause, params } = scope(project, provider);
  const time = prev ? sincePrev(win) : since(win);
  const { rows } = await getPool().query(
    `SELECT
        count(*)::int                                  AS calls,
        count(*) FILTER (WHERE failed_over)::int        AS failovers,
        count(*) FILTER (WHERE failed_over AND ok)::int AS caught,
        count(*) FILTER (WHERE NOT ok)::int             AS failures,
        coalesce(sum(cost_usd), 0)::float8              AS cost_usd,
        coalesce(sum(baseline_usd) FILTER (WHERE baseline_usd > 0), 0)::float8 AS baseline_usd,
        coalesce(sum(cost_usd) FILTER (WHERE baseline_usd > 0), 0)::float8     AS cost_with_baseline,
        coalesce(sum(cached_saving_usd), 0)::float8     AS cached_saving,
        coalesce(sum(cached_input_tokens), 0)::bigint   AS cached_input_tokens,
        coalesce(avg(latency_ms), 0)::float8            AS avg_latency,
        avg(ttft_ms)::float8                            AS ttft_ms,
        coalesce(sum(input_tokens + output_tokens), 0)::bigint AS tokens,
        coalesce(sum(input_tokens), 0)::bigint          AS input_tokens,
        coalesce(sum(output_tokens), 0)::bigint         AS output_tokens
       FROM lcr_calls
      WHERE ${time}${clause}`,
    params,
  );
  const r = rows[0] ?? {};
  const calls = r.calls ?? 0;
  // Savings only counts calls that carry a baseline (baseline_usd > 0). ai-lcr
  // reports a baseline for media routing but not text, so unbaselined calls have
  // cost but no baseline — summing them in would drag net savings below zero and
  // hide real savings. SPENT (cost_usd) still counts every call.
  const savedUsd = Math.max(0, (r.baseline_usd ?? 0) - (r.cost_with_baseline ?? 0));
  return {
    calls,
    failovers: r.failovers ?? 0,
    caught: r.caught ?? 0,
    failures: r.failures ?? 0,
    failoverRate: calls > 0 ? (r.failovers ?? 0) / calls : 0,
    costUsd: r.cost_usd ?? 0,
    savedUsd,
    savePct: r.baseline_usd > 0 ? savedUsd / r.baseline_usd : 0,
    cachedSavingUsd: r.cached_saving ?? 0,
    cachedInputTokens: Number(r.cached_input_tokens ?? 0),
    cacheHitRate: r.input_tokens > 0 ? Number(r.cached_input_tokens ?? 0) / Number(r.input_tokens) : 0,
    avgLatencyMs: r.avg_latency ?? 0,
    ttftMs: r.ttft_ms == null ? null : Number(r.ttft_ms),
    tokens: Number(r.tokens ?? 0),
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
  };
}

// ── time series (chart + tile sparklines) ───────────────────────────────────

export interface Bucket {
  t: number; // bucket start, epoch seconds
  cost: number; // total spend (every call)
  baseline: number; // baseline of calls that carry one
  baseCost: number; // cost of those same baseline-bearing calls — so saved = max(0, baseline - baseCost)
  cachedSaving: number; // prompt-cache discount in this bucket (own series, own colour)
  calls: number;
}

export async function getTimeSeries(project: string, win: WindowKey, provider?: string): Promise<Bucket[]> {
  const sec = BUCKET_SECONDS[win];
  const { clause, params } = scope(project, provider);
  const { rows } = await getPool().query(
    `SELECT (floor(extract(epoch from ts) / ${sec}) * ${sec})::bigint AS bucket,
            coalesce(sum(cost_usd), 0)::float8     AS cost,
            coalesce(sum(baseline_usd) FILTER (WHERE baseline_usd > 0), 0)::float8 AS baseline,
            coalesce(sum(cost_usd) FILTER (WHERE baseline_usd > 0), 0)::float8     AS base_cost,
            coalesce(sum(cached_saving_usd), 0)::float8 AS cached_saving,
            count(*)::int                          AS calls
       FROM lcr_calls
      WHERE ${since(win)}${clause}
      GROUP BY bucket
      ORDER BY bucket`,
    params,
  );
  const by = new Map<number, { cost: number; baseline: number; baseCost: number; cachedSaving: number; calls: number }>();
  for (const r of rows)
    by.set(Number(r.bucket), { cost: r.cost, baseline: r.baseline, baseCost: r.base_cost, cachedSaving: r.cached_saving, calls: r.calls });
  return bucketAxis(win).map((t) => {
    const r = by.get(t);
    return { t, cost: r?.cost ?? 0, baseline: r?.baseline ?? 0, baseCost: r?.baseCost ?? 0, cachedSaving: r?.cachedSaving ?? 0, calls: r?.calls ?? 0 };
  });
}

// ── state timeline (per-project health over time) ───────────────────────────

export type ProjectStatus = "ok" | "warn" | "down";

// down: real failures slipping through · warn: elevated failover (degraded but
// recovering) · ok: healthy.
export function projectStatus(f: { failRate: number; failoverRate: number }): ProjectStatus {
  if (f.failRate > 0.005) return "down";
  if (f.failoverRate > 0.03) return "warn";
  return "ok";
}

export interface TimelineRow {
  project: string;
  calls: number;
  buckets: (ProjectStatus | "none")[]; // "none" = no traffic in that bucket
}

export async function getProjectTimeline(win: WindowKey, provider?: string): Promise<TimelineRow[]> {
  const sec = BUCKET_SECONDS[win];
  const { clause, params } = scope("all", provider);
  const { rows } = await getPool().query(
    `SELECT project,
            (floor(extract(epoch from ts) / ${sec}) * ${sec})::bigint AS bucket,
            count(*)::int                       AS calls,
            count(*) FILTER (WHERE NOT ok)::int AS failures,
            count(*) FILTER (WHERE failed_over)::int AS failovers
       FROM lcr_calls
      WHERE ${since(win)}${clause}
      GROUP BY project, bucket`,
    params,
  );
  const axis = bucketAxis(win);
  const byProject = new Map<string, Map<number, { calls: number; failures: number; failovers: number }>>();
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (!byProject.has(r.project)) byProject.set(r.project, new Map());
    byProject.get(r.project)!.set(Number(r.bucket), r);
    totals.set(r.project, (totals.get(r.project) ?? 0) + r.calls);
  }
  return [...byProject.entries()]
    .map(([project, m]): TimelineRow => ({
      project,
      calls: totals.get(project) ?? 0,
      buckets: axis.map((t) => {
        const r = m.get(t);
        if (!r || r.calls === 0) return "none";
        return projectStatus({ failRate: r.failures / r.calls, failoverRate: r.failovers / r.calls });
      }),
    }))
    .sort((a, b) => b.calls - a.calls);
}

// ── fleet table ─────────────────────────────────────────────────────────────

export interface FleetRow {
  project: string;
  calls: number;
  costUsd: number;
  savedUsd: number;
  savePct: number;
  failoverRate: number;
  failures: number; // leaked count (every provider failed)
  failRate: number;
  topProvider: string;
  topProviderPct: number;
}

export async function getFleet(win: WindowKey, provider?: string): Promise<FleetRow[]> {
  const pool = getPool();
  const { clause, params } = scope("all", provider); // project axis IS the breakdown; only provider filters
  const totals = await pool.query(
    `SELECT project,
            count(*)::int                            AS calls,
            count(*) FILTER (WHERE failed_over)::int AS failovers,
            count(*) FILTER (WHERE NOT ok)::int      AS failures,
            coalesce(sum(cost_usd), 0)::float8       AS cost_usd,
            coalesce(sum(baseline_usd) FILTER (WHERE baseline_usd > 0), 0)::float8 AS baseline_usd,
            coalesce(sum(cost_usd) FILTER (WHERE baseline_usd > 0), 0)::float8     AS cost_with_baseline
       FROM lcr_calls
      WHERE ${since(win)}${clause}
      GROUP BY project`,
    params,
  );
  const mix = await pool.query(
    `SELECT project, ${PROVIDER_EXPR} AS provider, count(*)::int AS calls
       FROM lcr_calls
      WHERE ${since(win)}${clause}
      GROUP BY project, ${PROVIDER_EXPR}`,
    params,
  );

  const top = new Map<string, { provider: string; calls: number }>();
  for (const m of mix.rows) {
    const cur = top.get(m.project);
    if (!cur || m.calls > cur.calls) top.set(m.project, { provider: m.provider, calls: m.calls });
  }

  return totals.rows
    .map((r): FleetRow => {
      const saved = Math.max(0, r.baseline_usd - r.cost_with_baseline);
      const t = top.get(r.project);
      return {
        project: r.project,
        calls: r.calls,
        costUsd: r.cost_usd,
        savedUsd: saved,
        savePct: r.baseline_usd > 0 ? saved / r.baseline_usd : 0,
        failoverRate: r.calls > 0 ? r.failovers / r.calls : 0,
        failures: r.failures,
        failRate: r.calls > 0 ? r.failures / r.calls : 0,
        topProvider: t?.provider ?? "—",
        topProviderPct: t && r.calls > 0 ? t.calls / r.calls : 0,
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

// ── provider table (project drill-down: who served / what it cost) ──────────

export interface ProviderStat {
  provider: string;
  calls: number;
  share: number;
  spentUsd: number; // total cost_usd across calls this provider served
  costPerCall: number;
  avgLatencyMs: number;
  savedUsd: number;
  cacheHitRate: number; // share of this provider's input tokens served from cache
  tokens: number; // input + output, summed over calls this provider served
}

export async function getProviderStats(project: string, win: WindowKey, provider?: string): Promise<ProviderStat[]> {
  const { clause, params } = scope(project, provider);
  const { rows } = await getPool().query(
    `SELECT ${PROVIDER_EXPR} AS provider,
            count(*)::int                       AS calls,
            coalesce(sum(cost_usd), 0)::float8     AS cost,
            coalesce(sum(baseline_usd) FILTER (WHERE baseline_usd > 0), 0)::float8 AS baseline,
            coalesce(sum(cost_usd) FILTER (WHERE baseline_usd > 0), 0)::float8     AS base_cost,
            coalesce(avg(latency_ms), 0)::float8   AS avg_latency,
            coalesce(sum(cached_input_tokens), 0)::bigint AS cached_input,
            coalesce(sum(input_tokens), 0)::bigint        AS input_toks,
            coalesce(sum(input_tokens + output_tokens), 0)::bigint AS tokens
       FROM lcr_calls
      WHERE ${since(win)}${clause}
      GROUP BY ${PROVIDER_EXPR}
      ORDER BY calls DESC`,
    params,
  );
  const total = rows.reduce((s, r) => s + r.calls, 0) || 1;
  return rows.map((r) => ({
    provider: r.provider,
    calls: r.calls,
    share: r.calls / total,
    spentUsd: r.cost,
    costPerCall: r.calls > 0 ? r.cost / r.calls : 0,
    avgLatencyMs: r.avg_latency,
    savedUsd: Math.max(0, r.baseline - r.base_cost),
    cacheHitRate: r.input_toks > 0 ? Number(r.cached_input ?? 0) / Number(r.input_toks) : 0,
    tokens: Number(r.tokens ?? 0),
  }));
}

// By-model usage / cost breakdown — the cost axis (a model doesn't have "health",
// the provider serving it does, so this is a table, not a timeline).
export interface ModelStat {
  model: string;
  calls: number;
  share: number;
  tokens: number;
  spentUsd: number; // total cost_usd across this model's calls — the budget view
  costPerCall: number;
  avgLatencyMs: number;
  // null when no call in the window carried a TTFT (all non-streaming, or only
  // pre-ttft data) — the UI shows "—" rather than a misleading 0.
  ttftMs: number | null;
  // Output throughput from the streaming calls that have a TTFT: output tokens
  // over generation time (latency − ttft). null when there's nothing to derive
  // it from. See the comment on the query for why we exclude TTFT from the time.
  tokensPerSec: number | null;
  savedUsd: number;
  cacheHitRate: number; // share of this model's input tokens served from prompt cache
}

export async function getModelStats(project: string, win: WindowKey, provider?: string): Promise<ModelStat[]> {
  const { clause, params } = scope(project, provider);
  const { rows } = await getPool().query(
    `SELECT ${MODEL_EXPR} AS model,
            count(*)::int                       AS calls,
            coalesce(sum(cost_usd), 0)::float8     AS cost,
            coalesce(sum(baseline_usd) FILTER (WHERE baseline_usd > 0), 0)::float8 AS baseline,
            coalesce(sum(cost_usd) FILTER (WHERE baseline_usd > 0), 0)::float8     AS base_cost,
            coalesce(avg(latency_ms), 0)::float8   AS avg_latency,
            -- avg() skips NULLs, so this is the mean over streaming calls only;
            -- NULL (→ "—" in the UI) when none of them carried a TTFT.
            avg(ttft_ms)::float8                   AS ttft_ms,
            -- Precise tokens/sec: total output tokens over total *generation*
            -- time (latency − ttft, the part after the first token), across the
            -- streaming calls that have a TTFT. Excluding TTFT from the time is
            -- what makes it a true decode-rate, not a startup-diluted one.
            -- latency_ms > ttft_ms guards a degenerate row; NULLIF guards /0.
            (sum(output_tokens) FILTER (WHERE ttft_ms IS NOT NULL AND latency_ms > ttft_ms))::float8
              / NULLIF(sum(latency_ms - ttft_ms) FILTER (WHERE ttft_ms IS NOT NULL AND latency_ms > ttft_ms), 0)
              * 1000                               AS tokens_per_sec,
            coalesce(sum(cached_input_tokens), 0)::bigint AS cached_input,
            coalesce(sum(input_tokens), 0)::bigint        AS input_toks,
            coalesce(sum(input_tokens + output_tokens), 0)::bigint AS tokens
       FROM lcr_calls
      WHERE ${since(win)}${clause}
      GROUP BY ${MODEL_EXPR}
      ORDER BY calls DESC`,
    params,
  );
  const total = rows.reduce((s, r) => s + r.calls, 0) || 1;
  return rows.map((r) => ({
    model: r.model,
    calls: r.calls,
    share: r.calls / total,
    tokens: Number(r.tokens ?? 0),
    spentUsd: r.cost,
    costPerCall: r.calls > 0 ? r.cost / r.calls : 0,
    avgLatencyMs: r.avg_latency,
    ttftMs: r.ttft_ms == null ? null : Number(r.ttft_ms),
    tokensPerSec: r.tokens_per_sec == null ? null : Number(r.tokens_per_sec),
    savedUsd: Math.max(0, r.baseline - r.base_cost),
    cacheHitRate: r.input_toks > 0 ? Number(r.cached_input ?? 0) / Number(r.input_toks) : 0,
  }));
}

// Per-provider health over time — the provider analog of getProjectTimeline.
// Computed in JS from `attempts` (every provider tried, not just the winner), so
// a flaky provider shows red even when we failed over away from it. Sampled to
// the most recent `sampleLimit` calls to bound cost (no jsonb unnest in SQL).
export interface ProviderHealthRow {
  provider: string;
  attempts: number;
  failRate: number;
  buckets: (ProjectStatus | "none")[];
}

export async function getProviderHealth(
  project: string,
  win: WindowKey,
  sampleLimit = 8000,
  provider?: string,
): Promise<ProviderHealthRow[]> {
  const sec = BUCKET_SECONDS[win];
  const { clause, params } = scope(project, provider);
  const { rows } = await getPool().query(
    `SELECT (floor(extract(epoch from ts) / ${sec}) * ${sec})::bigint AS bucket, attempts
       FROM lcr_calls
      WHERE ${since(win)}${clause}
      ORDER BY ts DESC
      LIMIT ${sampleLimit}`,
    params,
  );
  const axis = bucketAxis(win);
  const idx = new Map(axis.map((t, i) => [t, i]));
  const prov = new Map<string, { attempts: number; fails: number; b: { a: number; f: number }[] }>();
  for (const r of rows) {
    const bi = idx.get(Number(r.bucket));
    if (bi === undefined) continue;
    const attempts: { provider?: string; ok?: boolean }[] = Array.isArray(r.attempts) ? r.attempts : [];
    for (const a of attempts) {
      const name = providerOf(a.provider ?? "(unknown)");
      let p = prov.get(name);
      if (!p) {
        p = { attempts: 0, fails: 0, b: axis.map(() => ({ a: 0, f: 0 })) };
        prov.set(name, p);
      }
      p.attempts++;
      p.b[bi].a++;
      if (a.ok === false) {
        p.fails++;
        p.b[bi].f++;
      }
    }
  }
  return [...prov.entries()]
    .map(([provider, p]): ProviderHealthRow => ({
      provider,
      attempts: p.attempts,
      failRate: p.attempts ? p.fails / p.attempts : 0,
      buckets: p.b.map(({ a, f }) => {
        if (a === 0) return "none";
        const r = f / a;
        return r < 0.02 ? "ok" : r < 0.15 ? "warn" : "down";
      }),
    }))
    .sort((x, y) => y.attempts - x.attempts);
}

// ── failover events log ─────────────────────────────────────────────────────

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
  tokens: number; // input + output
  attempts: { provider: string; ok: boolean; latencyMs: number; errorClass?: string }[];
}

export async function getFailoverEvents(project: string, win: WindowKey, limit = 40, provider?: string): Promise<CallRow[]> {
  const { clause, params } = scope(project, provider);
  const { rows } = await getPool().query(
    `SELECT id, project, ts, model, winner, ok, failed_over, latency_ms,
            cost_usd::float8 AS cost_usd, (input_tokens + output_tokens)::int AS tokens, attempts
       FROM lcr_calls
      WHERE ${since(win)}${clause} AND failed_over
      ORDER BY ts DESC
      LIMIT ${limit}`,
    params,
  );
  return rows as CallRow[];
}
