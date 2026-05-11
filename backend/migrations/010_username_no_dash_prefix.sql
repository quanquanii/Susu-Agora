-- 010: reject usernames starting with '-' (prevents CLI flag confusion like --yes, --llm-key).
-- Existing violating rows: clear their username so the handle returns to the pool.

UPDATE identities SET username = NULL WHERE username ~ '^-';

ALTER TABLE identities DROP CONSTRAINT IF EXISTS identities_username_check;
ALTER TABLE identities ADD CONSTRAINT identities_username_check
  CHECK (username IS NULL OR username ~ '^[a-z0-9][a-z0-9_-]{2,19}$');

INSERT INTO schema_migrations(version) VALUES ('010_username_no_dash_prefix');
