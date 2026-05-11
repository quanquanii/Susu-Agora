// Strip well-known credential shapes before logging or sending error reports.
// Belt-and-suspenders: client SDKs sometimes echo the API key back inside
// error.message (e.g. OpenAI 401 includes the prefix). We don't want any of
// that landing in our error pipeline.

const PATTERNS: Array<[RegExp, string]> = [
  // OpenAI / Anthropic / generic `sk-` style keys.
  // Real keys are 40+ chars; 20 is a safe lower bound that won't eat
  // ordinary strings like "sk-foo".
  [/sk-[A-Za-z0-9_\-]{20,}/g, "sk-***"],
  // Authorization: Bearer <token>
  [/Bearer\s+[A-Za-z0-9_.\-]+/gi, "Bearer ***"],
  // AWS access key id
  [/AKIA[A-Z0-9]{16}/g, "AWS_AKIA_***"],
  // Google API key
  [/AIza[0-9A-Za-z_\-]{35}/g, "AIza_***"],
  // GitHub personal access tokens
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, "gh_***"],
  // Slack tokens
  [/xox[baprs]-[A-Za-z0-9\-]{10,}/g, "xox_***"],
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const [pat, repl] of PATTERNS) out = out.replace(pat, repl);
  return out;
}

export function redactSecretsDeep<T>(v: T): T {
  if (v == null) return v;
  if (typeof v === "string") return redactSecrets(v) as unknown as T;
  if (Array.isArray(v)) return v.map(redactSecretsDeep) as unknown as T;
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      out[k] = redactSecretsDeep((v as Record<string, unknown>)[k]);
    }
    return out as unknown as T;
  }
  return v;
}
