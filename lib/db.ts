import { Pool } from "pg";

// Any Postgres works via DATABASE_URL. db9 (https://db9.ai) is plain Postgres
// over TLS — same driver, with instant/disposable provisioning if you don't
// want to stand a database up yourself (see scripts/provision-db9.mjs).
// Reuse one pool across hot-reloads / serverless invocations.
declare global {
  // eslint-disable-next-line no-var
  var __lcrPool: Pool | undefined;
}

export function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (any Postgres, or a db9 connection string)");
  }
  if (!globalThis.__lcrPool) {
    globalThis.__lcrPool = new Pool({
      connectionString,
      // db9 and most hosted Postgres use TLS without a locally-trusted CA.
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000,
    });
  }
  return globalThis.__lcrPool;
}

// One table, no content — metadata only. Idempotent; safe to run repeatedly.
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
  input_tokens  integer NOT NULL,
  output_tokens integer NOT NULL,
  cost_usd      numeric(12,6) NOT NULL,
  baseline_usd  numeric(12,6) NOT NULL DEFAULT 0,
  attempts      jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS lcr_calls_project_ts ON lcr_calls (project, ts DESC);
`;
