// One Durable Object per conversation. It keeps the messages in its own SQLite, holds the
// customer's live chat sockets (hibernating, so an idle chat costs nothing), and is the one place
// every message passes through, whichever way it came in: the widget, email, or the inbox in Claude.
// Each new message updates the inbox row in D1, then reaches whoever isn't looking: the team is
// emailed when a customer writes, the customer is emailed when we reply and their chat is closed.

import { DurableObject } from "cloudflare:workers";
import { app as appConfig, type SupportEnv } from "./config.ts";
import { emailCustomer, notifyTeam } from "./email.ts";
import { getContact, getConversationRow, recordMessage } from "./inbox.ts";

export type Author = "customer" | "agent" | "note";

export type Message = { id: number; author: Author; authorName: string | null; body: string; via: string; at: number };

export type Meta = { id: string; app: string; contactId: string; subject: string };

export const MAX_BODY = 5000;

type Row = { id: number; author: Author; author_name: string | null; body: string; via: string; at: number };

const toMessage = (r: Row): Message => ({ id: r.id, author: r.author, authorName: r.author_name, body: r.body, via: r.via, at: r.at });

/** What a customer's socket may send. */
type ClientFrame = { type: "send"; body: string } | { type: "seen" };

export class Conversation extends DurableObject<SupportEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: SupportEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, author_name TEXT, body TEXT NOT NULL, via TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  private get(key: string): string | undefined {
    return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value;
  }

  private set(key: string, value: string) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  private meta(): Meta {
    const id = this.get("id");
    const app = this.get("app");
    const contactId = this.get("contact_id");
    if (!(id && app && contactId)) throw new Error("conversation not set up");
    return { id, app, contactId, subject: this.get("subject") ?? "" };
  }

  /** Called once when the conversation is created. */
  setup(meta: Meta) {
    if (this.get("id")) return;
    this.set("id", meta.id);
    this.set("app", meta.app);
    this.set("contact_id", meta.contactId);
    this.set("subject", meta.subject);
  }

  /** The thread. Internal notes only when `withNotes`. */
  messages(withNotes = false): Message[] {
    const rows = this.sql.exec<Row>(`SELECT * FROM messages ${withNotes ? "" : "WHERE author != 'note'"} ORDER BY id`).toArray();
    return rows.map(toMessage);
  }

  /** The Message-ID of the customer's latest email, so our email replies thread under it. */
  rememberEmail(messageId: string) {
    this.set("email_message_id", messageId);
  }

  /** Adds a message and lets everyone who needs to know about it know. */
  async post(input: { author: Author; body: string; via: string; authorName?: string }): Promise<Message> {
    const body = input.body.trim().slice(0, MAX_BODY);
    if (!body) throw new Error("empty message");
    const meta = this.meta();
    const at = Date.now();
    const id = this.sql
      .exec<{ id: number }>("INSERT INTO messages (author, author_name, body, via, at) VALUES (?, ?, ?, ?, ?) RETURNING id", input.author, input.authorName ?? null, body, input.via, at)
      .one().id;
    const message: Message = { id, author: input.author, authorName: input.authorName ?? null, body, via: input.via, at };

    const before = await getConversationRow(this.env, meta.id);
    await recordMessage(this.env, meta.id, meta.app, input.author, body, at);

    if (input.author !== "note") this.broadcast({ type: "message", message });

    const app = appConfig(this.env, meta.app);
    if (app && input.author === "customer") {
      // Tell the team once per turn, not for every line of a burst: only when the conversation was
      // waiting on the customer, closed, or brand new.
      const isNew = !before || before.message_count === 0;
      if (isNew || before.waiting_on === "customer" || before.status === "closed") {
        const contact = await getContact(this.env, meta.contactId);
        const from = contact?.name ? `${contact.name}${contact.email ? ` <${contact.email}>` : ""}` : (contact?.email ?? "A visitor");
        this.ctx.waitUntil(notifyTeam(this.env, app, { conversationId: meta.id, from, subject: meta.subject, body, isNew }));
      }
    }
    if (app && input.author === "agent" && this.ctx.getWebSockets("customer").length === 0) {
      const contact = await getContact(this.env, meta.contactId);
      if (contact?.email) {
        this.ctx.waitUntil(
          emailCustomer(this.env, app, {
            conversationId: meta.id,
            to: contact.email,
            subject: meta.subject,
            body,
            authorName: input.authorName,
            inReplyTo: this.get("email_message_id"),
          })
        );
      }
    }
    return message;
  }

  private broadcast(frame: object) {
    const data = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // A socket that is closing; the client reconnects and reloads the thread.
      }
    }
  }

  /** The customer's live chat. The Worker has already checked they own this conversation. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["customer"]);
    pair[1].send(JSON.stringify({ type: "history", messages: this.messages() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as ClientFrame;
    } catch {
      return;
    }
    if (frame.type === "send" && typeof frame.body === "string" && frame.body.trim()) {
      if (this.tooFast()) {
        ws.send(JSON.stringify({ type: "error", error: "slow_down" }));
        return;
      }
      await this.post({ author: "customer", body: frame.body, via: "chat" });
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {
      // already closed
    }
  }

  // At most 20 customer messages a minute, so a stuck script can't flood the inbox.
  private tooFast(): boolean {
    const since = Date.now() - 60_000;
    const n = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM messages WHERE author = 'customer' AND at > ?", since).one().n;
    return n >= 20;
  }
}
