-- 002_billing_ledger — Solana USDC off-chain ledger.
--
-- ⚠ HISTORICAL — superseded by migration 004 (open protocol framework),
-- which drops `ledger_balances` and `wallet_deposits` and switches billing
-- to non-custodial SPL Approve. This file remains in place because applied
-- migrations are immutable; the architecture comment below describes the
-- ledger model that was active between migration 002 and migration 004 only.
--
-- Architecture (HISTORICAL — endpoints below no longer exist):
--   1. User sends USDC (SPL token) on Solana to the hot-wallet address.
--   2. User (or the CLI on their behalf) POSTs the resulting tx signature
--      to /billing/deposits.
--   3. Server fetches the tx via RPC, verifies:
--        - the SPL token transfer's destination ATA owner == hot wallet
--        - the transferred mint == configured USDC mint
--        - the transfer source ATA owner == the authed address
--      then atomically inserts wallet_deposits + bumps ledger_balances.
--   4. Every signal_push / reaction_push during BILLING_RATE_USD>0 atomically
--      decrements ledger_balances. Insufficient balance => 422 "insufficient_balance".
--
-- D6 transparency, not control: spend control lives in the user's agent layer;
-- here we only block at zero balance.

-- One row per address. balance_usd is exact NUMERIC; amounts are USD with
-- 8 decimals headroom (USDC has 6 decimals on-chain, we keep 8 for safety).
CREATE TABLE ledger_balances (
  address TEXT PRIMARY KEY REFERENCES identities(address),
  balance_usd NUMERIC(20,8) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_balance_nonneg CHECK (balance_usd >= 0)
);

-- Idempotent deposit ledger. tx_signature is the Solana tx sig — the
-- UNIQUE constraint makes "same signature posted twice" a no-op at DB level.
CREATE TABLE wallet_deposits (
  deposit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address TEXT NOT NULL REFERENCES identities(address),
  amount_usd NUMERIC(20,8) NOT NULL CHECK (amount_usd > 0),
  tx_signature TEXT NOT NULL UNIQUE,
  block_time TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'onchain' CHECK (source IN ('onchain','dev_credit')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wallet_deposits_address_idx ON wallet_deposits(address, created_at DESC);

INSERT INTO schema_migrations(version) VALUES ('002_billing_ledger');
