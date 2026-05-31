// Zero-friction storage: provision a db9 (https://db9.ai) database in seconds
// and create the table — so you don't have to stand up a Postgres yourself.
//
//   npm i get-db9      # one-time
//   npm run db:provision:db9
//
// Prints a DATABASE_URL line to paste into your env. db9 is plain Postgres, so
// the app then talks to it through the same driver as any other Postgres.
import { Pool } from "pg";
import { existsSync, readFileSync, appendFileSync } from "node:fs";

let getDb9;
try {
  getDb9 = await import("get-db9");
} catch {
  console.error("get-db9 is not installed. Run:  npm i get-db9");
  process.exit(1);
}

const name = process.env.DB9_NAME ?? "ai-lcr-dashboard";
const instantDatabase = getDb9.instantDatabase ?? getDb9.default?.instantDatabase;
if (!instantDatabase) {
  console.error("get-db9 has no instantDatabase export — check the installed version.");
  process.exit(1);
}

const result = await instantDatabase({ name });
// db9 returns the full connection string only on first creation.
const url =
  result?.connection_string_with_password ??
  result?.connectionString ??
  result?.connection_string ??
  result?.url;

if (!url) {
  console.log("Provisioned, but couldn't find a connection string on the result:");
  console.log(result);
  console.log("\nFetch it from your db9 dashboard, set DATABASE_URL, then run: npm run db:init");
  process.exit(0);
}

console.log(`\nDATABASE_URL=${url}\n`);

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lcr_calls (
      id text PRIMARY KEY, project text NOT NULL DEFAULT 'default',
      ts timestamptz NOT NULL DEFAULT now(), model text NOT NULL, winner text,
      ok boolean NOT NULL, failed_over boolean NOT NULL, latency_ms integer NOT NULL,
      input_tokens integer NOT NULL, output_tokens integer NOT NULL,
      cost_usd numeric(12,6) NOT NULL, baseline_usd numeric(12,6) NOT NULL DEFAULT 0,
      attempts jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lcr_calls_project_ts ON lcr_calls (project, ts DESC);
  `);
  console.log("✓ db9 database provisioned + lcr_calls table ready");

  // Convenience: drop it straight into .env.local for local dev (no copy-paste).
  const envFile = ".env.local";
  const already = existsSync(envFile) && /^DATABASE_URL=.+/m.test(readFileSync(envFile, "utf8"));
  if (already) {
    console.log("→ .env.local already has DATABASE_URL — left as-is.");
  } else {
    appendFileSync(envFile, `DATABASE_URL=${url}\n`);
    console.log("→ wrote DATABASE_URL to .env.local — `npm run dev` is ready.");
  }
  console.log("→ for deploys, set the DATABASE_URL above on your host (e.g. Vercel).");
} finally {
  await pool.end();
}
