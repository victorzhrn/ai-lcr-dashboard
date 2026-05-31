import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

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
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  baselineUsd?: number;
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
    const pool = getPool();
    await pool.query(
      `INSERT INTO lcr_calls
         (id, project, model, winner, ok, failed_over, latency_ms, input_tokens, output_tokens, cost_usd, baseline_usd, attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [
        r.id,
        r.project ?? "default",
        r.model,
        r.winner ?? null,
        r.ok,
        r.failedOver ?? false,
        r.latencyMs ?? 0,
        r.inputTokens ?? 0,
        r.outputTokens ?? 0,
        r.costUsd ?? 0,
        r.baselineUsd ?? 0,
        JSON.stringify(r.attempts ?? []),
      ],
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
