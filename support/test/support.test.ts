import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parseReplyAddress, replyAddress, stripQuoted } from "../src/email";
import { signIdentity, verify } from "../src/token";
import worker from "../src/worker";

const BASE = "https://support.test";
const ACME = { name: "Acme", origins: ["https://acme.test"], email: "support@acme.test", notify: "team@acme.test" };

async function api<T = Record<string, unknown>>(method: string, path: string, opts: { session?: string; body?: unknown } = {}) {
  const res = await SELF.fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(opts.session ? { Authorization: `Bearer ${opts.session}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

async function session(body: Record<string, unknown> = { app: "acme" }) {
  const res = await api<{ session: string; contact: { email: string | null; identified: boolean } }>("POST", "/v1/session", { body });
  expect(res.status).toBe(200);
  return res.body;
}

async function mcp(method: string, params: Record<string, unknown> = {}, auth = "test-admin-key") {
  const res = await SELF.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${auth}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as { result?: Record<string, unknown>; error?: { message: string } } };
}

async function tool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) {
  const res = await mcp("tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const result = res.body.result as { structuredContent: T; isError?: boolean; content: { text: string }[] };
  if (result.isError) throw new Error(result.content[0]?.text);
  return result.structuredContent;
}

type Sent = { to: string; subject: string; replyTo?: string; text: string; from: { email: string; name: string } };

async function outbox(): Promise<Sent[]> {
  const keys = (await env.TEST_OUTBOX.list()).keys.map((k) => k.name).sort();
  return Promise.all(keys.map(async (k) => JSON.parse((await env.TEST_OUTBOX.get(k)) as string) as Sent));
}

async function clearOutbox() {
  for (const k of (await env.TEST_OUTBOX.list()).keys) await env.TEST_OUTBOX.delete(k.name);
}

/** Lets waitUntil work (the emails) finish. */
const settle = () => new Promise((r) => setTimeout(r, 50));

function rawEmail(h: { from: string; to: string; subject: string; body: string; messageId?: string; extra?: string }) {
  return [
    `From: ${h.from}`,
    `To: ${h.to}`,
    `Subject: ${h.subject}`,
    `Message-ID: ${h.messageId ?? `<${crypto.randomUUID()}@mail.test>`}`,
    ...(h.extra ? [h.extra] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    h.body,
  ].join("\r\n");
}

async function deliver(h: Parameters<typeof rawEmail>[0]) {
  const raw = rawEmail(h);
  let rejected: string | null = null;
  const message = {
    from: h.from.replace(/.*</, "").replace(/>.*/, ""),
    to: h.to,
    raw: new Response(raw).body,
    rawSize: raw.length,
    headers: new Headers(raw.split("\r\n\r\n")[0]?.split("\r\n").map((l) => l.split(/:\s*/, 2) as [string, string])),
    setReject: (reason: string) => {
      rejected = reason;
    },
    forward: async () => ({}),
    reply: async () => ({}),
  } as unknown as ForwardableEmailMessage;
  await worker.email(message, env as never);
  await settle();
  return { rejected };
}

beforeEach(clearOutbox);

describe("tokens", () => {
  it("round-trips and rejects tampering and expiry", async () => {
    const t = await signIdentity("s", { app: "acme", sub: "u1" });
    expect(await verify<{ sub: string }>("s", t)).toMatchObject({ sub: "u1" });
    expect(await verify("other", t)).toBeNull();
    expect(await verify("s", `${t}x`)).toBeNull();
    expect(await verify("s", await signIdentity("s", { app: "acme", sub: "u1" }, -1))).toBeNull();
  });
});

describe("widget", () => {
  it("serves the launcher and a chat page only the app's pages can frame", async () => {
    const js = await SELF.fetch(`${BASE}/widget.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toContain("FlareSupport");
    const chat = await SELF.fetch(`${BASE}/chat?app=acme`);
    expect(chat.status).toBe(200);
    expect(chat.headers.get("content-security-policy")).toContain("frame-ancestors https://acme.test");
    const html = await chat.text();
    expect(html).toContain('"app":"acme"');
    expect(html).toContain("--accent:#2255aa");
    expect((await SELF.fetch(`${BASE}/chat?app=nope`)).status).toBe(404);
  });

  it("starts an anonymous conversation, tells the team, and asks for an email", async () => {
    const s = await session();
    expect(s.contact.identified).toBe(false);
    const created = await api<{ id: string }>("POST", "/v1/conversations", { session: s.session, body: { body: "How do I export to CSV?" } });
    expect(created.status).toBe(201);
    await settle();
    const [notice] = await outbox();
    expect(notice?.to).toBe("team@acme.test");
    expect(notice?.text).toContain("How do I export to CSV?");
    expect(await parseReplyAddress(env, notice?.replyTo ?? "")).toEqual({ kind: "a", conversationId: created.body.id });

    const list = await api<{ conversations: { id: string; preview: string }[] }>("GET", "/v1/conversations", { session: s.session });
    expect(list.body.conversations.map((c) => c.id)).toEqual([created.body.id]);

    expect((await api("POST", "/v1/contact", { session: s.session, body: { email: "not an email" } })).status).toBe(400);
    expect((await api("POST", "/v1/contact", { session: s.session, body: { email: "Pat@Example.com" } })).status).toBe(200);

    // A returning visitor keeps their conversations.
    const again = await session({ app: "acme", session: s.session });
    expect(again.contact.email).toBe("pat@example.com");
  });

  it("trusts a signed-in user only with the app's signature", async () => {
    const good = await signIdentity("acme-app-secret", { app: "acme", sub: "user-7", email: "sam@firm.test", name: "Sam", org: "Firm" });
    const s = await session({ app: "acme", identity: good });
    expect(s.contact).toMatchObject({ identified: true, email: "sam@firm.test" });
    const forged = await signIdentity("guess", { app: "acme", sub: "user-7" });
    expect((await api("POST", "/v1/session", { body: { app: "acme", identity: forged } })).status).toBe(401);
    const wrongApp = await signIdentity("acme-app-secret", { app: "other", sub: "user-7" });
    expect((await api("POST", "/v1/session", { body: { app: "acme", identity: wrongApp } })).status).toBe(401);
    // A signed-in user's session doesn't carry over to an anonymous visitor.
    const anon = await session({ app: "acme", session: s.session });
    expect(anon.contact.identified).toBe(false);
  });

  it("keeps visitors out of each other's conversations", async () => {
    const a = await session();
    const b = await session();
    const created = await api<{ id: string }>("POST", "/v1/conversations", { session: a.session, body: { body: "mine" } });
    const ws = await SELF.fetch(`${BASE}/v1/conversations/${created.body.id}/ws?session=${encodeURIComponent(b.session)}`, { headers: { Upgrade: "websocket" } });
    expect(ws.status).toBe(404);
    expect((await api("GET", "/v1/conversations", { session: "forged.token" })).status).toBe(401);
  });

  it("chats live over a WebSocket and gets our reply there, not by email", async () => {
    const identity = await signIdentity("acme-app-secret", { app: "acme", sub: "user-ws", email: "lee@firm.test" });
    const s = await session({ app: "acme", identity });
    const created = await api<{ id: string }>("POST", "/v1/conversations", { session: s.session, body: { body: "hello" } });
    const res = await SELF.fetch(`${BASE}/v1/conversations/${created.body.id}/ws?session=${encodeURIComponent(s.session)}`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const socket = res.webSocket as WebSocket;
    const frames: { type: string; messages?: unknown[]; message?: { author: string; body: string } }[] = [];
    socket.addEventListener("message", (e) => {
      frames.push(JSON.parse(e.data as string));
    });
    socket.accept();
    await settle();
    expect(frames[0]).toMatchObject({ type: "history" });
    expect(frames[0]?.messages).toHaveLength(1);

    socket.send(JSON.stringify({ type: "send", body: "more detail" }));
    await settle();
    expect(frames.at(-1)?.message).toMatchObject({ author: "customer", body: "more detail" });

    await clearOutbox();
    await tool("reply", { id: created.body.id, body: "Here's how.", author_name: "John" });
    await settle();
    expect(frames.at(-1)?.message).toMatchObject({ author: "agent", body: "Here's how." });
    expect((await outbox()).filter((m) => m.to === "lee@firm.test")).toHaveLength(0);
    socket.close();
  });
});

