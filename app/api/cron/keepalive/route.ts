import { NextResponse } from "next/server";
import { getPool, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// Keep-alive heartbeat. db9 reclaims *idle* databases, so a sparse-traffic
// dashboard can lose its database between visits (connections then refuse with
// ECONNREFUSED). A cheap query on a schedule keeps the instance warm so it is
// never idle long enough to be reclaimed — the same pattern the ai-lcr status
// site uses. Harmless on any Postgres; just a liveness touch.
//
// Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when
// CRON_SECRET is set; if it isn't, we allow the call (the query is a no-op).
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    await ensureSchema(); // also guarantees the table exists after a fresh DB
    await getPool().query("SELECT 1");
    return NextResponse.json({ ok: true, at: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
