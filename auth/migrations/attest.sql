-- Device attestation (App Attest and Android key attestation). The same
-- tables Cooked's API already has, so an app moving to @flare/auth keeps
-- its registered keys.

-- One-time challenges, valid for five minutes.
CREATE TABLE IF NOT EXISTS attest_challenges (
  challenge TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attest_keys (
  key_id TEXT PRIMARY KEY,      -- standard base64 of SHA-256(public key)
  public_key TEXT NOT NULL,     -- SPKI DER, base64
  sign_count INTEGER NOT NULL,  -- last accepted assertion counter
  environment TEXT NOT NULL,    -- production | development
  app_id TEXT NOT NULL,         -- "<team id>.<bundle id>", or "android:<package>"
  receipt TEXT,                 -- Apple's receipt, kept for fraud-risk checks later
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
