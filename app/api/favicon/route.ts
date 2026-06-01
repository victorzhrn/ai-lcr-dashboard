// Favicon proxy: the browser only ever talks to this dashboard. The server
// fetches the project's own /favicon.ico first (zero third-party), falls back to
// Google's normalizer, caches the bytes in-memory, and 404s when nothing is
// found so the client's monogram shows through. Keeps "data never leaves your
// box" honest — no client-side calls to Google with your project domains.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Hit = { body: ArrayBuffer; type: string; t: number } | { miss: true; t: number };
const cache = new Map<string, Hit>();
const TTL = 1000 * 60 * 60 * 24; // 24h

// Block obvious SSRF targets (private/loopback/no-dot hosts).
function blocked(host: string): boolean {
  return (
    !host.includes(".") ||
    /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|::1)/i.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

async function tryFetch(url: string): Promise<{ body: ArrayBuffer; type: string } | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3500), redirect: "follow" });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") || "image/x-icon";
    if (!/image|icon|octet-stream/i.test(type)) return null;
    const body = await r.arrayBuffer();
    return body.byteLength > 0 ? { body, type } : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const domain = (new URL(req.url).searchParams.get("domain") || "").toLowerCase().trim();
  if (!/^[a-z0-9.-]+$/.test(domain) || blocked(domain)) {
    return new Response(null, { status: 404 });
  }

  const cached = cache.get(domain);
  if (cached && Date.now() - cached.t < TTL) {
    if ("miss" in cached) return new Response(null, { status: 404 });
    return new Response(cached.body, {
      headers: { "content-type": cached.type, "cache-control": "public, max-age=86400, immutable" },
    });
  }

  const got =
    (await tryFetch(`https://${domain}/favicon.ico`)) ??
    (await tryFetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`));

  if (got) {
    cache.set(domain, { ...got, t: Date.now() });
    return new Response(got.body, {
      headers: { "content-type": got.type, "cache-control": "public, max-age=86400, immutable" },
    });
  }
  cache.set(domain, { miss: true, t: Date.now() });
  return new Response(null, { status: 404 });
}
