-- 004_open_protocol_framework — D13 + D7 v0.6 + non-custodial + events instrumentation
-- 2026-04-29 batch: server scope shrinks to protocol primitives; non-custodial billing;
-- BETA event analytics. Single migration file because the steps are tightly coupled
-- (delete vote schema + add is_group + drop ledger + add events all in one tx).

-- ── 005a: drop server-enforced governance vote system + 24h kick cooldown ──
DROP TABLE IF EXISTS votes;
DROP TABLE IF EXISTS proposals;
ALTER TABLE channels DROP COLUMN IF EXISTS last_kick_at;
-- Keep kick_history as audit-only (append-only log of who kicked whom). Useful
-- for admin metrics + dispute trace. Not used by any active code path.

-- ── 005b: add channels.is_group ──
-- true = group channel (created via POST /channels, has owner concept)
-- false = 1-on-1 channel (created via POST /friends/add, no owner concept)
ALTER TABLE channels ADD COLUMN is_group BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX channels_created_by_is_group_idx ON channels(created_by, is_group);
-- Existing channels (BETA pre-batch) backfill = true (group). Correct, since
-- pre-batch there's no /friends/add path; all existing channels are groups.

-- ── 005c: add channels.meta JSONB free-form KV ──
-- Per-channel rule store. Server stores opaque blob; agent reads + composes.
-- Owner-only writes (PUT/PATCH); all members read.
ALTER TABLE channels ADD COLUMN meta JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── 005d: identities.username (immutable, permanent, format-validated) ──
-- 3-20 chars, [a-z0-9_-]. Lowercase only. Permanent — no UPDATE path.
ALTER TABLE identities ADD COLUMN username TEXT UNIQUE
  CHECK (username IS NULL OR username ~ '^[a-z0-9_-]{3,20}$');
ALTER TABLE identities ADD COLUMN auto_accept_friends BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX identities_username_idx ON identities(username) WHERE username IS NOT NULL;

-- ── 005e: friend_links — single-row symmetric friendship ──
-- CHECK (a < b) ensures one row per friendship in lex order. No (b, a) duplicate.
-- channel_id points to the backing 1-on-1 channel; cascade delete keeps it tidy.
CREATE TABLE friend_links (
  a TEXT NOT NULL REFERENCES identities(address),
  b TEXT NOT NULL REFERENCES identities(address),
  channel_id UUID NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (a < b),
  PRIMARY KEY (a, b)
);
CREATE INDEX friend_links_a_idx ON friend_links(a);
CREATE INDEX friend_links_b_idx ON friend_links(b);

-- A pending friend request (auto_accept=false target). Cleared when accepted or rejected.
CREATE TABLE friend_requests (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_addr TEXT NOT NULL REFERENCES identities(address),
  to_addr TEXT NOT NULL REFERENCES identities(address),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_addr <> to_addr),
  UNIQUE (from_addr, to_addr)
);
CREATE INDEX friend_requests_to_idx ON friend_requests(to_addr);

-- ── 005f: drop custodial billing tables; add non-custodial primitives ──
DROP TABLE IF EXISTS wallet_deposits;
DROP TABLE IF EXISTS ledger_balances;

-- Spender wallet rotation history. Current spender = row with rotated_out_at IS NULL.
-- 90-day rotation cron: insert new row, set rotated_out_at on old row.
CREATE TABLE spender_rotations (
  spender_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pubkey TEXT NOT NULL UNIQUE,
  rotated_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_out_at TIMESTAMPTZ,
  notes TEXT
);
CREATE INDEX spender_rotations_active_idx ON spender_rotations(rotated_out_at)
  WHERE rotated_out_at IS NULL;

-- Cache of last-known on-chain SPL token delegation (allowance) per user.
-- Refreshed lazily: on push attempt, on /allowance GET, on approve-success ACK.
-- Source of truth is on-chain; this table is just a memo.
CREATE TABLE approval_cache (
  address TEXT PRIMARY KEY REFERENCES identities(address),
  spender TEXT NOT NULL,
  allowance_usd NUMERIC(20,8) NOT NULL DEFAULT 0,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 005g: events table — analytics, distinct from usage_log (billing truth) ──
-- address stored as hash(address || salt) where salt = SUSU_EVENTS_HASH_SALT env.
-- admin can join same-user events but cannot reverse the hash to the address.
CREATE TABLE events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address_hash TEXT,                -- hash(address+salt); NULL if not user-bound
  event_type TEXT NOT NULL,
  channel_id UUID,                  -- nullable; weak link only (no FK to allow cascade flexibility)
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_address_created_idx ON events(address_hash, created_at DESC)
  WHERE address_hash IS NOT NULL;
CREATE INDEX events_type_created_idx ON events(event_type, created_at DESC);
CREATE INDEX events_channel_idx ON events(channel_id, created_at DESC)
  WHERE channel_id IS NOT NULL;

INSERT INTO schema_migrations(version) VALUES ('004_open_protocol_framework');
