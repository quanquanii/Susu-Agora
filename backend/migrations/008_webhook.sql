-- Webhook: optional per-user URL for push-based signal delivery.
-- When set, the server POSTs signal events to this URL in addition to SSE.
-- webhook_secret is an HMAC key for X-Susu-Signature verification.

ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS webhook_url TEXT,
  ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

INSERT INTO schema_migrations(version) VALUES ('008_webhook');
