import { NextResponse } from "next/server";
import { getPool, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Accepts one ai-lcr CallRecord (optionally tagged with `project`) and stores a
// row. Idempotent on `id` (client POSTs are fire-and-forget and may retry).
//
// Auth: if INGEST_KEY is set, require `Authorization: Bearer <INGEST_KEY>`.
// This is a write-only door — a leaked key lets someone write rows, not read
// them (the dashboard read path is gated separately).

type Attempt = { provider: string; ok: boolean; latencyMs: number; errorClass?: string };
type CallRecord = {
  id: string;
  project?: string;
  model: string;
  attempts: Attempt[];
  winner?: string;
  ok: boolean;
  failedOver: boolean;
  latencyMs: number;
  ttftMs?: number; // streaming only; absent on older ai-lcr, doGenerate, and failed calls
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  baselineUsd?: number;
  cachedSavingUsd?: number; // prompt-cache discount on this call; absent on older ai-lcr / no-cache calls
  cachedInputTokens?: number; // input tokens read from cache; present whenever the provider reports caching
  // ai-lcr 0.6 provenance (all optional — older clients simply omit them)
  modality?: string; // 'image' | 'video'; text records leave it unset
  usage?: { seconds?: number; outputs?: number; megapixels?: number };
  baselineKind?: string; // 'official' | 'priciest-route' | 'last-leg'
  officialUsd?: number; // official first-party price for this call's usage
  estCostUsd?: number; // price-table prediction; vs costUsd = drift on reported rows
};

function authorized(req: Request): boolean {
  const key = process.env.INGEST_KEY;
  if (!key) return true; // open ingest (e.g. local dev / trusted network)
  return req.headers.get("authorization") === `Bearer ${key}`;
}

function valid(r: unknown): r is CallRecord {
  const o = r as Partial<CallRecord> | null;
  return (
    !!o &&
    typeof o.id === "string" &&
    typeof o.model === "string" &&
    typeof o.ok === "boolean" &&
    Array.isArray(o.attempts)
  );
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!valid(body)) {
    return NextResponse.json({ error: "not a CallRecord" }, { status: 400 });
  }

  const r = body;
  try {
    await ensureSchema(); // first-deploy: create the table on demand, no manual migration
    const pool = getPool();
    await pool.query(
      `INSERT INTO lcr_calls
         (id, project, model, winner, ok, failed_over, latency_ms, ttft_ms, input_tokens, output_tokens, cost_usd, baseline_usd, cached_saving_usd, cached_input_tokens, attempts,
          modality, media_usage, baseline_kind, official_usd, est_cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (id) DO NOTHING`,
      [
        r.id,
        r.project ?? "default",
        r.model,
        r.winner ?? null,
        r.ok,
        r.failedOver ?? false,
        r.latencyMs ?? 0,
        // null (not 0) when absent — keeps "no TTFT" distinct from "0ms TTFT" so
        // averages skip these rows instead of being dragged toward zero.
        typeof r.ttftMs === "number" ? r.ttftMs : null,
        r.inputTokens ?? 0,
        r.outputTokens ?? 0,
        r.costUsd ?? 0,
        r.baselineUsd ?? 0,
        r.cachedSavingUsd ?? 0,
        r.cachedInputTokens ?? 0,
        JSON.stringify(r.attempts ?? []),
        // 0.6 provenance — null (not 0/"") when absent, so "unknown" never
        // masquerades as a real value (est_cost_usd 0 would read as "free").
        typeof r.modality === "string" ? r.modality : null,
        r.usage && typeof r.usage === "object" ? JSON.stringify(r.usage) : null,
        typeof r.baselineKind === "string" ? r.baselineKind : null,
        typeof r.officialUsd === "number" ? r.officialUsd : null,
        typeof r.estCostUsd === "number" ? r.estCostUsd : null,
      ],
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
