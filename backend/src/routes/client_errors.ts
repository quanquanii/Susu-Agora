import { Hono } from "hono";
import { authedAddress, AuthError } from "../auth.ts";
import { parseJsonBody, invalidJson } from "../lib/http.ts";
import { check as rateCheck, RateLimitedError } from "../lib/rate_limit.ts";
import { recordEvent } from "../lib/events.ts";

export const clientErrorRoutes = new Hono();

const ERROR_REPORT_LIMIT = { windowMs: 60_000, max: 10 };

// POST /client-errors — fire-and-forget error telemetry from CLI/daemon/MCP.
clientErrorRoutes.post("/client-errors", async (c) => {
  let address: string | null = null;
  try {
    address = await authedAddress(c.req.header("authorization"));
    rateCheck(`client-error:${address}`, ERROR_REPORT_LIMIT);
  } catch (e) {
    if (e instanceof RateLimitedError) return c.json({ ok: true }, 200);
    if (e instanceof AuthError) return c.json({ ok: true }, 200);
    return c.json({ ok: true }, 200);
  }

  const body = await parseJsonBody(c);
  if (body === null) return c.json({ ok: true }, 200);

  const source = String(body?.source ?? "unknown").slice(0, 20);
  const version = String(body?.version ?? "unknown").slice(0, 20);
  const error_type = String(body?.error_type ?? "unknown").slice(0, 100);
  const message = String(body?.message ?? "").slice(0, 500);
  const context = body?.context && typeof body.context === "object"
    ? Object.fromEntries(Object.entries(body.context as Record<string, unknown>).slice(0, 10).map(
        ([k, v]) => [k.slice(0, 50), String(v).slice(0, 200)]
      ))
    : {};

  recordEvent({
    type: "client_error",
    address,
    payload: { source, version, error_type, message, context },
  });

  return c.json({ ok: true });
});
