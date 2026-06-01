// Per-project display identity: a favicon (when we can resolve a domain) over a
// deterministic monogram fallback. The monogram always works — any project tag
// gets a stable colored initial with zero config.

// Domain resolution, in order:
//   1. the project tag is already a domain (contains a dot) → use as-is
//   2. an optional env map LCR_PROJECT_DOMAINS = {"freediagram":"freediagram.app",…}
//   3. otherwise undefined → monogram only
let DOMAIN_MAP: Record<string, string> | null = null;
function domainMap(): Record<string, string> {
  if (DOMAIN_MAP) return DOMAIN_MAP;
  try {
    DOMAIN_MAP = JSON.parse(process.env.LCR_PROJECT_DOMAINS || "{}");
  } catch {
    DOMAIN_MAP = {};
  }
  return DOMAIN_MAP!;
}

export function domainFor(project: string): string | undefined {
  if (/\.[a-z]{2,}$/i.test(project)) return project;
  return domainMap()[project];
}

// Stable color + initial from the project name (FNV-ish hash → hue).
export function monogram(project: string): { bg: string; initial: string } {
  let h = 2166136261;
  for (let i = 0; i < project.length; i++) {
    h ^= project.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  return { bg: `hsl(${hue} 48% 42%)`, initial: (project[0] ?? "?").toUpperCase() };
}
