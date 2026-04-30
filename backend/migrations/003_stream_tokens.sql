-- 003_stream_tokens — short-lived single-use tokens for SSE auth.
--
-- R2 fix: previously SSE auth was via /channels/:id/signals/stream?token=<bearer>
-- which leaked the long-lived bearer to access logs. Clients now POST to
-- /auth/stream-token to mint a single-use token (5min TTL), then connect SSE
-- with ?stream_token=... — even if logged, it expires immediately and only
-- grants SSE for one connection.

CREATE TABLE stream_tokens (
  token TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES identities(address),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stream_tokens_address_idx ON stream_tokens(address);

INSERT INTO schema_migrations(version) VALUES ('003_stream_tokens');
