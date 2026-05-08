-- Free credits: each user gets $5.00 on registration.
-- meter() deducts from free_credits_usd first; when exhausted, falls through
-- to on-chain USDC charge via spender keypair.

ALTER TABLE identities
  ADD COLUMN free_credits_usd NUMERIC(20,8) NOT NULL DEFAULT 5.00;

-- Backfill existing users with $5.00 (they already got the default, but
-- this is explicit for clarity in migration history).
