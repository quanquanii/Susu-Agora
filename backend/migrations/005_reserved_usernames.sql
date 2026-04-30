-- 005_reserved_usernames — Reserved username system.
--
-- Three categories enforced at username registration time:
--
--   `system`     — Susurration brand + URL slugs + classic platform words.
--                  Hard-blocked. Never grantable. Reason: name-collision with
--                  routes / platform identity / future feature paths.
--
--   `rare`       — Default-locked. Grantable to a specific address by admin
--                  (whitelist mechanism — sghy hands out short names to
--                  high-value users / dogfood operators). Recipient registers
--                  the name normally; the reserved row's granted_to gates it.
--                  3-4 character names are NOT enumerated here — they're
--                  blocked by the length check in register (USERNAME_RE = {5,20}),
--                  and admin grants bypass that check via direct UPDATE.
--
--   `obscenity`  — Hard-blocked profanity / hate / illegal-themed terms.
--                  Conservative baseline; admin can extend.
--
-- (We deliberately do NOT pre-reserve third-party brand names. Per GitHub /
-- X / WeChat-Official-Account practice, brand protection is claim-based:
-- trademark holders submit proof, then sghy adds them to `system` retroactively.)

CREATE TABLE reserved_usernames (
  username    TEXT PRIMARY KEY CHECK (username ~ '^[a-z0-9_-]{1,40}$'),
  category    TEXT NOT NULL CHECK (category IN ('system', 'rare', 'obscenity')),
  reason      TEXT,
  -- For `rare` only: address that's allowed to register this name.
  granted_to  TEXT REFERENCES identities(address) ON DELETE SET NULL,
  granted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Quick lookup of what's been granted to whom.
CREATE INDEX reserved_usernames_granted_to ON reserved_usernames(granted_to)
  WHERE granted_to IS NOT NULL;

-- ─── Seed: system category ─────────────────────────────────────────────
-- Susurration brand + variants. ANY use of these by a non-platform user
-- creates impersonation risk; per sghy 2026-04-30 directive, all
-- susurration-derived strings are absolutely off-limits.
INSERT INTO reserved_usernames(username, category, reason) VALUES
  ('susurration',  'system', 'platform brand'),
  ('susurrations', 'system', 'platform brand variant'),
  ('susurrate',    'system', 'platform brand variant'),
  ('susurrant',    'system', 'platform brand variant'),
  ('susurrated',   'system', 'platform brand variant'),
  ('susurrating',  'system', 'platform brand variant'),
  ('susurr',       'system', 'platform brand fragment'),
  ('susurra',      'system', 'platform brand fragment'),
  ('susu',         'system', 'platform brand short form'),
  ('whisper',      'system', 'platform tagline term'),
  ('whispers',     'system', 'platform tagline term'),
  ('whispered',    'system', 'platform tagline term'),
  ('whispering',   'system', 'platform tagline term');

-- Generic platform / system terms. Impersonation + URL-slug collision risk.
INSERT INTO reserved_usernames(username, category, reason) VALUES
  ('admin',         'system', 'reserved for system use'),
  ('administrator', 'system', 'reserved for system use'),
  ('root',          'system', 'reserved for system use'),
  ('system',        'system', 'reserved for system use'),
  ('official',      'system', 'reserved for verification badges'),
  ('verified',      'system', 'reserved for verification badges'),
  ('staff',         'system', 'reserved for platform team'),
  ('team',          'system', 'reserved for platform team'),
  ('moderator',     'system', 'reserved for platform team'),
  ('support',       'system', 'reserved for support contact'),
  ('help',          'system', 'reserved for support contact'),
  ('contact',       'system', 'reserved for support contact'),
  ('security',      'system', 'reserved for security contact'),
  ('abuse',         'system', 'reserved for abuse-report contact'),
  ('legal',         'system', 'reserved for legal contact'),
  ('press',         'system', 'reserved for press contact'),
  ('billing',       'system', 'reserved for billing contact'),
  ('noreply',       'system', 'reserved for system notifications'),
  ('notifications', 'system', 'reserved for system notifications');

-- URL-slug protection. Any path used by the web app or API needs the
-- corresponding username reserved so /@<name> never collides with /<route>.
INSERT INTO reserved_usernames(username, category, reason) VALUES
  ('docs',         'system', 'route reserved (/docs)'),
  ('doc',          'system', 'route reserved'),
  ('api',          'system', 'route reserved (/api)'),
  ('approve',      'system', 'route reserved (/approve)'),
  ('login',        'system', 'route reserved'),
  ('logout',       'system', 'route reserved'),
  ('signup',       'system', 'route reserved'),
  ('signin',       'system', 'route reserved'),
  ('register',     'system', 'route reserved'),
  ('settings',     'system', 'route reserved'),
  ('account',      'system', 'route reserved'),
  ('profile',      'system', 'route reserved'),
  ('home',         'system', 'route reserved'),
  ('about',        'system', 'route reserved'),
  ('terms',        'system', 'route reserved'),
  ('privacy',      'system', 'route reserved'),
  ('pricing',      'system', 'route reserved'),
  ('status',       'system', 'route reserved'),
  ('search',       'system', 'route reserved'),
  ('marketplace',  'system', 'route reserved'),
  ('feed',         'system', 'route reserved'),
  ('me',           'system', 'route reserved'),
  ('new',          'system', 'route reserved'),
  ('explore',      'system', 'route reserved'),
  ('friends',      'system', 'route reserved (/api/friends)'),
  ('signals',      'system', 'route reserved (/api/...signals)'),
  ('channels',     'system', 'route reserved (/api/channels)'),
  ('channel',      'system', 'route reserved'),
  ('group',        'system', 'route reserved'),
  ('groups',       'system', 'route reserved'),
  ('reactions',    'system', 'route reserved'),
  ('identity',     'system', 'route reserved (/api/identity)'),
  ('whoami',       'system', 'route reserved'),
  ('allowance',    'system', 'route reserved (/api/billing/allowance)'),
  ('spender',      'system', 'route reserved (/api/billing/spender)'),
  ('usage',        'system', 'route reserved (/api/usage)'),
  ('auth',         'system', 'route reserved (/api/auth)'),
  ('nonce',        'system', 'route reserved'),
  ('verify',       'system', 'route reserved'),
  ('stream',       'system', 'route reserved'),
  ('static',       'system', 'asset path reserved'),
  ('assets',       'system', 'asset path reserved'),
  ('public',       'system', 'asset path reserved'),
  ('favicon',      'system', 'asset path reserved'),
  ('robots',       'system', 'asset path reserved'),
  ('sitemap',      'system', 'asset path reserved');

-- ─── Seed: obscenity category ──────────────────────────────────────────
-- Conservative English-baseline only. Admin extends for new languages /
-- emerging slurs as needed. The full operative list is intentionally not
-- public (per Discord / WeChat practice — published examples + hidden
-- expansion list to deter circumvention).
INSERT INTO reserved_usernames(username, category, reason) VALUES
  ('fuck',     'obscenity', 'reserved word'),
  ('fucker',   'obscenity', 'reserved word'),
  ('fucking',  'obscenity', 'reserved word'),
  ('shit',     'obscenity', 'reserved word'),
  ('bitch',    'obscenity', 'reserved word'),
  ('cunt',     'obscenity', 'reserved word'),
  ('asshole',  'obscenity', 'reserved word'),
  ('nigger',   'obscenity', 'reserved word'),
  ('nigga',    'obscenity', 'reserved word'),
  ('faggot',   'obscenity', 'reserved word'),
  ('retard',   'obscenity', 'reserved word'),
  ('rape',     'obscenity', 'reserved word'),
  ('rapist',   'obscenity', 'reserved word'),
  ('nazi',     'obscenity', 'reserved word'),
  ('hitler',   'obscenity', 'reserved word'),
  ('kkk',      'obscenity', 'reserved word'),
  ('scammer',  'obscenity', 'reserved word'),
  ('rugpull',  'obscenity', 'reserved word'),
  ('rugged',   'obscenity', 'reserved word');
