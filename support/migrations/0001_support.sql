-- The inbox: who wrote in, and one row per conversation for listing and filtering. Each
-- conversation's messages live in its own Durable Object (src/conversation.ts); messages_fts is a
-- searchable copy of their text.

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  -- The app's own user id, from a signed identity token. Null for anonymous visitors and email.
  external_id TEXT,
  email TEXT,
  name TEXT,
  org TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS contacts_app_external ON contacts (app, external_id) WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS contacts_app_email ON contacts (app, email);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  -- open | closed
  status TEXT NOT NULL DEFAULT 'open',
  -- us | customer: whose turn it is
  waiting_on TEXT NOT NULL DEFAULT 'us',
  subject TEXT NOT NULL DEFAULT '',
  -- chat | email
  channel TEXT NOT NULL DEFAULT 'chat',
  preview TEXT NOT NULL DEFAULT '',
  last_author TEXT NOT NULL DEFAULT 'customer',
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS conversations_inbox ON conversations (status, last_message_at);

CREATE INDEX IF NOT EXISTS conversations_contact ON conversations (contact_id, last_message_at);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (body, conversation_id UNINDEXED, app UNINDEXED);
