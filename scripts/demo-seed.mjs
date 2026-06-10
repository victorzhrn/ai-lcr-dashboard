// Seed a local Postgres with FICTIONAL demo data so the dashboard can be
// eyeballed (and screenshotted) without any real project's traffic. Covers the
// full 0.6 record surface: text with prompt-cache savings + TTFT, image/video
// with typed usage + official baselines, failovers (caught and leaked), and one
// deliberately drifted price-table route so the drift panel renders.
//
//   createdb lcr_demo
//   DATABASE_URL=postgres://localhost/lcr_demo node scripts/demo-seed.mjs
//   DATABASE_URL=postgres://localhost/lcr_demo npm run dev
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("set DATABASE_URL (e.g. postgres://localhost/lcr_demo)");
const pool = new pg.Pool({ connectionString: url, ssl: false });

// Schema mirrors lib/db.ts (kept inline so seeding never touches app code).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS lcr_calls (
  id text PRIMARY KEY, project text NOT NULL DEFAULT 'default', ts timestamptz NOT NULL DEFAULT now(),
  model text NOT NULL, winner text, ok boolean NOT NULL, failed_over boolean NOT NULL,
  latency_ms integer NOT NULL, ttft_ms integer, input_tokens integer NOT NULL, output_tokens integer NOT NULL,
  cost_usd numeric(12,6) NOT NULL, baseline_usd numeric(12,6) NOT NULL DEFAULT 0,
  cached_saving_usd numeric(12,6) NOT NULL DEFAULT 0, cached_input_tokens integer NOT NULL DEFAULT 0,
  attempts jsonb NOT NULL,
  modality text, media_usage jsonb, baseline_kind text, official_usd numeric(12,6), est_cost_usd numeric(12,6));
