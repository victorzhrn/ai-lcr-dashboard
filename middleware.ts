import { NextResponse, type NextRequest } from "next/server";

// Optional single-instance gate. If DASHBOARD_PASSWORD is set, the dashboard
// pages require HTTP Basic auth (any username, password = DASHBOARD_PASSWORD) —
// no login UI needed. The ingest endpoint is exempt (it has its own INGEST_KEY).
// Within one self-hosted instance, `project` is a filter, not a security
// boundary — the box belongs to the owner.
export const config = {
  matcher: ["/((?!api/ingest|_next/static|_next/image|favicon.ico).*)"],
};

export function middleware(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();

  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const pass = decoded.slice(decoded.indexOf(":") + 1);
      if (pass === password) return NextResponse.next();
    } catch {
      // fall through to challenge
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="ai-lcr-dashboard"' },
  });
}
