// Seller reputation v1 (Step 6).
//
// Public endpoint — no auth required.
// Aggregates over purchases (status='paid' only) and signals.
// No PnL, no hit-rate, no letter grades.

import { Hono } from "hono";
import { sql } from "../db.ts";

export const reputationRoutes = new Hono();

type ReputationRow = {
  signals_sold: string;
  total_revenue: string;
  currency: string;
  unique_buyers: string;
};

type RepeatBuyerRow = {
  repeat_buyers: string;
};

type SignalsPublishedRow = {
  signals_published: string;
};

reputationRoutes.get("/profiles/:handle/reputation", async (c) => {
  const rawHandle = c.req.param("handle");
  // Accept both '@alice001' and 'alice001' from callers.
  const handle = rawHandle.startsWith("@") ? rawHandle : `@${rawHandle}`;
  // username stored in identities has no '@' prefix.
  const username = handle.slice(1);

  // signals_published: count signals authored by this handle (via identities join).
  const [publishedRow] = await sql<SignalsPublishedRow[]>`
    SELECT COUNT(*)::text AS signals_published
    FROM signals s
    JOIN identities i ON i.address = s.from_address
    WHERE i.username = ${username}
  `;

  // Purchases aggregation: only status='paid' counts.
  // total_revenue: cast TEXT amount to numeric for SUM, then back to text.
  // currency: assumed consistent per seller; take MAX (deterministic over a single value).
  const [purchRow] = await sql<ReputationRow[]>`
    SELECT
      COUNT(DISTINCT signal_id)::text               AS signals_sold,
      COALESCE(SUM(amount::numeric), 0)::text       AS total_revenue,
      COALESCE(MAX(currency), 'USDC')               AS currency,
      COUNT(DISTINCT buyer_handle)::text            AS unique_buyers
    FROM purchases
    WHERE seller_handle = ${handle}
      AND status = 'paid'
  `;

  // repeat_buyers: buyers who have >=2 distinct paid purchases from this seller.
  // UNIQUE(signal_id, buyer_handle) means COUNT(*) per buyer == distinct signals bought.
  const [repeatRow] = await sql<RepeatBuyerRow[]>`
    SELECT COUNT(*)::text AS repeat_buyers
    FROM (
      SELECT buyer_handle
      FROM purchases
      WHERE seller_handle = ${handle}
        AND status = 'paid'
      GROUP BY buyer_handle
      HAVING COUNT(*) >= 2
    ) sub
  `;

  return c.json({
    handle,
    signals_published: Number(publishedRow?.signals_published ?? 0),
    signals_sold: Number(purchRow?.signals_sold ?? 0),
    total_revenue: purchRow?.total_revenue ?? "0",
    currency: purchRow?.currency ?? "USDC",
    unique_buyers: Number(purchRow?.unique_buyers ?? 0),
    repeat_buyers: Number(repeatRow?.repeat_buyers ?? 0),
  });
});
