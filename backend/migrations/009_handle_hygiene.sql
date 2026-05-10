-- 009_handle_hygiene — IP registration cap + handle reclaim after inactivity.
--
-- 1. register_ips: log each registration's IP so we can enforce a daily cap
--    (prevents one person spinning up N wallets from the same IP to squat handles).
-- 2. last_active_at on identities: tracks most recent meaningful action
--    (signin / push / react). Handles inactive for 180+ days can be reclaimed.

CREATE TABLE IF NOT EXISTS register_ips (
  id SERIAL PRIMARY KEY,
  ip TEXT NOT NULL,
  address TEXT NOT NULL REFERENCES identities(address),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX register_ips_ip_created ON register_ips(ip, created_at);

ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

-- Backfill: set last_active_at = created_at for existing rows.
UPDATE identities SET last_active_at = created_at WHERE last_active_at IS NULL;

-- Now make it NOT NULL with a default for future rows.
ALTER TABLE identities ALTER COLUMN last_active_at SET NOT NULL;
ALTER TABLE identities ALTER COLUMN last_active_at SET DEFAULT now();

INSERT INTO schema_migrations(version) VALUES ('009_handle_hygiene');
