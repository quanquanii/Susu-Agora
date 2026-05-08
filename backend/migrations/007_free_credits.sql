-- Free credits: each user gets $5.00 on registration.
-- meter() deducts from free_credits_usd first; when exhausted, falls through
-- to on-chain USDC charge via spender keypair.

ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS free_credits_usd NUMERIC(20,8) NOT NULL DEFAULT 5.00;

INSERT INTO schema_migrations(version) VALUES ('007_free_credits');
