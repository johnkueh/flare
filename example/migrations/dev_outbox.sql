-- Email codes kept instead of sent while DEV_OUTBOX is on.
CREATE TABLE IF NOT EXISTS dev_outbox (
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
