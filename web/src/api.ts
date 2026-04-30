// Web app API client. Same shape as cli/src/api.ts.
// Token persists in localStorage so the user doesn't re-sign every refresh.

const TOKEN_KEY = "susu.token";
const ADDRESS_KEY = "susu.address";

export const apiBase: string =
  (import.meta as any).env?.VITE_SUSU_API_URL ?? "/api";

export interface ApiCall<T = any> {
  method?: string;
  path: string;
  body?: unknown;
  auth?: boolean;
}

export class ApiError extends Error {
  constructor(public status: number, public body: any, public path: string) {
    super(`HTTP ${status} ${path}: ${typeof body === "object" ? JSON.stringify(body) : body}`);
  }
}

export async function api<T = any>(call: ApiCall<T>): Promise<T> {
  const url = apiBase.replace(/\/$/, "") + call.path;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (call.auth !== false) {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) headers.authorization = `Bearer ${t}`;
  }
  const resp = await fetch(url, {
    method: call.method ?? "GET",
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
  const ct = resp.headers.get("content-type") ?? "";
  const body: any = ct.includes("application/json") ? await resp.json() : await resp.text();
  if (!resp.ok) throw new ApiError(resp.status, body, call.path);
  return body as T;
}

export const session = {
  get token(): string | null { return localStorage.getItem(TOKEN_KEY); },
  get address(): string | null { return localStorage.getItem(ADDRESS_KEY); },
  set(token: string, address: string) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ADDRESS_KEY, address);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ADDRESS_KEY);
  },
};
