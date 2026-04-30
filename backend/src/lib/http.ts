// Tiny HTTP helpers shared across routes.

import type { Context } from "hono";

/** Y2 fix: parse JSON body or return null. Callers should check for null and
 *  return 400 invalid_json. Previously routes silently coerced parse failures
 *  to {} which produced misleading downstream "invalid solana address" errors
 *  when the actual cause was a malformed body.
 */
export async function parseJsonBody(c: Context): Promise<any> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function invalidJson(c: Context) {
  return c.json({ error: "invalid_json" }, 400);
}

/** Y5 fix: small helper so client-side URL building doesn't drift across
 *  CLI / SDK / web / bridge. base may end in '/'; path always starts with '/'.
 *  Used by SDK-ts and shared as reference for other clients.
 */
export function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, "") + (path.startsWith("/") ? path : "/" + path);
}
