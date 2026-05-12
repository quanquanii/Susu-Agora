-- 012_demo_account — Reserve "demo" username + clean up demo1.

INSERT INTO reserved_usernames(username, category, reason)
VALUES ('demo', 'system', 'GS PRO demo signal source — server-managed account')
ON CONFLICT (username) DO NOTHING;

-- Clean up demo1: delete all data referencing this address.
-- Use a CTE to capture the address once, then cascade through all FK tables.
DO $$
DECLARE
  demo1_addr TEXT;
  demo1_channels UUID[];
BEGIN
  SELECT address INTO demo1_addr FROM identities WHERE username = 'demo1';
  IF demo1_addr IS NULL THEN
    RAISE NOTICE 'demo1 not found, skipping cleanup';
    RETURN;
  END IF;

  -- Collect all channels demo1 is a member of
  SELECT array_agg(channel_id) INTO demo1_channels
  FROM channel_members WHERE address = demo1_addr;

  IF demo1_channels IS NOT NULL THEN
    -- Delete reactions on signals in those channels
    DELETE FROM reactions WHERE signal_id IN (
      SELECT signal_id FROM signals WHERE channel_id = ANY(demo1_channels)
    );
    -- Delete signals
    DELETE FROM signals WHERE channel_id = ANY(demo1_channels);
    -- Delete channel_members for those channels
    DELETE FROM channel_members WHERE channel_id = ANY(demo1_channels);
    -- Delete channels
    DELETE FROM channels WHERE channel_id = ANY(demo1_channels);
  END IF;

  -- Delete friend links
  DELETE FROM friend_links WHERE a = demo1_addr OR b = demo1_addr;
  -- Delete friend requests
  DELETE FROM friend_requests WHERE from_addr = demo1_addr OR to_addr = demo1_addr;
  -- Delete usage log
  DELETE FROM usage_log WHERE address = demo1_addr;
  -- Delete sessions
  DELETE FROM sessions WHERE address = demo1_addr;
  -- Delete stream tokens
  DELETE FROM stream_tokens WHERE address = demo1_addr;
  -- Delete register_ips
  DELETE FROM register_ips WHERE address = demo1_addr;
  -- Delete events (uses address_hash, but may also have direct ref)
  -- events table uses address_hash not address FK, so no FK issue
  -- Delete the identity
  DELETE FROM identities WHERE address = demo1_addr;

  RAISE NOTICE 'demo1 (%) cleaned up', demo1_addr;
END $$;
