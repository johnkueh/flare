-- Sync spaces: each space is a SpaceObject Durable Object.
-- This maps a space's current invite code to it, for GET /v1/invites/{code}.
-- Creating a space adds its row; resetting the code replaces it; a space
-- deleted after sitting empty removes it.
CREATE TABLE IF NOT EXISTS space_codes (
  code TEXT PRIMARY KEY,        -- 8 Crockford base32 characters, no dash
  space_id TEXT NOT NULL,       -- the SpaceObject's id (hex)
  created_at INTEGER NOT NULL   -- ms since 1970
);
CREATE INDEX IF NOT EXISTS space_codes_space ON space_codes (space_id);
