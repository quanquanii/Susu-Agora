// Mock paid-signal purchases (Step 3).
//
// Scope:
//   - records a purchase row in Postgres
//   - enforces basic paid-signal validation + idempotency
//   - does NOT unlock private_payload yet; Step 4 will wire read-side access

import { Hono } from "hono";
import { sql } from "../db.ts";
import { authedAddress, AuthError } from "../auth.ts";
import { isMember } from "../lib/governance.ts";
import { parseJsonBody, invalidJson } from "../lib/http.ts";

export const purchaseRoutes = new Hono();

type PurchaseRow = {
  id: string;
  signal_id: string;
  buyer_handle: string;
  seller_handle: string;
  amount: string;
  currency: string;
  status: string;
  tx_hash: string;
  created_at: Date;
};

type SignalPurchaseSourceRow = {
  signal_id: string;
  channel_id: string;
  from_address: string;
  payload: unknown;
  seller_username: string | null;
};

function authError(c: any, e: unknown) {
  if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
  throw e;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatPurchase(row: PurchaseRow, alreadyPurchased: boolean) {
  return {
    id: row.id,
    signal_id: row.signal_id,
    buyer_handle: row.buyer_handle,
    seller_handle: row.seller_handle,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    tx_hash: row.tx_hash,
    created_at: row.created_at.toISOString(),
    already_purchased: alreadyPurchased,
  };
}

async function findPurchase(signalId: string, buyerHandle: string): Promise<PurchaseRow | null> {
  const rows = await sql<PurchaseRow[]>`
    SELECT id, signal_id, buyer_handle, seller_handle, amount, currency, status, tx_hash, created_at
    FROM purchases
    WHERE signal_id = ${signalId} AND buyer_handle = ${buyerHandle}
  `;
  return rows[0] ?? null;
}

purchaseRoutes.post("/purchases", async (c) => {
  let buyerAddress: string;
  try { buyerAddress = await authedAddress(c.req.header("authorization")); }
  catch (e) { return authError(c, e); }

  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);

  const signalId = asNonEmptyString(body?.signal_id);
  if (!signalId) {
    return c.json({ error: "invalid_signal_id", message: "signal_id is required" }, 400);
  }

  const buyerIdentity = await sql<{ username: string | null }[]>`
    SELECT username FROM identities WHERE address = ${buyerAddress}
  `;
  const buyerUsername = buyerIdentity[0]?.username ?? null;
  if (!buyerUsername) {
    return c.json({
      error: "buyer_handle_required",
      message: "buyer must register a handle before buying signals",
    }, 400);
  }

  const signalRows = await sql<SignalPurchaseSourceRow[]>`
    SELECT s.signal_id, s.channel_id, s.from_address, s.payload, i.username AS seller_username
    FROM signals s
    LEFT JOIN identities i ON i.address = s.from_address
    WHERE s.signal_id = ${signalId}
  `;
  const signal = signalRows[0];
  if (!signal) return c.json({ error: "signal_not_found", message: "signal not found" }, 404);
  if (!(await isMember(sql, signal.channel_id, buyerAddress))) {
    return c.json({ error: "not_a_member", message: "not a member of this signal channel" }, 403);
  }
  if (signal.from_address === buyerAddress) {
    return c.json({ error: "cannot_buy_own_signal", message: "cannot buy your own signal" }, 400);
  }
  if (!signal.seller_username) {
    return c.json({
      error: "seller_handle_missing",
      message: "signal seller must have a registered handle",
    }, 400);
  }

  const payload = isRecord(signal.payload) ? signal.payload : null;
  if (!payload || payload.locked !== true) {
    return c.json({
      error: "purchase_not_required",
      message: "signal is not locked; purchase not required",
    }, 400);
  }
  if (payload.unlock_policy !== "pay_to_reveal") {
    return c.json({
      error: "unsupported_unlock_policy",
      message: "unsupported unlock policy",
    }, 400);
  }

  const expiresAtRaw = payload.expires_at;
  if (expiresAtRaw !== undefined && expiresAtRaw !== null) {
    const expiresAt = asNonEmptyString(expiresAtRaw);
    if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) {
      return c.json({
        error: "invalid_paid_signal",
        message: "paid signal is missing a valid expires_at",
      }, 400);
    }
    if (Date.parse(expiresAt) <= Date.now()) {
      return c.json({ error: "signal_expired", message: "signal expired" }, 400);
    }
  }

  const amount = asNonEmptyString(payload.price);
  const currency = asNonEmptyString(payload.currency);
  if (!amount || !currency) {
    return c.json({
      error: "invalid_paid_signal",
      message: "paid signal is missing price or currency",
    }, 400);
  }

  const buyerHandle = `@${buyerUsername}`;
  const sellerHandle = `@${signal.seller_username}`;

  const existing = await findPurchase(signalId, buyerHandle);
  if (existing) return c.json(formatPurchase(existing, true));

  try {
    const created = await sql.begin(async (tx) => {
      const rows = await tx<PurchaseRow[]>`
        INSERT INTO purchases(signal_id, buyer_handle, seller_handle, amount, currency, status, tx_hash)
        VALUES (
          ${signalId},
          ${buyerHandle},
          ${sellerHandle},
          ${amount},
          ${currency},
          'paid',
          ${`mock_tx_${crypto.randomUUID()}`}
        )
        RETURNING id, signal_id, buyer_handle, seller_handle, amount, currency, status, tx_hash, created_at
      `;
      return rows[0]!;
    });
    return c.json(formatPurchase(created, false), 201);
  } catch (e: any) {
    if (e?.code === "23505") {
      const duplicate = await findPurchase(signalId, buyerHandle);
      if (duplicate) return c.json(formatPurchase(duplicate, true));
    }
    throw e;
  }
});
