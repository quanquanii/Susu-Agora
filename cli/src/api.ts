// Thin wrapper around fetch — adds auth header, surfaces server error bodies.

import type { CliConfig } from "./config.ts";

export class ApiError extends Error {
  constructor(public status: number, public body: any, public path: string) {
    super(`HTTP ${status} ${path}: ${typeof body === "object" ? JSON.stringify(body) : body}`);
  }
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