describe("inbox over MCP", () => {
  it("needs the admin key or an OAuth token", async () => {
    const res = await mcp("tools/list", {}, "wrong");
    expect(res.status).toBe(401);
    const meta = await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { resource: string }).resource).toBe(`${BASE}/mcp`);
  });

  it("answers both MCP eras", async () => {
    const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    const discover = await mcp("server/discover");
    expect(discover.body.result).toMatchObject({ resultType: "complete", supportedVersions: expect.arrayContaining(["2026-07-28"]) });
    const list = await mcp("tools/list");
    const names = (list.body.result?.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_conversations", "get_conversation", "reply", "add_note", "set_status", "search", "stats", "start_conversation"]));
  });

  it("lists, reads, notes, replies by email when the customer has left, closes and searches", async () => {
    const identity = await signIdentity("acme-app-secret", { app: "acme", sub: "user-mcp", email: "kim@firm.test", name: "Kim", org: "Firm" });
    const s = await session({ app: "acme", identity });
    const created = await api<{ id: string }>("POST", "/v1/conversations", { session: s.session, body: { body: "The bankstatement import failed on page 3" } });
    const id = created.body.id;

    const open = await tool<{ conversations: { id: string; waitingOn: string; contact: { name: string } }[] }>("list_conversations", { app: "acme", waiting_on: "us" });
    expect(open.conversations.find((c) => c.id === id)).toMatchObject({ waitingOn: "us", contact: { name: "Kim" } });

    await tool("add_note", { id, body: "Probably the OCR bug" });
    await clearOutbox();
    await tool("reply", { id, body: "Fixed, try again?", author_name: "John" });
    await settle();
    const [email] = await outbox();
    expect(email).toMatchObject({ to: "kim@firm.test", subject: expect.stringMatching(/^Re: The bankstatement/) });
    expect(email?.from.name).toBe("John at Acme");
    expect(await parseReplyAddress(env, email?.replyTo ?? "")).toEqual({ kind: "c", conversationId: id });

    const full = await tool<{ waitingOn: string; messages: { author: string }[] }>("get_conversation", { id });
    expect(full.messages.map((m) => m.author)).toEqual(["customer", "note", "agent"]);
    expect(full.waitingOn).toBe("customer");

    // The customer doesn't see the note.
    const res = await SELF.fetch(`${BASE}/v1/conversations/${id}/ws?session=${encodeURIComponent(s.session)}`, { headers: { Upgrade: "websocket" } });
    const socket = res.webSocket as WebSocket;
    const frames: { messages?: { author: string }[] }[] = [];
    socket.addEventListener("message", (e) => {
      frames.push(JSON.parse(e.data as string));
    });
    socket.accept();
    await settle();
    expect(frames[0]?.messages?.map((m) => m.author)).toEqual(["customer", "agent"]);
    socket.close();

    await tool("set_status", { id, status: "closed" });
    expect((await tool<{ conversations: { id: string }[] }>("list_conversations", { app: "acme" })).conversations.some((c) => c.id === id)).toBe(false);

    const found = await tool<{ conversations: { id: string; match: string }[] }>("search", { query: "bankstatement page" });
    expect(found.conversations.map((c) => c.id)).toContain(id);

    const counts = await tool<{ apps: Record<string, { closed: number }> }>("stats");
    expect(counts.apps.acme?.closed).toBeGreaterThan(0);
  });

  it("reports a bad id as a tool error", async () => {
    const res = await mcp("tools/call", { name: "get_conversation", arguments: { id: "cv_nope" } });
    expect(res.body.result).toMatchObject({ isError: true });
  });
});

