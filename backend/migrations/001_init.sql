-- Susurration MVP schema v0.1 (2026-04-28)
-- 9 tables matching Susurration-MVP工程量清单.md §核心数据模型

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Migration ledger
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1. 用户身份 (Solana wallet)
CREATE TABLE identities (
  address TEXT PRIMARY KEY,                       -- Solana base58 wallet address
  handle TEXT UNIQUE,                             -- optional human-readable handle
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. 频道
CREATE TABLE channels (
  channel_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,                                      -- optional human-readable name
  created_by TEXT NOT NULL REFERENCES identities(address),
  -- D7: default no governance, owner is NULL until vote produces one.
  owner TEXT REFERENCES identities(address),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- last successful kick timestamp; used for D8 24h rate limit
  last_kick_at TIMESTAMPTZ
);
CREATE INDEX channels_created_by_idx ON channels(created_by);

-- 3. 频道成员
CREATE TABLE channel_members (
  channel_id UUID NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  address TEXT NOT NULL REFERENCES identities(address),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, address)
);
CREATE INDEX channel_members_address_idx ON channel_members(address);

-- 4. ban list (kick 后进入；D9 rejoin 投票通过后移除)
CREATE TABLE channel_ban_list (
  channel_id UUID NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  address TEXT NOT NULL REFERENCES identities(address),
  banned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  banned_by TEXT NOT NULL REFERENCES identities(address),
  PRIMARY KEY (channel_id, address)
);

-- 5. 信号
CREATE TABLE signals (
  signal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  from_address TEXT NOT NULL REFERENCES identities(address),
  payload JSONB NOT NULL,                         -- D4: protocol does not validate
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX signals_channel_created_idx ON signals(channel_id, created_at DESC);

-- 6. 反应
CREATE TABLE reactions (
  reaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID NOT NULL REFERENCES signals(signal_id) ON DELETE CASCADE,
  from_address TEXT NOT NULL REFERENCES identities(address),
  payload JSONB NOT NULL,
  is_auto BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reactions_signal_idx ON reactions(signal_id, created_at);

-- 7. governance 投票提案 (D8)
CREATE TABLE proposals (
  proposal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  proposal_type TEXT NOT NULL CHECK (proposal_type IN ('transfer_owner','rejoin')),
  initiated_by TEXT NOT NULL REFERENCES identities(address),
  candidate_address TEXT NOT NULL REFERENCES identities(address),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','passed','failed','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX proposals_channel_status_idx ON proposals(channel_id, status);

-- 8. 投票
CREATE TABLE votes (
  proposal_id UUID NOT NULL REFERENCES proposals(proposal_id) ON DELETE CASCADE,
  voter TEXT NOT NULL REFERENCES identities(address),
  vote BOOLEAN NOT NULL,
  voted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, voter)
);

-- 9. kick history (审计可见)
CREATE TABLE kick_history (
  kick_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  kicked_address TEXT NOT NULL REFERENCES identities(address),
  kicked_by TEXT NOT NULL REFERENCES identities(address),
  kicked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX kick_history_channel_idx ON kick_history(channel_id, kicked_at DESC);

-- 10. billing metered usage (D5 atomic rule)
-- Every "content-producing" event = 1 row. push and react both count.
-- silent skip = no row (free).
-- During dogfood (BILLING_RATE_USD=0), cost_usd = 0 but rows still written
-- to calibrate real-world per-user monthly interaction count.
CREATE TABLE usage_log (
  usage_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address TEXT NOT NULL REFERENCES identities(address),
  channel_id UUID REFERENCES channels(channel_id) ON DELETE SET NULL,
  signal_id UUID REFERENCES signals(signal_id) ON DELETE SET NULL,
  reaction_id UUID REFERENCES reactions(reaction_id) ON DELETE SET NULL,
  call_type TEXT NOT NULL CHECK (call_type IN ('signal_push','reaction_push')),
  cost_usd NUMERIC(20,8) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX usage_log_address_created_idx ON usage_log(address, created_at DESC);
CREATE INDEX usage_log_channel_idx ON usage_log(channel_id, created_at DESC);

-- Auth nonces (Solana sign-in challenge)
CREATE TABLE auth_nonces (
  nonce TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_nonces_address_idx ON auth_nonces(address);

-- Sessions (bearer tokens issued after sig verification)
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES identities(address),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_address_idx ON sessions(address);

INSERT INTO schema_migrations(version) VALUES ('001_init');
