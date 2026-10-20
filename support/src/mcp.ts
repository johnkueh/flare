// The inbox as an MCP server (POST /mcp, JSON-RPC, one JSON response per request). Add the Worker's
// /mcp URL to claude.ai as a custom connector and Claude can list, read, search and answer
// conversations; so can an artifact that declares the connector.
//
// Serves both MCP eras: 2026-07-28 (stateless, `server/discover`, version in `_meta`) and the
// older initialize handshake. The OAuth provider in worker.ts has already checked the caller.

import { app as appConfig, apps, type SupportEnv } from "./config.ts";
import { conversationStub, startConversation } from "./api.ts";
import { contactForEmail, getContact, inboxRow, type InboxRow, listInbox, search, setStatus, stats } from "./inbox.ts";

const VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "flare-support", title: "Support inbox", version: "0.1.0" };

const INSTRUCTIONS = `The customer support inbox for every app on this server. A conversation is waiting on "us" when the customer wrote last.
Read a conversation before replying. reply sends to the customer (live in their chat, or by email when they've left); add_note is visible only to the team.
Write replies as the person answering support: short, plain, no markdown.`;

type JsonRpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  run: (env: SupportEnv, args: Record<string, unknown>) => Promise<unknown>;
};

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });

const conversationSummary = (r: InboxRow) => ({
  id: r.id,
  app: r.app,
  status: r.status,
  waitingOn: r.waiting_on,
  subject: r.subject,
  preview: r.preview,
  lastAuthor: r.last_author,
  channel: r.channel,
  messages: r.message_count,
  lastMessageAt: new Date(r.last_message_at).toISOString(),
  contact: { email: r.contact_email, name: r.contact_name, org: r.contact_org },
});

class ToolError extends Error {}

const need = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`${key} is required`);
  return v.trim();
};

async function conversationOrThrow(env: SupportEnv, id: string) {
  const row = await inboxRow(env, id);
  if (!row) throw new ToolError(`No conversation ${id}`);
  return row;
}

