import { Hono } from "hono";
import { sql } from "../db.ts";
import {
  issueNonce, verifySignatureAndIssueSession, authedAddress, AuthError,
  issueStreamToken,
} from "../auth.ts";
import { parseJsonBody, invalidJson } from "../lib/http.ts";
import { check as rateCheck, RateLimitedError } from "../lib/rate_limit.ts";
import { recordEvent } from "../lib/events.ts";
import { generateWebhookSecret } from "../lib/webhook.ts";

export const identityRoutes = new Hono();

// BETA-1.b: bot guard — same address can request a nonce 10x/min, same IP 30x/min.
// Tighter than business endpoints because /auth/nonce is the open registration door.
const NONCE_PER_ADDR = { windowMs: 60_000, max: 10 };
const NONCE_PER_IP = { windowMs: 60_000, max: 30 };
const REGISTER_PER_IP = { windowMs: 60_000, max: 5 };
const VERIFY_PER_IP = { windowMs: 60_000, max: 10 };

function clientIp(c: any): string {
  // Trust Fly's edge-set header in prod; fall back to nothing in dev.
  return c.req.header("fly-client-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

identityRoutes.post("/auth/nonce", async (c) => {
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const address = String(body?.address ?? "");
  try {
    rateCheck(`nonce:addr:${address}`, NONCE_PER_ADDR);
    rateCheck(`nonce:ip:${clientIp(c)}`, NONCE_PER_IP);
    const out = await issueNonce(address);
    return c.json(out);
  } catch (e) {
    if (e instanceof RateLimitedError) {
      c.header("Retry-After", String(e.retryAfterSec));
      return c.json({ error: "rate_limited", retry_after_sec: e.retryAfterSec }, 429);
    }
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401 | 409);
    throw e;
  }
});

identityRoutes.post("/auth/verify", async (c) => {
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  try {
    rateCheck(`verify:ip:${clientIp(c)}`, VERIFY_PER_IP);
    const out = await verifySignatureAndIssueSession({
      address: String(body?.address ?? ""),
      nonce: String(body?.nonce ?? ""),
      signature_b58: String(body?.signature_b58 ?? ""),
      handle: body?.handle ? String(body.handle) : null,
    });
    return c.json(out);
  } catch (e) {
    if (e instanceof RateLimitedError) {
      c.header("Retry-After", String(e.retryAfterSec));
      return c.json({ error: "rate_limited", retry_after_sec: e.retryAfterSec }, 429);
    }
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401 | 409);
    throw e;
  }
});

