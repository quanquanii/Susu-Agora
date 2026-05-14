-- 013_purchases — mock paid-signal purchase ledger (Step 3).
-- Stores paid-signal purchase records, but does NOT unlock private_payload yet.

CREATE TABLE IF NOT EXISTS purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID NOT NULL REFERENCES signals(signal_id) ON DELETE CASCADE,
  buyer_handle TEXT NOT NULL,
  seller_handle TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  tx_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (signal_id, buyer_handle)
);

CREATE INDEX IF NOT EXISTS purchases_buyer_created_idx
  ON purchases(buyer_handle, created_at DESC);

INSERT INTO schema_migrations(version) VALUES ('013_purchases');
