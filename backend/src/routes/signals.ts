// Signal + Reaction routes.
//
// D4: protocol does not validate payload shape — accept any JSON.
// D5: every push (signal or reaction) writes one usage_log row (atomic).
// D3: no hit-rate / leaderboard; this module only stores + relays.
//
// SSE: GET /channels/:id/signals/stream — long-lived response, sends
// each new signal in this channel as a `data:` event. Clients reconnect
// with Last-Event-Id (signal_id, also the event id) to resume.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sql } from "../db.ts";
import { authedAddress, AuthError, consumeStreamToken } from "../auth.ts";
import { meter, InsufficientAllowanceError } from "../billing.ts";
import { isMember } from "../lib/governance.ts";
import { HttpError } from "./channels.ts";
import { check as rateCheck, RateLimitedError } from "../lib/rate_limit.ts";
import { recordEvent } from "../lib/events.ts";
import { buildAllowanceResponse } from "./billing.ts";

const APPROVE_AGAIN_URL = "https://susurration.xyz/approve?amount=100";

function insufficientAllowance(c: any, e: InsufficientAllowanceError) {
  return c.json({
    error: "insufficient_allowance",
    allowance_usd: e.allowance_usd,
    required_usd: e.required_usd,
    approve_again_url: APPROVE_AGAIN_URL,
  }, 402);
}

// BETA-1.b: anti-flood. Push at most 30/min/address (~1 every 2s sustained) —
// a real trader pushes a few signals per hour; bots get throttled fast.
const PUSH_PER_ADDR = { windowMs: 60_000, max: 30 };
const REACT_PER_ADDR = { windowMs: 60_000, max: 60 };

function rateLimited(c: any, e: RateLimitedError) {
  c.header("Retry-After", String(e.retryAfterSec));
  return c.json({ error: "rate_limited", retry_after_sec: e.retryAfterSec }, 429);
}

export const signalRoutes = new Hono();

// In-process pub/sub. One process per Fly machine in v0.1; if we scale to
// multiple machines later we'll swap to LISTEN/NOTIFY on Postgres.
type SignalEvent = {
  signal_id: string;
  channel_id: string;
  from_address: string;
  /** @handle of the sender if registered. Clients should prefer this for
   *  display — `from_address` is a backend identity primitive users
   *  shouldn't see in chat-like surfaces. */
  from_username: string | null;
  payload: unknown;
  created_at: string;
};
const subscribers = new Map<string, Set<(e: SignalEvent) => void>>();

/** Live SSE subscriber counts. /health uses this. */
export function sseStats(): { channels: number; subscribers: number } {
  let total = 0;
  for (const s of subscribers.values()) total += s.size;
  return { channels: subscribers.size, subscribers: total };
}

function publish(channelId: string, evt: SignalEvent) {
  const subs = subscribers.get(channelId);
  if (!subs) return;
  for (const fn of subs) {
    try { fn(evt); } catch { /* never let one slow consumer break others */ }
  }
}

function subscribe(channelId: string, fn: (e: SignalEvent) => void) {
  let subs = subscribers.get(channelId);
  if (!subs) {
    subs = new Set();
    subscribers.set(channelId, subs);
  }
  subs.add(fn);
  return () => {
    subs!.delete(fn);
    if (subs!.size === 0) subscribers.delete(channelId);
  };
}

async function withAuth(c: any) { return await authedAddress(c.req.header("authorization")); }
function authError(c: any, e: unknown) {
  if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
  throw e;
}

