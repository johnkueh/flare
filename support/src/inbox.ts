// The inbox index in D1: contacts, a row per conversation, and full-text search over messages.

import type { SupportEnv } from "./config.ts";

export type Contact = { id: string; app: string; external_id: string | null; email: string | null; name: string | null; org: string | null };

export type ConversationRow = {
  id: string;
  app: string;
  contact_id: string;
  status: "open" | "closed";
  waiting_on: "us" | "customer";
  subject: string;
  channel: "chat" | "email";
  preview: string;
  last_author: string;
  message_count: number;
  created_at: number;
  last_message_at: number;
};

export type InboxRow = ConversationRow & { contact_email: string | null; contact_name: string | null; contact_org: string | null };

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export const getContact = (env: SupportEnv, id: string) => env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<Contact>();

/** The contact for a signed-in user of `app`, created or refreshed from what the app told us. */
export async function contactForUser(env: SupportEnv, app: string, user: { sub: string; email?: string; name?: string; org?: string }): Promise<Contact> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO contacts (id, app, external_id, email, name, org, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (app, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
       email = coalesce(excluded.email, email), name = coalesce(excluded.name, name), org = coalesce(excluded.org, org), updated_at = excluded.updated_at`
  )
    .bind(newId("ct"), app, user.sub, user.email ?? null, user.name ?? null, user.org ?? null, now, now)
    .run();
  const row = await env.DB.prepare("SELECT * FROM contacts WHERE app = ? AND external_id = ?").bind(app, user.sub).first<Contact>();
  if (!row) throw new Error("contact upsert failed");
  return row;
}

/** A new anonymous contact (a visitor who isn't signed in). */
export async function anonymousContact(env: SupportEnv, app: string): Promise<Contact> {
  const now = Date.now();
  const contact: Contact = { id: newId("ct"), app, external_id: null, email: null, name: null, org: null };
  await env.DB.prepare("INSERT INTO contacts (id, app, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(contact.id, app, now, now).run();
  return contact;
}

/** The contact who emails from `email`: a signed-in user with that address first, else an email-only contact. */
export async function contactForEmail(env: SupportEnv, app: string, email: string, name?: string): Promise<Contact> {
  const address = email.toLowerCase();
  const found = await env.DB.prepare("SELECT * FROM contacts WHERE app = ? AND lower(email) = ? ORDER BY external_id IS NULL, updated_at DESC LIMIT 1")
    .bind(app, address)
    .first<Contact>();
  if (found) return found;
  const now = Date.now();
  const contact: Contact = { id: newId("ct"), app, external_id: null, email: address, name: name || null, org: null };
  await env.DB.prepare("INSERT INTO contacts (id, app, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(contact.id, app, contact.email, contact.name, now, now)
    .run();
  return contact;
}

export async function setContactEmail(env: SupportEnv, id: string, email: string) {
  await env.DB.prepare("UPDATE contacts SET email = ?, updated_at = ? WHERE id = ?").bind(email.toLowerCase(), Date.now(), id).run();
}

export async function createConversationRow(env: SupportEnv, row: Pick<ConversationRow, "id" | "app" | "contact_id" | "subject" | "channel">) {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO conversations (id, app, contact_id, subject, channel, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.app, row.contact_id, row.subject, row.channel, now, now)
    .run();
}

export const getConversationRow = (env: SupportEnv, id: string) => env.DB.prepare("SELECT * FROM conversations WHERE id = ?").bind(id).first<ConversationRow>();

const preview = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 140);

/** Records a new message on its conversation row (and in search). Notes stay out of the preview and the turn. */
export async function recordMessage(env: SupportEnv, conversationId: string, app: string, author: "customer" | "agent" | "note", body: string, at: number) {
  const statements = [env.DB.prepare("INSERT INTO messages_fts (body, conversation_id, app) VALUES (?, ?, ?)").bind(body, conversationId, app)];
  if (author === "note") {
    statements.push(env.DB.prepare("UPDATE conversations SET message_count = message_count + 1 WHERE id = ?").bind(conversationId));
  } else {
    // A customer writing reopens a closed conversation; our reply leaves the status alone.
    statements.push(
      env.DB.prepare(
        `UPDATE conversations SET preview = ?, last_author = ?, last_message_at = ?, message_count = message_count + 1,
           waiting_on = ?, status = CASE WHEN ? = 'customer' THEN 'open' ELSE status END WHERE id = ?`
      ).bind(preview(body), author, at, author === "customer" ? "us" : "customer", author, conversationId)
    );
  }
  await env.DB.batch(statements);
}

export async function setStatus(env: SupportEnv, id: string, status: "open" | "closed") {
  const r = await env.DB.prepare("UPDATE conversations SET status = ? WHERE id = ?").bind(status, id).run();
  return r.meta.changes > 0;
}

const INBOX_SELECT = `SELECT c.*, ct.email AS contact_email, ct.name AS contact_name, ct.org AS contact_org
  FROM conversations c JOIN contacts ct ON ct.id = c.contact_id`;

export async function listInbox(
  env: SupportEnv,
  filter: { status?: "open" | "closed" | "all"; app?: string; waitingOn?: "us" | "customer"; limit?: number; before?: number }
): Promise<InboxRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status && filter.status !== "all") {
    where.push("c.status = ?");
    args.push(filter.status);
  }
  if (filter.app) {
    where.push("c.app = ?");
    args.push(filter.app);
  }
  if (filter.waitingOn) {
    where.push("c.waiting_on = ?");
    args.push(filter.waitingOn);
  }
  if (filter.before) {
    where.push("c.last_message_at < ?");
    args.push(filter.before);
  }
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
  const sql = `${INBOX_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.last_message_at DESC LIMIT ${limit}`;
  return (await env.DB.prepare(sql).bind(...args).all<InboxRow>()).results;
}

export const inboxRow = (env: SupportEnv, id: string) => env.DB.prepare(`${INBOX_SELECT} WHERE c.id = ?`).bind(id).first<InboxRow>();

/** A contact's own conversations, newest first, for the widget. */
export async function contactConversations(env: SupportEnv, contactId: string): Promise<ConversationRow[]> {
  return (await env.DB.prepare("SELECT * FROM conversations WHERE contact_id = ? ORDER BY last_message_at DESC LIMIT 20").bind(contactId).all<ConversationRow>()).results;
}

/** Conversations whose messages match `query` (FTS5 syntax, words ANDed), newest first. */
export async function search(env: SupportEnv, query: string, app?: string): Promise<(InboxRow & { snippet: string })[]> {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(" ");
  if (!terms) return [];
  const sql = `SELECT c.*, ct.email AS contact_email, ct.name AS contact_name, ct.org AS contact_org, m.snippet
    FROM (SELECT conversation_id, snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet, rank FROM messages_fts
          WHERE messages_fts MATCH ? ${app ? "AND app = ?" : ""} ORDER BY rank LIMIT 200) m
    JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
    GROUP BY c.id ORDER BY c.last_message_at DESC LIMIT 25`;
  const stmt = app ? env.DB.prepare(sql).bind(terms, app) : env.DB.prepare(sql).bind(terms);
  return (await stmt.all<InboxRow & { snippet: string }>()).results;
}

export async function stats(env: SupportEnv) {
  const rows = (
    await env.DB.prepare(
      `SELECT app, status, waiting_on, count(*) AS n, min(CASE WHEN status = 'open' AND waiting_on = 'us' THEN last_message_at END) AS oldest_waiting
       FROM conversations GROUP BY app, status, waiting_on`
    ).all<{ app: string; status: string; waiting_on: string; n: number; oldest_waiting: number | null }>()
  ).results;
  const byApp: Record<string, { open: number; waitingOnUs: number; closed: number; oldestWaitingSince: string | null }> = {};
  for (const r of rows) {
    const a = (byApp[r.app] ??= { open: 0, waitingOnUs: 0, closed: 0, oldestWaitingSince: null });
    if (r.status === "closed") a.closed += r.n;
    else {
      a.open += r.n;
      if (r.waiting_on === "us") {
        a.waitingOnUs += r.n;
        if (r.oldest_waiting) a.oldestWaitingSince = new Date(r.oldest_waiting).toISOString();
      }
    }
  }
  return byApp;
}
