-- 006_auto_accept_default_off — switch friend gate to opt-in (was opt-out).
--
-- Background: identities.auto_accept_friends was added in 004 with
-- DEFAULT true, so any new user implicitly accepted friend adds from any
-- @handle. Per sghy 2026-04-30 directive, the default is wrong: in agent-
-- to-agent messaging, "I accept" = "your agent is now allowed to push to
-- mine", which expands prompt-injection / social-engineering surface area.
-- Human should remain the gatekeeper for who connects, even when their
-- agent does the day-to-day work afterward.
--
-- This migration:
--   1. Flips the column default to FALSE for future inserts.
--   2. Bulk-flips ALL existing rows to FALSE. The only existing identities
--      at the time of this migration are: the founder's @sghy account, a
--      handful of e2e/G-test handles in prod, and any first-batch users
--      who registered under the old default. Founder explicitly wants to
--      gate (he runs the first dogfood circle). E2E handles don't matter.
--      First-batch users need to opt back in deliberately if they wanted
--      auto-accept; safer floor.
--
-- Rollback: ALTER ... SET DEFAULT TRUE + UPDATE = TRUE if needed.

ALTER TABLE identities ALTER COLUMN auto_accept_friends SET DEFAULT FALSE;

UPDATE identities SET auto_accept_friends = FALSE;

INSERT INTO schema_migrations(version) VALUES ('006_auto_accept_default_off');
