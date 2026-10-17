-- Push notifications (@flare/push): one row per device that can receive
-- them. The app's Worker keeps it through PUT/DELETE {prefix}/push/device,
-- and the Queue consumer deletes a row when APNs or FCM says its token is
-- gone.
CREATE TABLE IF NOT EXISTS push_tokens (
  device_id TEXT PRIMARY KEY,   -- the device id the app's identify() returns
  member_id TEXT NOT NULL,      -- the user id, or before accounts the device id
  platform TEXT NOT NULL,       -- ios | android
  token TEXT NOT NULL,          -- APNs device token (hex) or FCM registration token
  apns_env TEXT,                -- sandbox | production (iOS only)
  app_id TEXT,                  -- bundle id or package name
  permission TEXT NOT NULL,     -- allowed | quiet | blocked | not_asked
  muted_channels TEXT NOT NULL DEFAULT '[]', -- JSON array of Android channel ids switched off
  locale TEXT,
  updated_at INTEGER NOT NULL   -- ms since 1970
);
CREATE INDEX IF NOT EXISTS push_tokens_member ON push_tokens (member_id);
CREATE INDEX IF NOT EXISTS push_tokens_token ON push_tokens (token);