// POST /channels/:id/signals — push a signal. payload is any JSON.
signalRoutes.post("/channels/:id/signals", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const channelId = c.req.param("id");

  try { rateCheck(`push:${me}`, PUSH_PER_ADDR); }
  catch (e) { if (e instanceof RateLimitedError) return rateLimited(c, e); throw e; }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch (e) {
    // BETA-1.a: bodyLimit now throws HTTPException(413) which is handled by
    // app.onError. We still defend here in case the chunked-stream path raises
    // BodyLimitError directly (some Bun/Hono edge cases) — re-throw so onError
    // converts it to a clean 413 instead of a misleading 400.
    if ((e as Error).name === "BodyLimitError") throw e;
    return c.json({ error: "invalid json body" }, 400);
  }
  // payload is the entire body — wrapped or unwrapped doesn't matter, we store as-is.
  // Common pattern: client sends {payload: {...}} OR {...} directly. Accept both.
  const payload =
    typeof body === "object" && body !== null && "payload" in (body as any)
      ? (body as any).payload
      : body;

  try {
    const result = await sql.begin(async (tx) => {
      if (!(await isMember(tx, channelId, me))) throw new HttpError(403, "not a member");
      const insert = await tx<{ signal_id: string; created_at: Date }[]>`
        INSERT INTO signals(channel_id, from_address, payload)
        VALUES (${channelId}, ${me}, ${tx.json(payload as any)})
        RETURNING signal_id, created_at
      `;
      const row = insert[0]!;
      const meterOut = await meter({
        tx,
        address: me,
        channelId,
        signalId: row.signal_id,
        callType: "signal_push",
      });
      // Look up the sender's @handle so SSE / batch consumers can render
      // it directly. Cheap (single PK lookup); cached usernames hot-path.
      const u = await tx<{ username: string | null }[]>`
        SELECT username FROM identities WHERE address = ${me}
      `;
      const from_username = u[0]?.username ?? null;
      return {
        signal_id: row.signal_id,
        channel_id: channelId,
        from_address: me,
        from_username,
        payload,
        created_at: row.created_at.toISOString(),
        cost_usd: meterOut.cost_usd,
      };
    });

    publish(channelId, {
      signal_id: result.signal_id,
      channel_id: channelId,
      from_address: me,
      from_username: result.from_username,
      payload,
      created_at: result.created_at,
    });

    const allowance_after = await buildAllowanceResponse(me);
    recordEvent({ type: "signal_push", address: me, channelId });
    return c.json({ ...result, allowance_after }, 201);
  } catch (e) {
    if (e instanceof InsufficientAllowanceError) {
      recordEvent({ type: "charge_failed", address: me, channelId, payload: { reason: "insufficient_allowance" } });
      return insufficientAllowance(c, e);
    }
    if (e instanceof HttpError) return c.json({ error: e.reason }, e.status as 403 | 404);
    throw e;
  }
});

// GET /channels/:id/signals?since=ISO&limit=N — fetch signal log
signalRoutes.get("/channels/:id/signals", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const channelId = c.req.param("id");
  // R4: existence-then-membership.
  const exists = await sql`SELECT 1 FROM channels WHERE channel_id = ${channelId}`;
  if (exists.length === 0) return c.json({ error: "channel not found" }, 404);
  if (!(await isMember(sql, channelId, me))) return c.json({ error: "not a member" }, 403);

  const since = c.req.query("since");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);

  // JOIN identities so the CLI / agent can render @handle directly without
  // doing a second lookup. The address column stays for protocol clients
  // that care; UIs should prefer from_username and treat from_address as
  // a backend identifier.
  const rows = since
    ? await sql<any[]>`
        SELECT s.signal_id, s.channel_id, s.from_address,
               i.username AS from_username,
               s.payload, s.created_at
        FROM signals s
        LEFT JOIN identities i ON i.address = s.from_address
        WHERE s.channel_id = ${channelId} AND s.created_at > ${since}
        ORDER BY s.created_at ASC LIMIT ${limit}
      `
    : await sql<any[]>`
        SELECT s.signal_id, s.channel_id, s.from_address,
               i.username AS from_username,
               s.payload, s.created_at
        FROM signals s
        LEFT JOIN identities i ON i.address = s.from_address
        WHERE s.channel_id = ${channelId}
        ORDER BY s.created_at DESC LIMIT ${limit}
      `;
  return c.json({ signals: rows });
});