describe("email", () => {
  it("turns mail to the support address into a conversation, and threads the replies", async () => {
    await deliver({ from: "Robin <robin@client.test>", to: "support@acme.test", subject: "Invoice question", body: "Where is my invoice?" });
    const [notice] = await outbox();
    expect(notice?.to).toBe("team@acme.test");
    const conv = await parseReplyAddress(env, notice?.replyTo ?? "");
    expect(conv?.kind).toBe("a");
    const id = conv?.conversationId as string;

    // The team answers by replying to the notification.
    await clearOutbox();
    await deliver({ from: "John <team@acme.test>", to: notice?.replyTo as string, subject: "Re: New", body: "It's in Billing.\n\nOn Mon, 20 Oct 2026, Acme wrote:\n> Where is my invoice?" });
    const [toCustomer] = await outbox();
    expect(toCustomer).toMatchObject({ to: "robin@client.test", subject: "Re: Invoice question" });
    expect(toCustomer?.text).toContain("It's in Billing.");
    expect(toCustomer?.text).not.toContain("> Where is my invoice?");

    // The customer replies to that.
    await clearOutbox();
    await deliver({ from: "robin@client.test", to: toCustomer?.replyTo as string, subject: "Re: Invoice question", body: "Found it, thanks!\n\n> It's in Billing." });
    const thread = await tool<{ messages: { author: string; body: string; via: string }[]; waitingOn: string }>("get_conversation", { id });
    expect(thread.messages.map((m) => [m.author, m.body])).toEqual([
      ["customer", "Where is my invoice?"],
      ["agent", "It's in Billing."],
      ["customer", "Found it, thanks!"],
    ]);
    expect(thread.waitingOn).toBe("us");
  });

  it("ignores forged reply addresses, strangers posing as the team, and auto-replies", async () => {
    await deliver({ from: "robin@client.test", to: "support@acme.test", subject: "Hi", body: "first" });
    const [notice] = await outbox();
    const id = (await parseReplyAddress(env, notice?.replyTo ?? ""))?.conversationId as string;
    const before = (await tool<{ messages: unknown[] }>("get_conversation", { id })).messages.length;

    await deliver({ from: "robin@client.test", to: notice?.replyTo as string, subject: "Re", body: "I'm the team now" });
    await deliver({ from: "robin@client.test", to: "support+c.cv_abc.AAAAAAAAAAAAAAAA@acme.test", subject: "Re", body: "forged" });
    await deliver({ from: "robin@client.test", to: "support@acme.test", subject: "Out of office", body: "away", extra: "Auto-Submitted: auto-replied" });
    expect((await tool<{ messages: unknown[] }>("get_conversation", { id })).messages.length).toBe(before);
    expect(await deliver({ from: "x@y.test", to: "help@unknown.test", subject: "?", body: "?" })).toEqual({ rejected: "Unknown address" });
  });

  it("uses the inbound address when the main domain's mail lives elsewhere", async () => {
    await deliver({ from: "ash@client.test", to: "help@in.other.test", subject: "Forwarded from Gmail", body: "hello other" });
    const [notice] = await outbox();
    expect(notice).toMatchObject({ to: "team@other.test", from: { email: "help@other.test", name: "Other support" } });
    expect(notice?.replyTo).toMatch(/^help\+a\.cv_\w+\.[\w-]{16}@in\.other\.test$/);
    const id = (await parseReplyAddress(env, notice?.replyTo ?? ""))?.conversationId as string;
    await clearOutbox();
    await tool("reply", { id, body: "hi ash" });
    await settle();
    const [toCustomer] = await outbox();
    expect(toCustomer).toMatchObject({ to: "ash@client.test", from: { email: "help@other.test" } });
    expect(toCustomer?.replyTo).toMatch(/@in\.other\.test$/);
  });

  it("signs reply addresses per conversation and kind", async () => {
    const a = await replyAddress(env, ACME, "c", "cv_1");
    expect(a).toMatch(/^support\+c\.cv_1\.[\w-]{16}@acme\.test$/);
    expect(await parseReplyAddress(env, (a as string).toLowerCase())).toEqual({ kind: "c", conversationId: "cv_1" });
    expect(await parseReplyAddress(env, (a as string).replace("+c.", "+a."))).toBeNull();
  });

  it("keeps only the new part of a reply", () => {
    expect(stripQuoted("Thanks!\n\nOn Tue, Oct 20, 2026 at 9:00 AM Acme <support@acme.test> wrote:\n> hi")).toBe("Thanks!");
    expect(stripQuoted("Sure\nOn Tue, Oct 20, 2026 at 9:00 AM Acme\n<support@acme.test> wrote:\n> hi")).toBe("Sure");
    expect(stripQuoted("Yes\n\n-----Original Message-----\nFrom: x")).toBe("Yes");
    expect(stripQuoted("On second thought, never mind.")).toBe("On second thought, never mind.");
    expect(stripQuoted("ok\n\nSent from my iPhone")).toBe("ok");
  });
});
