// The support Worker. One deployment serves every app in APPS:
//
//   /widget.js, /chat          the chat widget (widget.ts)
//   /v1/…                      the widget's API (api.ts)
//   /mcp                       the inbox for Claude (mcp.ts), behind OAuth; /authorize is admin.ts
//   email()                    support@<app domain> mail, via Email Routing (email.ts)
//
// See SUPPORT.md for setup.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { handleAuthorize, isAdminKey } from "./admin.ts";
import { conversationStub, handleApi } from "./api.ts";
import { app as appConfig, appForDomain, type SupportEnv } from "./config.ts";
import { parseInbound, parseReplyAddress } from "./email.ts";
import { getContact, getConversationRow } from "./inbox.ts";
import { handleMcp } from "./mcp.ts";
import { chatResponse, loaderResponse } from "./widget.ts";

export { Conversation } from "./conversation.ts";

type Env = SupportEnv & {
  /** This Worker's canonical origin, e.g. "https://support.example.com". The MCP URL is <PUBLIC_URL>/mcp. */
  PUBLIC_URL: string;
};

const site = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/widget.js") return loaderResponse();
    if (path === "/chat") {
      const id = url.searchParams.get("app");
      const app = appConfig(env, id);
      return id && app ? chatResponse(id, app) : new Response("unknown app", { status: 404 });
    }
    if (path.startsWith("/v1/")) return handleApi(request, env, url);
    if (path === "/authorize") return handleAuthorize(request, env);
    if (path === "/") return new Response("Flare support", { headers: { "Content-Type": "text/plain" } });
    return new Response("not found", { status: 404 });
  },
};

const mcp = {
  fetch: (request: Request, env: Env) => handleMcp(request, env),
};

// One provider per canonical URL (the resource URL is fixed when it's built).
const providers = new Map<string, OAuthProvider<Env>>();

function provider(env: Env): OAuthProvider<Env> {
  const origin = env.PUBLIC_URL.replace(/\/$/, "");
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcp,
      defaultHandler: site,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["support"],
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Support inbox" },
      // The admin key also works as a bearer token, for scripts and local testing. Outside the MCP
      // authorization profile, so claude.ai connects through /authorize instead.
      resolveExternalToken: async ({ token, env }) => ((await isAdminKey(env, token)) ? { props: { admin: true }, audience: `${origin}/mcp` } : null),
    });
    providers.set(origin, p);
  }
  return p;
}

async function receiveEmail(message: ForwardableEmailMessage, env: Env) {
  // Only replies come in by email: each email we send carries a signed reply-to address for its
  // conversation. Anything else sent here is refused, so a stray or guessed address starts nothing.
  const domain = message.to.split("@")[1] ?? "";
  const appId = appForDomain(env, domain);
  const app = appConfig(env, appId);
  const reply = appId && app?.email ? await parseReplyAddress(env, message.to) : null;
  const row = reply ? await getConversationRow(env, reply.conversationId) : null;
  if (!(reply && row && row.app === appId && app)) {
    message.setReject("This address only takes replies to support emails");
    return;
  }
  const mail = await parseInbound(message.raw, { from: message.from, to: message.to }, message.headers);
  // Out-of-office replies would only loop.
  if (mail.auto || !mail.body) return;

  const conversation = conversationStub(env, row.id);
  if (reply.kind === "a") {
    // The team answering from the notification email. Only from the notify address.
    if (mail.from !== app.notify?.toLowerCase()) return;
    await conversation.post({ author: "agent", body: mail.body, via: "email", authorName: mail.fromName?.split(" ")[0] });
    return;
  }
  // The customer answering our email. Someone else replying to a forwarded copy is ignored.
  const contact = await getContact(env, row.contact_id);
  if (!(contact?.email && contact.email.toLowerCase() === mail.from)) return;
  if (mail.messageId) await conversation.rememberEmail(mail.messageId);
  await conversation.post({ author: "customer", body: mail.body, via: "email" });
}

export default {
  fetch: (request, env, ctx) => provider(env).fetch(request, env, ctx),
  email: (message, env) => receiveEmail(message, env),
} satisfies ExportedHandler<Env>;
