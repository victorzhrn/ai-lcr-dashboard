import { Pool } from "pg";

// Any Postgres works via DATABASE_URL (Neon, Supabase, RDS, local, …).
// Reuse one pool across hot-reloads / serverless invocations.
declare global {
  // eslint-disable-next-line no-var
  var __lcrPool: Pool | undefined;
}

// Hosted Postgres (Neon/Supabase/RDS) needs TLS; a local/internal one usually
// has none and errors if we force ssl. Skip ssl for localhost; relax CA checks
// otherwise. Override with PGSSLMODE=disable / require if you need to.
function sslFor(url: string): false | { rejectUnauthorized: boolean } {
  if (process.env.PGSSLMODE === "disable") return false;
  if (process.env.PGSSLMODE === "require") return { rejectUnauthorized: false };
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(url) || url.includes("@/");
  return isLocal ? false : { rejectUnauthorized: false };
}

export function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (any Postgres: Neon, Supabase, RDS, local…)");
  }
  if (!globalThis.__lcrPool) {
    globalThis.__lcrPool = new Pool({
      connectionString,
      ssl: sslFor(connectionString),
      max: 3,
      idleTimeoutMillis: 10_000,
      // Fail fast if the database is unreachable instead of hanging ~16s per
      // request before the page falls back to the setup notice.
      connectionTimeoutMillis: 8_000,
    });
  }
  return globalThis.__lcrPool;
}

// Ensure the table exists — runs once per process (memoized), so a fresh deploy
// just needs DATABASE_URL: the schema is created on the first ingest, no manual
// migration step. CREATE TABLE IF NOT EXISTS is idempotent and cheap.
let schemaReady: Promise<void> | undefined;
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(SCHEMA_SQL)
      .then(() => undefined)
      .catch((e) => {
        schemaReady = undefined; // let the next request retry
        throw e;
      });
  }
  return schemaReady;
}

// One table, no content — metadata only. Idempotent; safe to run repeatedly.
//
// ttft_ms is NULLABLE on purpose — it's the forward/backward-compat seam: rows
// written before this column existed stay NULL, and even going forward only
// streaming calls carry a time-to-first-token (doGenerate and failed calls have
// none). The ALTER backfills the column onto already-deployed tables, so an
// existing dashboard picks it up on the next request without a manual migration.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lcr_calls (
  id            text PRIMARY KEY,
  project       text NOT NULL DEFAULT 'default',
  ts            timestamptz NOT NULL DEFAULT now(),
  model         text NOT NULL,
  winner        text,
  ok            boolean NOT NULL,
  failed_over   boolean NOT NULL,
  latency_ms    integer NOT NULL,
  ttft_ms       integer,
  input_tokens  integer NOT NULL,
  output_tokens integer NOT NULL,
  cost_usd      numeric(12,6) NOT NULL,
  baseline_usd  numeric(12,6) NOT NULL DEFAULT 0,
  cached_saving_usd numeric(12,6) NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  attempts      jsonb NOT NULL
);
ALTER TABLE lcr_calls ADD COLUMN IF NOT EXISTS ttft_ms integer;
-- cached_saving_usd: prompt-cache discount the serving provider gave (input −
-- cacheRead on cached tokens). Reported separately from baseline_usd because
-- caching is the provider's own benefit, not a routing saving. Older rows (and
-- non-streaming/failed calls) stay 0, so summing is always safe.
ALTER TABLE lcr_calls ADD COLUMN IF NOT EXISTS cached_saving_usd numeric(12,6) NOT NULL DEFAULT 0;
-- cached_input_tokens: input tokens the serving provider read from prompt cache
-- (ai-lcr's cachedInputTokens). Always present when the provider reports caching
-- — independent of pricing — so it powers a cache HIT-RATE signal even on legs
-- with no cacheRead rate (where cached_saving_usd is 0). Older rows stay 0.
ALTER TABLE lcr_calls ADD COLUMN IF NOT EXISTS cached_input_tokens integer NOT NULL DEFAULT 0;
-- ai-lcr 0.6 provenance fields. All NULLABLE on purpose — absence means "the
-- record predates 0.6 or isn't a media call", which queries must distinguish
-- from a real 0 (est_cost_usd = 0 would read as free; NULL reads as unknown).
--   modality:      'image' | 'video' (media records; text rows stay NULL)
--   media_usage:   typed usage behind the bill: { seconds?, outputs?, megapixels? }
--   baseline_kind: how baseline_usd was derived — 'official' (model maker's
--                  first-party price), 'priciest-route' (self-referential
--                  fallback), 'last-leg' (text router's fallback-leg price)
--   official_usd:  the official first-party price for this call's usage
--   est_cost_usd:  what the price table PREDICTED; on provider-reported rows,
--                  cost_usd vs est_cost_usd is the price-table drift signal
ALTER TABLE lcr_calls ADD COLUMN IF NOT EXISTS modality text;
ALTER TABLE lcr_calls ADD COLUMN IF NOT EXISTS media_usage jsonb;
ALTER TABLE lcr_calls ADD COLUMN IF NOT EXISTS baseline_kind text;
ALTER TABLE lcr_calls ADD COLUMN IF NOT EXISTS official_usd numeric(12,6);
ALTER TABLE lcr_calls ADD COLUMN IF NOT EXISTS est_cost_usd numeric(12,6);
CREATE INDEX IF NOT EXISTS lcr_calls_project_ts ON lcr_calls (project, ts DESC);
`;