CREATE INDEX IF NOT EXISTS lcr_calls_project_ts ON lcr_calls (project, ts DESC);`;

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const ERRORS = ["502", "429", "timeout", "overloaded"];

// ── fictional fleet ───────────────────────────────────────────────────────────
// Three apps: a chat product (text-heavy, cache-heavy), an agent product
// (text, bursty), and a creative studio (image + video). All names invented.

const TEXT_MODELS = {
  // model → routes cheapest-first: [provider, $/call mean, baseline(last-leg) $/call, cacheable?]
  "gemini-3-flash": { routes: ["tokenmart", "openrouter"], cost: 0.0011, base: 0.0014, cache: 0.55, ttft: [350, 900] },
  "claude-sonnet-4.6": { routes: ["tokenmart", "openrouter"], cost: 0.021, base: 0.027, cache: 0.45, ttft: [600, 1600] },
  "deepseek-v4": { routes: ["deepinfra", "openrouter"], cost: 0.0004, base: 0.0011, cache: 0.6, ttft: [400, 1100] },
};
const IMAGE_MODELS = {
  "bfl/flux-schnell": { routes: ["runware", "fal"], cost: 0.0013, official: 0.003, kind: "priciest-route" },
  "google/nano-banana-2": { routes: ["kunavo", "runware"], cost: 0.054, official: 0.067, kind: "official" },
  "openai/gpt-image-2": { routes: ["runware", "kunavo"], cost: 0.094, official: 0.19, kind: "official" },
};
const VIDEO_MODELS = {
  "google/veo-3-lite": { routes: ["kunavo", "fal"], perClip: 0.16, official: 0.4, kind: "official", secs: [4, 8] },
  "bytedance/seedance-lite": { routes: ["fal"], perSec: 0.036, official: 0.062, kind: "official", secs: [5, 10] },
};

const PROJECTS = {
  "acme-chat": { kind: "text", perHour: 520, fo: 0.012, leak: 0.0008, models: ["gemini-3-flash", "claude-sonnet-4.6"] },
  "draftpilot": { kind: "text", perHour: 190, fo: 0.03, leak: 0, models: ["deepseek-v4", "gemini-3-flash"] },
  "pixelforge": { kind: "media", perHour: 26, fo: 0.05, leak: 0.002 },
};

const HOURS = 7 * 24; // a full 7d window (also fills 24h + Δ-vs-prev)
const rows = [];
let n = 0;
const push = (r) => rows.push({ id: `demo-${n++}`, ...r });

for (const [project, p] of Object.entries(PROJECTS)) {
  for (let h = 0; h < HOURS; h++) {
    // diurnal load + a visible mid-week bump so the chart has a story
    const day = Math.floor(h / 24);
    const diurnal = 0.55 + 0.45 * Math.sin(((h % 24) / 24) * Math.PI * 2 - 1.2);
    const bump = day === 3 ? 1.5 : 1;
    const calls = Math.max(0, Math.round((p.perHour * diurnal * bump) / 14)); // sampled down
    for (let i = 0; i < calls; i++) {
      const ts = new Date(Date.now() - (h + Math.random()) * 3600_000).toISOString();
      const failedOver = Math.random() < p.fo;
      const leaked = failedOver && Math.random() < p.leak / Math.max(p.fo, 1e-9);

      if (p.kind === "text") {
        const modelId = pick(p.models);
        const m = TEXT_MODELS[modelId];
        const [cheap, fallback] = m.routes;
        const winner = leaked ? null : failedOver ? fallback : cheap;
        const inputTok = Math.round(rnd(400, 6000));
        const cachedTok = Math.random() < m.cache ? Math.round(inputTok * rnd(0.5, 0.9)) : 0;
        const outputTok = Math.round(rnd(80, 1200));
        const cost = leaked ? 0 : m.cost * rnd(0.6, 1.5) * (winner === fallback ? m.base / m.cost : 1);
        const baseline = winner === fallback ? cost : m.base * rnd(0.6, 1.5) * (cost / (m.cost * 1.0));
        const cachedSaving = cachedTok > 0 ? cost * rnd(0.25, 0.6) : 0;
        const ttft = Math.round(rnd(...m.ttft));
        const latency = ttft + Math.round(outputTok / rnd(0.06, 0.12));
        const attempts = [];
        if (failedOver) attempts.push({ provider: `${modelId}@${cheap}`, ok: false, latencyMs: Math.round(rnd(150, 700)), errorClass: pick(ERRORS) });
        if (winner) attempts.push({ provider: `${modelId}@${winner}`, ok: true, latencyMs: latency });
        else attempts.push({ provider: `${modelId}@${fallback}`, ok: false, latencyMs: 400, errorClass: "503" });
        push({
          project, ts, model: modelId, winner: winner ? `${modelId}@${winner}` : null, ok: !leaked,
          failed_over: failedOver, latency_ms: latency + (failedOver ? 450 : 0), ttft_ms: leaked ? null : ttft,
          input_tokens: inputTok, output_tokens: leaked ? 0 : outputTok,
          cost_usd: cost, baseline_usd: leaked ? 0 : baseline, baseline_kind: leaked ? null : "last-leg",
          cached_saving_usd: cachedSaving, cached_input_tokens: cachedTok, attempts,
          modality: null, media_usage: null, official_usd: null, est_cost_usd: null,
        });
      } else {
        // media project: 75% image, 25% video
        const isVideo = Math.random() < 0.25;
        const [modelId, m] = pick(Object.entries(isVideo ? VIDEO_MODELS : IMAGE_MODELS));
        const [cheap, fallback] = m.routes;
        const winner = leaked ? null : failedOver && fallback ? fallback : cheap;
        const secs = isVideo ? Math.round(rnd(...m.secs)) : undefined;
        let cost = isVideo ? (m.perClip ?? m.perSec * secs) : m.cost;
        cost *= rnd(0.95, 1.05);
        // one deliberately drifted route: gpt-image-2 actual bills ~2.1× the table
        const drifted = modelId === "openai/gpt-image-2";
        const est = drifted ? cost / 2.1 : cost * rnd(0.97, 1.03);
        const official = (m.official ?? cost) * (isVideo && m.perSec ? secs : 1) * (isVideo && m.perClip ? rnd(0.95, 1.05) : 1);
        const latency = Math.round(isVideo ? rnd(45_000, 140_000) : rnd(1800, 30_000));
        const attempts = [];
        if (failedOver) attempts.push({ provider: cheap, ok: false, latencyMs: Math.round(rnd(800, 4000)), errorClass: pick(ERRORS) });
        if (winner) attempts.push({ provider: winner, ok: true, latencyMs: latency });
        else attempts.push({ provider: cheap, ok: false, latencyMs: 2500, errorClass: "504" });
        push({
          project, ts, model: modelId, winner, ok: !leaked, failed_over: failedOver,
          latency_ms: latency, ttft_ms: null, input_tokens: 0, output_tokens: 0,
          cost_usd: leaked ? 0 : cost, baseline_usd: leaked ? 0 : official,
          baseline_kind: leaked ? null : m.kind, cached_saving_usd: 0, cached_input_tokens: 0,
          attempts, modality: isVideo ? "video" : "image",
          media_usage: { outputs: 1, ...(secs ? { seconds: secs } : {}) },
          official_usd: m.kind === "official" && !leaked ? official : null,
          est_cost_usd: leaked ? null : est,
        });
      }
    }
  }
}

await pool.query(SCHEMA);
await pool.query("TRUNCATE lcr_calls");
const cols = "id, project, ts, model, winner, ok, failed_over, latency_ms, ttft_ms, input_tokens, output_tokens, cost_usd, baseline_usd, cached_saving_usd, cached_input_tokens, attempts, modality, media_usage, baseline_kind, official_usd, est_cost_usd";
for (let i = 0; i < rows.length; i += 500) {
  const batch = rows.slice(i, i + 500);
  const values = [];
  const params = [];
  batch.forEach((r, j) => {
    const base = j * 21;
    values.push(`(${Array.from({ length: 21 }, (_, k) => `$${base + k + 1}`).join(",")})`);
    params.push(
      r.id, r.project, r.ts, r.model, r.winner, r.ok, r.failed_over, r.latency_ms, r.ttft_ms,
      r.input_tokens, r.output_tokens, r.cost_usd.toFixed(6), r.baseline_usd.toFixed(6),
      r.cached_saving_usd.toFixed(6), r.cached_input_tokens, JSON.stringify(r.attempts),
      r.modality, r.media_usage ? JSON.stringify(r.media_usage) : null, r.baseline_kind,
      r.official_usd == null ? null : r.official_usd.toFixed(6), r.est_cost_usd == null ? null : r.est_cost_usd.toFixed(6),
    );
  });
  await pool.query(`INSERT INTO lcr_calls (${cols}) VALUES ${values.join(",")} ON CONFLICT (id) DO NOTHING`, params);
}
console.log(`seeded ${rows.length} demo calls across ${Object.keys(PROJECTS).length} fictional projects`);
await pool.end();
