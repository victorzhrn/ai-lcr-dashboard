// Per-provider display identity, mirroring lib/projects.ts: a favicon (when we
// can resolve the provider's domain) over the same deterministic monogram
// fallback, so a provider pill looks just like a project pill.
//
// Domain resolution, in order:
//   1. built-in map for the providers ai-lcr ships adapters for
//   2. an optional env map LCR_PROVIDER_DOMAINS = {"tokenmart":"tokenmart.ai",…}
//   3. the provider string is already a domain (contains a dot) → use as-is
//   4. otherwise undefined → monogram only
import { monogram } from "./projects";

export { monogram };

const BUILTIN: Record<string, string> = {
  openrouter: "openrouter.ai",
  deepinfra: "deepinfra.com",
  deepseek: "deepseek.com",
  tokenmart: "tokenmart.ai",
  runware: "runware.ai",
  fal: "fal.ai",
  anthropic: "anthropic.com",
  openai: "openai.com",
  google: "ai.google.dev",
};

let ENV_MAP: Record<string, string> | null = null;
function envMap(): Record<string, string> {
  if (ENV_MAP) return ENV_MAP;
  try {
    ENV_MAP = JSON.parse(process.env.LCR_PROVIDER_DOMAINS || "{}");
  } catch {
    ENV_MAP = {};
  }
  return ENV_MAP!;
}

export function providerDomainFor(provider: string): string | undefined {
  const p = provider.toLowerCase();
  return envMap()[p] ?? BUILTIN[p] ?? (/\.[a-z]{2,}$/i.test(provider) ? provider : undefined);
}
