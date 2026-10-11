-- Which spaces each member is in, so linking an anonymous user to a real
-- account (or a pre-accounts device to its user) can find every space to
-- move. Kept by the spaces.ts calls; a space deleted after sitting empty
-- leaves stale rows, which relinking skips and removes.
CREATE TABLE IF NOT EXISTS space_members (
  member_id TEXT NOT NULL,      -- the user id (or, before accounts, the device id)
  space_id TEXT NOT NULL,       -- the SpaceObject's id (hex)
  PRIMARY KEY (member_id, space_id)
);
