// Local CLI config — keypair + session token live in ~/.susu/config.json
// (mode 0600). API endpoint defaults to dev localhost; override with
// SUSU_API_URL env var or `susu config set api_url ...` later.

import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = process.env.SUSU_HOME ?? join(homedir(), ".susu");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface CliConfig {
  api_url: string;
  /** base58 ed25519 32-byte public key (= Solana address) */
  address?: string;
  /** base58 ed25519 64-byte secret key. NEVER log; never embed in errors. */
  secret_key_b58?: string;
  /** session bearer token from POST /auth/verify */
  token?: string;
  token_expires_at?: string;
  handle?: string;
}

const DEFAULTS: CliConfig = {
  // Backend mounts routes under /api so a single hostname can serve both
  // the web onboarding and the API behind one SSL cert (no subdomain CT leak).
  api_url: process.env.SUSU_API_URL ?? "http://localhost:8787/api",
};

export async function loadConfig(): Promise<CliConfig> {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  const raw = await readFile(CONFIG_PATH, "utf8");
  try {
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    throw new Error(`malformed config at ${CONFIG_PATH}`);
  }
}

export async function saveConfig(cfg: CliConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  await chmod(CONFIG_PATH, 0o600).catch(() => {}); // best-effort on Windows
}

export function configDir(): string { return CONFIG_DIR; }
