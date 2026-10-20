-- Store billing (@flare/billing): what the App Store and Google Play last
-- said about each subscription, and the access it gives. Spaces
-- (households) are read from space_members (@sync/server's migration), so
-- a payer who leaves stops covering the space at once.
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  store TEXT NOT NULL,          -- apple | google
  id TEXT NOT NULL,             -- Apple originalTransactionId, or the Google purchase token
  user_id TEXT,                 -- the payer; null until their app reports the purchase
  account_token TEXT,           -- appAccountToken / obfuscatedExternalAccountId (accountToken(user))
  app_id TEXT NOT NULL,         -- bundle id or package name
  product_id TEXT NOT NULL,
  state TEXT NOT NULL,          -- active | grace | canceled | hold | paused | pending | expired | revoked | superseded
  expires_at INTEGER,           -- ms since 1970; end of the paid (or canceled) period
  started_at INTEGER,           -- ms since 1970
  acknowledged INTEGER NOT NULL DEFAULT 1, -- Google: 0 until Play has the acknowledgement (3-day rule)
  environment TEXT,             -- Production | Sandbox | test
  space_id TEXT,                -- payerCovers "one-space": the space the payer picked
  updated_at INTEGER NOT NULL,  -- ms since 1970
  PRIMARY KEY (store, id)
);
CREATE INDEX IF NOT EXISTS billing_subscriptions_user ON billing_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS billing_subscriptions_account ON billing_subscriptions (account_token);

-- payerLeaves "period-end": the spaces a payer was in when their
-- subscription was last checked, kept after they leave until `until`.
CREATE TABLE IF NOT EXISTS billing_payer_spaces (
  user_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  until INTEGER NOT NULL,       -- ms since 1970
  PRIMARY KEY (user_id, space_id)
);

-- Access given by hand (support comps, reviewers, testers): to a user or a space.
CREATE TABLE IF NOT EXISTS billing_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entitlement TEXT NOT NULL,
  user_id TEXT,
  space_id TEXT,
  expires_at INTEGER NOT NULL,  -- ms since 1970
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_grants_user ON billing_grants (user_id);
CREATE INDEX IF NOT EXISTS billing_grants_space ON billing_grants (space_id);