// GET /channels/:id/signals/stream — SSE
//
// R2: auth must NOT use the long-lived bearer in the query string (would leak
// to access logs). Two accepted modes:
//   - Authorization header (CLI/SDK)
//   - ?stream_token=... (single-use, 5-min TTL — POST /auth/stream-token mints)
signalRoutes.get("/channels/:id/signals/stream", async (c) => {
  let me: string;
  const headerAuth = c.req.header("authorization");
  const streamToken = c.req.query("stream_token");
  try {
    if (headerAuth) {
      me = await authedAddress(headerAuth);
    } else if (streamToken) {
      me = await consumeStreamToken(streamToken);
    } else {
      throw new AuthError(401, "missing auth (Authorization header or ?stream_token=)");
    }
  } catch (e) { return authError(c, e); }

  const channelId = c.req.param("id");
  if (!(await isMember(sql, channelId, me))) return c.json({ error: "not a member" }, 403);

  return streamSSE(c, async (stream) => {
    // R1 fix: track abort so the wait-for-event promise can be woken,
    // letting the loop's finally{} run (was leaking ~1 frame per disconnect).
    let aborted = false;
    let unsub = () => {};
    const queue: SignalEvent[] = [];
    let resolveWaiter: (() => void) | null = null;

    function wakeWaiter() {
      const r = resolveWaiter;
      resolveWaiter = null;
      r?.();
    }

    unsub = subscribe(channelId, (evt) => {
      queue.push(evt);
      wakeWaiter();
    });

    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {});
    }, 25_000);

    stream.onAbort(() => {
      aborted = true;
      clearInterval(heartbeat);
      unsub();
      wakeWaiter();
    });

    try {
      await stream.writeSSE({ event: "open", data: JSON.stringify({ channel_id: channelId }) });
      while (!aborted) {
        if (queue.length === 0) {
          // Wait until either an event arrives or onAbort fires; both wake us.
          await new Promise<void>((resolve) => { resolveWaiter = resolve; });
          if (aborted) break;
        }
        while (queue.length > 0 && !aborted) {
          const evt = queue.shift()!;
          await stream.writeSSE({
            id: evt.signal_id,
            event: "signal",
            data: JSON.stringify(evt),
          });
        }
      }
    } finally {
      aborted = true;
      clearInterval(heartbeat);
      unsub();
      // queue.length=0; the closure goes out of scope, GC reclaims everything.
    }
  });
});

// POST /signals/:id/reactions — react to a signal
signalRoutes.post("/signals/:id/reactions", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const signalId = c.req.param("id");

  try { rateCheck(`react:${me}`, REACT_PER_ADDR); }
  catch (e) { if (e instanceof RateLimitedError) return rateLimited(c, e); throw e; }

  let body: any;
  try { body = await c.req.json(); } catch (e) {
    // Same defense as the signal-push handler — see comment there.
    if ((e as Error).name === "BodyLimitError") throw e;
    return c.json({ error: "invalid json body" }, 400);
  }
  const payload = body && typeof body === "object" && "payload" in body ? body.payload : body;
  const isAuto = !!body?.is_auto;

  try {
    const result = await sql.begin(async (tx) => {
      const sigRows = await tx<{ channel_id: string }[]>`
        SELECT channel_id FROM signals WHERE signal_id = ${signalId}
      `;
      const sig = sigRows[0];
      if (!sig) throw new HttpError(404, "signal not found");
      if (!(await isMember(tx, sig.channel_id, me))) throw new HttpError(403, "not a member");

      const ins = await tx<{ reaction_id: string; created_at: Date }[]>`
        INSERT INTO reactions(signal_id, from_address, payload, is_auto)
        VALUES (${signalId}, ${me}, ${tx.json(payload as any)}, ${isAuto})
        RETURNING reaction_id, created_at
      `;
      const row = ins[0]!;
      const meterOut = await meter({
        tx,
        address: me,
        channelId: sig.channel_id,
        signalId,
        reactionId: row.reaction_id,
        callType: "reaction_push",
      });
      return {
        reaction_id: row.reaction_id,
        signal_id: signalId,
        channel_id: sig.channel_id,
        from_address: me,
        payload,
        is_auto: isAuto,
        created_at: row.created_at.toISOString(),
        cost_usd: meterOut.cost_usd,
      };
    });
    const allowance_after = await buildAllowanceResponse(me);
    recordEvent({ type: "reaction_push", address: me, channelId: result.channel_id, payload: { is_auto: isAuto } });
    return c.json({ ...result, allowance_after }, 201);
  } catch (e) {
    if (e instanceof InsufficientAllowanceError) {
      recordEvent({ type: "charge_failed", address: me, payload: { reason: "insufficient_allowance" } });
      return insufficientAllowance(c, e);
    }
    if (e instanceof HttpError) return c.json({ error: e.reason }, e.status as 403 | 404);
    throw e;
  }
});

// GET /signals/:id/reactions
signalRoutes.get("/signals/:id/reactions", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const signalId = c.req.param("id");

  const sigRows = await sql<{ channel_id: string }[]>`
    SELECT channel_id FROM signals WHERE signal_id = ${signalId}
  `;
  const sig = sigRows[0];
  if (!sig) return c.json({ error: "signal not found" }, 404);
  if (!(await isMember(sql, sig.channel_id, me))) return c.json({ error: "not a member" }, 403);

  const rows = await sql<any[]>`
    SELECT reaction_id, signal_id, from_address, payload, is_auto, created_at
    FROM reactions WHERE signal_id = ${signalId} ORDER BY created_at ASC
  `;
  return c.json({ reactions: rows });
});