// R2: clients that need SSE auth call this to mint a 5min single-use token.
// They pass it via ?stream_token=... — even if logged, it can't be replayed.
identityRoutes.post("/auth/stream-token", async (c) => {
  try {
    const address = await authedAddress(c.req.header("authorization"));
    const out = await issueStreamToken(address);
    return c.json(out);
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
});

identityRoutes.get("/identity/whoami", async (c) => {
  try {
    const address = await authedAddress(c.req.header("authorization"));
    const rows = await sql<{ address: string; handle: string | null; username: string | null; auto_accept_friends: boolean; created_at: Date }[]>`
      SELECT address, handle, username, auto_accept_friends, created_at
      FROM identities WHERE address = ${address}
    `;
    return c.json(rows[0] ?? { address, username: null });
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
});

// D13: username is permanent, immutable.
// 2026-04-30 reserved-username policy:
//   - Self-serve registration requires 5-20 chars (3-4 char "rare" names
//     are blocked from self-serve; admin grants them on a whitelist basis).
//   - Reserved table further blocks system / obscenity / specifically-locked
//     rare names. Rare names with `granted_to = caller` pass through.
//   - Validation happens in this order so error messages are precise.
const USERNAME_RE_SELF_SERVE = /^[a-z0-9_-]{5,20}$/;
const USERNAME_RE_DB_LIMIT = /^[a-z0-9_-]{3,20}$/;  // hard floor (matches DB CHECK)

identityRoutes.post("/identity/register", async (c) => {
  try {
    rateCheck(`register:ip:${clientIp(c)}`, REGISTER_PER_IP);
  } catch (e) {
    if (e instanceof RateLimitedError) {
      c.header("Retry-After", String(e.retryAfterSec));
      return c.json({ error: "rate_limited", retry_after_sec: e.retryAfterSec }, 429);
    }
    throw e;
  }
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const raw = String(body?.username ?? "").trim().toLowerCase();
  // Strip leading @ if user types "@alice"
  const username = raw.startsWith("@") ? raw.slice(1) : raw;

  // Format check — reject anything outside the DB-level limit immediately.
  if (!USERNAME_RE_DB_LIMIT.test(username)) {
    return c.json({
      error: "invalid_username",
      message: "username must be 3-20 chars, lowercase a-z 0-9 _ -",
    }, 400);
  }

  // Already-registered users can't change. CHECK constraint at DB layer too.
  const existing = await sql<{ username: string | null }[]>`
    SELECT username FROM identities WHERE address = ${me}
  `;
  if (existing[0]?.username) {
    return c.json({ error: "username_already_locked", current: existing[0].username }, 409);
  }

  // Reserved-username gate. Three categories enforced:
  //   - system / obscenity → hard reject (never grantable)
  //   - rare → reject UNLESS this caller is the granted recipient
  // (See migration 005 + admin route `/admin/usernames` for management.)
  const reserved = await sql<{ category: string; reason: string | null; granted_to: string | null }[]>`
    SELECT category, reason, granted_to FROM reserved_usernames WHERE username = ${username}
  `;
  if (reserved[0]) {
    const r = reserved[0];
    const grantedToMe = r.granted_to === me;
    if (!grantedToMe || r.category !== "rare") {
      return c.json({
        error: "username_reserved",
        category: r.category,
        message: r.reason ?? "this name is reserved",
      }, 409);
    }
    // grantedToMe && rare → fall through to claim
  } else {
    // Not enumerated in reserved_usernames. Apply the self-serve length floor:
    // 3-4 char names are implicitly "rare" — only reachable via admin grant
    // (which writes to identities.username directly, bypassing this route).
    if (!USERNAME_RE_SELF_SERVE.test(username)) {
      return c.json({
        error: "username_reserved",
        category: "rare",
        message: "names shorter than 5 characters are reserved; ask the operator to grant one",
      }, 409);
    }
  }

  // Atomic: claim username if it's not taken. UNIQUE constraint racing with
  // concurrent registrations is handled by 23505 → return 409 taken.
  try {
    await sql`
      UPDATE identities SET username = ${username} WHERE address = ${me}
    `;
  } catch (e: any) {
    if (e.code === "23505") {
      return c.json({ error: "username_taken", username }, 409);
    }
    throw e;
  }

  // BETA telemetry: register is the second funnel stage. Don't include the
  // username in the payload — it's PII (the whole point of `events` is to
  // be join-able by hashed address but not reverse-resolvable).
  recordEvent({ type: "register", address: me });

  return c.json({ address: me, username });
});

// Resolve @username → address (used by friends/add and CLI for short-handle UX).
identityRoutes.get("/identity/by-username/:username", async (c) => {
  // No auth required — usernames are public discovery.
  const raw = c.req.param("username") ?? "";
  const username = raw.startsWith("@") ? raw.slice(1) : raw;
  // Lookup uses the wider {3,20} format — 3-4 char rare names that admin
  // granted are valid handles even though self-serve registration won't reach them.
  if (!USERNAME_RE_DB_LIMIT.test(username)) {
    return c.json({ error: "invalid_username" }, 400);
  }
  const rows = await sql<{ address: string; username: string }[]>`
    SELECT address, username FROM identities WHERE username = ${username}
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "username_not_found", username }, 404);
  return c.json(row);
});

// POST /identity/auto-accept  body: {value: boolean}
// Toggle the friend-add gate. Default for new identities is FALSE
// (migration 006). When false, anyone calling /friends/add against this
// user creates a pending friend_request the user (or their agent) must
// explicitly accept via /friends/accept. When true, friend adds become
// channel-creating immediately. Users in active dogfood circles where
// they trust everyone may flip to true; default conservative.
identityRoutes.post("/identity/auto-accept", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const value = Boolean(body?.value ?? body?.on);
  await sql`UPDATE identities SET auto_accept_friends = ${value} WHERE address = ${me}`;
  return c.json({ ok: true, auto_accept_friends: value });
});

// ── Webhook management ─────────────────────────────────────────────────
// POST /identity/webhook  body: {url: string}
// Set a webhook URL. Server POSTs signal/reaction events to this URL.
// Generates a shared secret for HMAC signature verification.
identityRoutes.post("/identity/webhook", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const url = body?.url;
  if (typeof url !== "string" || !url.startsWith("https://")) {
    return c.json({ error: "webhook_url must be an https:// URL" }, 400);
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.)/.test(host) ||
      host === "[::1]"
    ) {
      return c.json({ error: "webhook_url must not point to a private/internal address" }, 400);
    }
  } catch {
    return c.json({ error: "webhook_url is not a valid URL" }, 400);
  }
  const secret = generateWebhookSecret();
  await sql`
    UPDATE identities SET webhook_url = ${url}, webhook_secret = ${secret}
    WHERE address = ${me}
  `;
  return c.json({ ok: true, webhook_url: url, webhook_secret: secret });
});

// GET /identity/webhook
identityRoutes.get("/identity/webhook", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
  const rows = await sql<{ webhook_url: string | null; webhook_secret: string | null }[]>`
    SELECT webhook_url, webhook_secret FROM identities WHERE address = ${me}
  `;
  const row = rows[0];
  return c.json({
    webhook_url: row?.webhook_url ?? null,
    webhook_secret: row?.webhook_secret ?? null,
  });
});

// DELETE /identity/webhook
identityRoutes.delete("/identity/webhook", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
  await sql`
    UPDATE identities SET webhook_url = NULL, webhook_secret = NULL
    WHERE address = ${me}
  `;
  return c.json({ ok: true });
});
