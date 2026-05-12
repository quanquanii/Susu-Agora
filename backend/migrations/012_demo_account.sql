-- 012_demo_account — Reserve "demo" username as system.
-- Also clean up old "demo1" account: remove all associated data.

-- Reserve "demo" so nobody else can grab it via self-serve registration.
INSERT INTO reserved_usernames(username, category, reason)
VALUES ('demo', 'system', 'GS PRO demo signal source — server-managed account')
ON CONFLICT (username) DO NOTHING;

-- Clean up demo1 in correct FK order:
-- 1. Delete reactions on signals in demo1's channels
DELETE FROM reactions WHERE signal_id IN (
  SELECT signal_id FROM signals WHERE channel_id IN (
    SELECT channel_id FROM channel_members
    WHERE address IN (SELECT address FROM identities WHERE username = 'demo1')
  )
);

-- 2. Delete usage_log referencing demo1
DELETE FROM usage_log
WHERE address IN (SELECT address FROM identities WHERE username = 'demo1');

-- 3. Delete signals in demo1's channels
DELETE FROM signals WHERE channel_id IN (
  SELECT channel_id FROM channel_members
  WHERE address IN (SELECT address FROM identities WHERE username = 'demo1')
);

-- 4. Delete friend_links
DELETE FROM friend_links
WHERE a IN (SELECT address FROM identities WHERE username = 'demo1')
   OR b IN (SELECT address FROM identities WHERE username = 'demo1');

-- 5. Delete channel_members
DELETE FROM channel_members
WHERE address IN (SELECT address FROM identities WHERE username = 'demo1');

-- 6. Delete channels that demo1 created (any remaining orphans)
DELETE FROM channels
WHERE channel_id NOT IN (SELECT DISTINCT channel_id FROM channel_members);

-- 7. Delete sessions
DELETE FROM sessions
WHERE address IN (SELECT address FROM identities WHERE username = 'demo1');

-- 8. Delete friend_requests
DELETE FROM friend_requests
WHERE from_addr IN (SELECT address FROM identities WHERE username = 'demo1')
   OR to_addr IN (SELECT address FROM identities WHERE username = 'demo1');

-- 9. Finally delete the identity
DELETE FROM identities WHERE username = 'demo1';
