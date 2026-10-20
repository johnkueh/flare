// The widget's API, on the support Worker's own origin (the chat page runs there in an iframe).
//
//   POST /v1/session                    {app, identity?, session?} -> {session, contact}
//   GET  /v1/conversations              the visitor's conversations
//   POST /v1/conversations              {body} -> a new conversation with that first message
//   POST /v1/contact                    {email}: where an anonymous visitor wants replies
//   GET  /v1/conversations/:id/ws       the live chat (WebSocket); ?session= since browsers can't set headers on one
//
// Everything after /v1/session carries `Authorization: Bearer <session>`.

import { app as appConfig, appSecret, type SupportEnv } from "./config.ts";
import { MAX_BODY } from "./conversation.ts";
import {
  anonymousContact,
  type Contact,
  contactConversations,
  contactForUser,
  createConversationRow,
  getContact,
  getConversationRow,
  newId,
  setContactEmail,
} from "./inbox.ts";
import { type Identity, sign, verify } from "./token.ts";

type Session = { app: string; contact: string };

const SESSION_TTL = 60 * 60 * 24 * 90;

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const error = (code: string, status: number) => json({ error: code }, status);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicContact = (c: Contact) => ({ email: c.email, name: c.name, identified: c.external_id !== null });

async function sessionFrom(env: SupportEnv, request: Request, url: URL): Promise<{ session: Session; contact: Contact } | null> {
  const header = request.headers.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("session");
  if (!token) return null;
  const session = await verify<Session>(env.SUPPORT_SECRET, token);
  if (!session) return null;
  const contact = await getContact(env, session.contact);
  return contact && contact.app === session.app ? { session, contact } : null;
}

/**
 * Starts or resumes a visitor's session. A signed identity token from the app wins: the visitor is
 * that user. Otherwise an earlier session from this browser carries on, or a new anonymous visitor
 * starts.
 */
async function startSession(env: SupportEnv, request: Request): Promise<Response> {
  const input = (await request.json().catch(() => null)) as { app?: string; identity?: string; session?: string } | null;
  const appId = input?.app;
  if (!(appId && appConfig(env, appId))) return error("unknown_app", 400);

  let contact: Contact | null = null;
  if (input.identity) {
    const secret = appSecret(env, appId);
    const identity = secret ? await verify<Identity>(secret, input.identity) : null;
    if (!identity || identity.app !== appId || !identity.sub) return error("bad_identity", 401);
    contact = await contactForUser(env, appId, identity);
  } else if (input.session) {
    const session = await verify<Session>(env.SUPPORT_SECRET, input.session);
    const previous = session?.app === appId ? await getContact(env, session.contact) : null;
    // A signed-in user's session doesn't carry over once they've signed out.
    if (previous && previous.external_id === null) contact = previous;
  }
  contact ??= await anonymousContact(env, appId);
  const session = await sign(env.SUPPORT_SECRET, { app: appId, contact: contact.id } satisfies Session, SESSION_TTL);
  return json({ session, contact: publicContact(contact) });
}

const stub = (env: SupportEnv, id: string) => env.CONVERSATION.get(env.CONVERSATION.idFromName(id));

/** Starts a conversation with its first message. Shared by the widget, inbound email and the inbox. */
export async function startConversation(
  env: SupportEnv,
  c: { app: string; contactId: string; subject: string; channel: "chat" | "email"; first?: { author: "customer" | "agent"; body: string; via: string; authorName?: string } }
) {
  const id = newId("cv");
  await createConversationRow(env, { id, app: c.app, contact_id: c.contactId, subject: c.subject, channel: c.channel });
  const conversation = stub(env, id);
  await conversation.setup({ id, app: c.app, contactId: c.contactId, subject: c.subject });
  const message = c.first ? await conversation.post(c.first) : null;
  return { id, conversation, message };
}

export const conversationStub = stub;

export async function handleApi(request: Request, env: SupportEnv, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === "/v1/session" && request.method === "POST") return startSession(env, request);

  const auth = await sessionFrom(env, request, url);
  if (!auth) return error("unauthorized", 401);
  const { session, contact } = auth;

  if (path === "/v1/conversations" && request.method === "GET") {
    const rows = await contactConversations(env, contact.id);
    return json({
      contact: publicContact(contact),
      conversations: rows.map((r) => ({ id: r.id, subject: r.subject, preview: r.preview, lastAuthor: r.last_author, status: r.status, lastMessageAt: r.last_message_at })),
    });
  }

  if (path === "/v1/conversations" && request.method === "POST") {
    const input = (await request.json().catch(() => null)) as { body?: string } | null;
    const body = input?.body?.trim();
    if (!body) return error("empty", 400);
    if (body.length > MAX_BODY) return error("too_long", 400);
    const subject = body.replace(/\s+/g, " ").slice(0, 80);
    const { id, message } = await startConversation(env, {
      app: session.app,
      contactId: contact.id,
      subject,
      channel: "chat",
      first: { author: "customer", body, via: "chat" },
    });
    return json({ id, message }, 201);
  }

  if (path === "/v1/contact" && request.method === "POST") {
    const input = (await request.json().catch(() => null)) as { email?: string } | null;
    const email = input?.email?.trim();
    if (!(email && EMAIL.test(email) && email.length <= 254)) return error("bad_email", 400);
    // A signed-in user's address comes from the app, not from the widget.
    if (contact.external_id !== null) return error("identified", 409);
    await setContactEmail(env, contact.id, email);
    return json({ ok: true });
  }

  const ws = path.match(/^\/v1\/conversations\/([\w-]+)\/ws$/);
  if (ws?.[1]) {
    const row = await getConversationRow(env, ws[1]);
    if (!row || row.contact_id !== contact.id) return error("not_found", 404);
    return stub(env, row.id).fetch(request);
  }

  return error("not_found", 404);
}
