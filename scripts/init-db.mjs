// Create the lcr_calls table against whatever DATABASE_URL points at (any
// Postgres: Neon, Supabase, RDS, local…). Idempotent — safe to re-run.
import { Pool } from "pg";

const SCHEMA = `
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
  attempts      jsonb NOT NULL
);
ALTER TABLE lcr_calls ADD COLUMN IF NOT EXISTS ttft_ms integer;
CREATE INDEX IF NOT EXISTS lcr_calls_project_ts ON lcr_calls (project, ts DESC);
`;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (any Postgres: Neon, Supabase, RDS, local…).");
  process.exit(1);
}

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
try {
  await pool.query(SCHEMA);
  console.log("✓ lcr_calls table ready");
} catch (e) {
  console.error("failed to create table:", e.message);
  process.exit(1);
} finally {
  await pool.end();
}
