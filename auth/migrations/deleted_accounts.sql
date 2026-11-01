-- Soft-deleted accounts (POST /delete-account). Signing back in removes the
-- row and restores the account; purgeDeletedAccounts deletes the user once
-- deleted_at is older than deleteAfterDays.
CREATE TABLE IF NOT EXISTS deleted_accounts (
  user_id TEXT PRIMARY KEY,     -- Better Auth's user.id
  deleted_at INTEGER NOT NULL   -- ms since the epoch
);
CREATE INDEX IF NOT EXISTS deleted_accounts_at ON deleted_accounts (deleted_at);