const TOOLS: Tool[] = [
  {
    name: "list_conversations",
    title: "List conversations",
    description: "Conversations, newest activity first. Defaults to open ones across all apps.",
    inputSchema: {
      type: "object",
      properties: {
        status: str("open, closed or all", { enum: ["open", "closed", "all"] }),
        app: str("Only this app id"),
        waiting_on: str("us: the customer wrote last; customer: we did", { enum: ["us", "customer"] }),
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 25" },
        before: str("ISO time: only conversations whose last message is older, for paging"),
      },
    },
    annotations: { readOnlyHint: true },
    run: async (env, a) => {
      const rows = await listInbox(env, {
        status: (a.status as "open" | "closed" | "all" | undefined) ?? "open",
        app: a.app as string | undefined,
        waitingOn: a.waiting_on as "us" | "customer" | undefined,
        limit: a.limit as number | undefined,
        before: typeof a.before === "string" ? Date.parse(a.before) || undefined : undefined,
      });
      return { conversations: rows.map(conversationSummary), apps: Object.keys(apps(env)) };
    },
  },
  {
    name: "get_conversation",
    title: "Read a conversation",
    description: "One conversation with every message, including the team's internal notes.",
    inputSchema: { type: "object", properties: { id: str("Conversation id") }, required: ["id"] },
    annotations: { readOnlyHint: true },
    run: async (env, a) => {
      const row = await conversationOrThrow(env, need(a, "id"));
      const contact = await getContact(env, row.contact_id);
      const messages = await conversationStub(env, row.id).messages(true);
      return {
        ...conversationSummary(row),
        contact: { email: contact?.email ?? null, name: contact?.name ?? null, org: contact?.org ?? null, userId: contact?.external_id ?? null, signedIn: contact?.external_id != null },
        messages: messages.map((m) => ({ id: m.id, author: m.author, authorName: m.authorName, body: m.body, via: m.via, at: new Date(m.at).toISOString() })),
      };
    },
  },
  {
    name: "reply",
    title: "Reply to the customer",
    description: "Sends a reply. It appears live in their chat, or is emailed to them when they've left. Leaves the conversation open.",
    inputSchema: {
      type: "object",
      properties: { id: str("Conversation id"), body: str("The reply, plain text"), author_name: str("Who is answering, e.g. John. Shown to the customer") },
      required: ["id", "body"],
    },
    run: async (env, a) => {
      const row = await conversationOrThrow(env, need(a, "id"));
      const message = await conversationStub(env, row.id).post({ author: "agent", body: need(a, "body"), via: "inbox", authorName: (a.author_name as string | undefined) || undefined });
      const contact = await getContact(env, row.contact_id);
      return { sent: message, deliveredBy: contact?.email ? "chat, or email if they're away" : "chat only (no email address yet)" };
    },
  },
  {
    name: "add_note",
    title: "Add an internal note",
    description: "A note on the conversation that only the team sees.",
    inputSchema: { type: "object", properties: { id: str("Conversation id"), body: str("The note") }, required: ["id", "body"] },
    run: async (env, a) => {
      const row = await conversationOrThrow(env, need(a, "id"));
      return { note: await conversationStub(env, row.id).post({ author: "note", body: need(a, "body"), via: "inbox" }) };
    },
  },
  {
    name: "set_status",
    title: "Close or reopen",
    description: "Closes a conversation, or reopens it. A customer writing again reopens it by itself.",
    inputSchema: { type: "object", properties: { id: str("Conversation id"), status: str("open or closed", { enum: ["open", "closed"] }) }, required: ["id", "status"] },
    annotations: { idempotentHint: true },
    run: async (env, a) => {
      const status = need(a, "status");
      if (status !== "open" && status !== "closed") throw new ToolError("status must be open or closed");
      if (!(await setStatus(env, need(a, "id"), status))) throw new ToolError(`No conversation ${a.id}`);
      return { id: a.id, status };
    },
  },
  {
    name: "search",
    title: "Search messages",
    description: "Conversations with messages containing every word of the query.",
    inputSchema: { type: "object", properties: { query: str("Words to find"), app: str("Only this app id") }, required: ["query"] },
    annotations: { readOnlyHint: true },
    run: async (env, a) => ({ conversations: (await search(env, need(a, "query"), a.app as string | undefined)).map((r) => ({ ...conversationSummary(r), match: r.snippet })) }),
  },
  {
    name: "stats",
    title: "Inbox counts",
    description: "Per app: open conversations, how many wait on us, and since when the oldest has waited.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: async (env) => ({ apps: await stats(env) }),
  },
  {
    name: "start_conversation",
    title: "Email a customer",
    description: "Starts a new conversation by emailing someone, e.g. to follow up on a bug they hit. Their reply comes back into the inbox.",
    inputSchema: {
      type: "object",
      properties: {
        app: str("App id"),
        email: str("Their email address"),
        subject: str("Email subject"),
        body: str("The message, plain text"),
        author_name: str("Who is writing, e.g. John"),
      },
      required: ["app", "email", "subject", "body"],
    },
    run: async (env, a) => {
      const appId = need(a, "app");
      const app = appConfig(env, appId);
      if (!app) throw new ToolError(`Unknown app ${appId}. Apps: ${Object.keys(apps(env)).join(", ")}`);
      if (!app.email) throw new ToolError(`${appId} has no support email address set up`);
      const contact = await contactForEmail(env, appId, need(a, "email"));
      const { id, message } = await startConversation(env, {
        app: appId,
        contactId: contact.id,
        subject: need(a, "subject"),
        channel: "email",
        first: { author: "agent", body: need(a, "body"), via: "inbox", authorName: (a.author_name as string | undefined) || undefined },
      });
      return { id, sent: message };
    },
  },
];

const listedTools = TOOLS.map(({ run: _run, ...t }) => t);

const rpcResult = (id: JsonRpc["id"], result: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  result: { resultType: "complete", ...result, _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } },
});
const rpcError = (id: JsonRpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function dispatch(env: SupportEnv, msg: JsonRpc): Promise<object | null> {
  if (msg.id === undefined) return null; // a notification: nothing to answer
  const params = msg.params ?? {};
  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion as string | undefined;
      return rpcResult(msg.id, {
        protocolVersion: asked && VERSIONS.includes(asked) ? asked : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "server/discover":
      return rpcResult(msg.id, { supportedVersions: VERSIONS, capabilities: { tools: {} }, instructions: INSTRUCTIONS, ttlMs: 3_600_000, cacheScope: "public" });
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: listedTools, ttlMs: 3_600_000, cacheScope: "public" });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${String(params.name)}`);
      try {
        const out = await tool.run(env, (params.arguments as Record<string, unknown>) ?? {});
        return rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out });
      } catch (err) {
        if (err instanceof ToolError) return rpcResult(msg.id, { content: [{ type: "text", text: err.message }], isError: true });
        throw err;
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(request: Request, env: SupportEnv): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? (body as unknown[]) : [body]).map((m) => dispatch(env, m as JsonRpc)))).filter(Boolean);
  if (replies.length === 0) return new Response(null, { status: 202 });
  return Response.json(batch ? replies : replies[0]);
}
