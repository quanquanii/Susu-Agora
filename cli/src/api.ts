// Thin wrapper around fetch — adds auth header, surfaces server error bodies.

import type { CliConfig } from "./config.ts";
import { redactSecrets, redactSecretsDeep } from "../../shared/redact.ts";

// Bun bundles this at build time — resolved from package.json, no runtime env needed.
// @ts-ignore — Bun resolves JSON imports at bundle time
import pkg from "../package.json";
const CLI_VERSION: string = pkg.version ?? "unknown";

export class ApiError extends Error {
  constructor(public status: number, public body: any, public path: string) {
    super(`HTTP ${status} ${path}: ${typeof body === "object" ? JSON.stringify(body) : body}`);
  }
}

export function reportClientError(
  cfg: CliConfig,
  errorType: string,
  message: string,
  context?: Record<string, string>,
): void {
  const url = cfg.api_url.replace(/\/$/, "") + "/client-errors";
  void fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
    },
    body: JSON.stringify({
      source: "cli",
      version: CLI_VERSION,
      error_type: errorType,
      message: redactSecrets(message).slice(0, 500),
      context: context ? redactSecretsDeep(context) : context,
    }),
  }).catch(() => {});
}

export async function api<T = any>(
  cfg: CliConfig,
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const url = cfg.api_url.replace(/\/$/, "") + path;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.auth !== false && cfg.token) {
    headers.authorization = `Bearer ${cfg.token}`;
  }
  const resp = await fetch(url, { ...init, headers });
  const ct = resp.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await resp.json() : await resp.text();
  if (!resp.ok) throw new ApiError(resp.status, body, path);
  return body as T;
}
