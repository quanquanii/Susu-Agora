-- 012_demo_account — Reserve "demo" username as system.
-- Also clean up old "demo1" account: remove friend links, channels, and identity.

-- Reserve "demo" so nobody else can grab it via self-serve registration.
INSERT INTO reserved_usernames(username, category, reason)
VALUES ('demo', 'system', 'GS PRO demo signal source — server-managed account')
ON CONFLICT (username) DO NOTHING;

-- Clean up demo1: cascade-delete friend links → channels → signals.
-- friend_links FK → channels ON DELETE CASCADE handles the rest.
DELETE FROM friend_links
WHERE a IN (SELECT address FROM identities WHERE username = 'demo1')
   OR b IN (SELECT address FROM identities WHERE username = 'demo1');

-- Delete any channels created by demo1 that aren't covered by friend_links
DELETE FROM channels
WHERE created_by IN (SELECT address FROM identities WHERE username = 'demo1');

-- Delete the identity itself
DELETE FROM identities WHERE username = 'demo1';
