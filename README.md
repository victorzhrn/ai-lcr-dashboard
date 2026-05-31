# ai-lcr-dashboard

A **self-hostable** dashboard for [ai-lcr](https://github.com/victorzhrn/ai-lcr) — see your LLM requests, **how much least-cost routing saved you**, and **whether your failovers are actually working**, across every provider you route to.

You run your own instance, so there's **no multi-tenant auth and the data never leaves your infrastructure**. The records carry **metadata only** — no prompts, no responses.

> Why this and not a generic LLM observability tool? Generic tools log calls. This one is built around the two things ai-lcr is for: **savings vs baseline** and **failover health** — the cross-provider view no single provider's dashboard can give you.

## What it shows

**Fleet overview** — one row per project: calls, spent, **saved**, save %, failover rate, top provider. Spot the project whose discount provider is flaky at a glance.

```
ai-lcr · fleet                                  [1h] [24h] [7d] [30d]
SAVED (vs baseline)   SPENT        CALLS        FAILOVER HEALTH
$42.18  ▼63%          $24.55       128.4k       2.1% · 2,690 caught
─────────────────────────────────────────────────────────────────────
PROJECT        CALLS   SPENT    SAVED   SAVE%  FAILOVER   TOP PROVIDER
freediagram    41.2k   $7.10   $13.40   65%    1.8%       tokenmart 94%
freecodegen    28.9k   $6.02   $11.88   66%    3.0%       tokenmart 88%
mymap           8.2k   $1.40    $1.20   46%    4.1% ⚠     openrouter 60%
```

**Project detail** — provider mix (who served), top failover reasons, where the savings come from (model @ provider), and a live failover feed:

```
✓ diagram  tokenmart                       412ms  $0.0003
⚠ diagram  tokenmart→openrouter            910ms  $0.0004  ⤷ tokenmart 502
✗ diagram  tokenmart→openrouter→deepseek   1.2s   FAILED   ⤷ 502, 429, 401
```

## Deploy

It's a small Next.js + Postgres app — deploy anywhere Next runs. Vercel is one click:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/victorzhrn/ai-lcr-dashboard&env=DATABASE_URL,INGEST_KEY,DASHBOARD_PASSWORD)

1. **Create the project** — click the button above (or import the repo in Vercel, or `npm run build && npm start` on any host).
2. **Attach a Postgres → set `DATABASE_URL`.** Any Postgres works: [Neon](https://neon.tech), [Supabase](https://supabase.com), RDS, your own, or a [db9](https://db9.ai) instant database. Put the connection string in the project's `DATABASE_URL` env var.
   - No database yet? Fastest path: `npm i get-db9 && npm run db:provision:db9` provisions a db9 one and prints the `DATABASE_URL` to paste in.
3. **Set the doors (optional but recommended for a public URL):**
   - `INGEST_KEY` — require `Authorization: Bearer <key>` to write (`POST /api/ingest`).
   - `DASHBOARD_PASSWORD` — HTTP Basic to view the dashboard (any username + this password).
4. **That's it — the table auto-creates** on the first request (ingest or page load). No migration step.
5. **Point your apps at it** (next section).

> **Local dev:** `cp .env.example .env.local`, set `DATABASE_URL`, `npm run dev`. (`npm run db:init` creates the table eagerly if you want; otherwise it's created on first use.)

## Send it data

From each app, wire ai-lcr's `onCall` to this dashboard with the built-in sink:

```ts
import { createLCR, createHttpSink } from "ai-lcr";
import { after } from "next/server"; // serverless: don't block the response

const lcr = createLCR({
  models: { /* … */ },
  onCall: createHttpSink({
    url: `${process.env.LCR_INGEST_URL}/api/ingest`,   // this dashboard's origin
    headers: { authorization: `Bearer ${process.env.LCR_INGEST_KEY}` }, // = the dashboard's INGEST_KEY
    project: process.env.LCR_PROJECT,  // tag per app → one row per project in the fleet view
    dispatch: after,
  }),
});
```

Each app sets `LCR_INGEST_URL` (this deploy's URL), `LCR_INGEST_KEY` (matches the dashboard's `INGEST_KEY`), and `LCR_PROJECT` (the project name). Open the dashboard and the project shows up.

## Environment

| Var | Required | What |
|-----|----------|------|
| `DATABASE_URL` | yes | Any Postgres, or a db9 connection string. |
| `INGEST_KEY` | no | **Write door.** If set, `POST /api/ingest` requires `Authorization: Bearer <key>`. A leaked write key can write rows, not read them. |
| `DASHBOARD_PASSWORD` | no | **Read door.** If set, viewing the dashboard requires HTTP Basic auth (any username, this password). Leave empty for an open single-user box. |

## How it's wired

```
your app ──onCall(CallRecord)──▶ createHttpSink ──POST──▶ /api/ingest ──▶ Postgres/db9 ──▶ /
                                  (fire-and-forget)        (write door)    lcr_calls       (read door)
```

- **Idempotent ingest:** rows keyed by `CallRecord.id`, so fire-and-forget retries don't duplicate.
- **Within one instance, `project` is a filter, not a security boundary** — the box is yours. Multi-user isolation only matters if you turn this into a shared service; this repo deliberately doesn't.
- **db9 SQL note:** aggregation uses `GROUP BY` + `count(*) FILTER (...)` and inline interval literals (db9 rejects `WITHIN GROUP` and parameterized `::interval` casts).

## License

MIT
