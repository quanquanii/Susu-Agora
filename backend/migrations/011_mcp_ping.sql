ALTER TABLE identities ADD COLUMN IF NOT EXISTS last_mcp_ping_at TIMESTAMPTZ;

INSERT INTO schema_migrations (version) VALUES ('011_mcp_ping');
