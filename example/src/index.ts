// A shared grocery list on Flare. One Worker serves the whole backend: auth
// (@flare/auth), the spaces (@sync/server) and a web page (public/). It's
// the smallest app that uses every piece, and what the end-to-end tests
// drive.
//
//   /v1/auth/*                  Better Auth: anonymous, email code, Apple
//   /v1/spaces/...              PROTOCOL.md's calls, as the signed-in user
//   /v1/spaces/{id}/docs/{c}    the web page's reads and writes (as SyncGateway does)
//   /dev/outbox                 the last email code sent (DEV_OUTBOX only)

import { authenticate, type FlareAuthEnv, flareAuth, whoIs } from "@flare/auth";
import { foldDocs, stampWrites, type Write } from "@sync/server/docs";
import { nodeId } from "@sync/server/gateway";
import { spaceHttp } from "@sync/server/http";
import {
  changes,
  createSpace,
  joinSpace,
  leaveSpace,
  previewInvite,
  pushOps,
  relinkMember,
  removeDevice,
  resetCode,
  spaceInfo,
  spaceStub,
  type SpacesEnv,
} from "@sync/server/spaces";
import type { Platform, Result } from "@sync/server/space";

export { SpaceObject } from "@sync/server/space";
export { SyncGateway } from "@sync/server/gateway";

export interface Env extends FlareAuthEnv, SpacesEnv {
  SPACE_FILES: R2Bucket;
  ASSETS: Fetcher;
  /** "true": email codes go to /dev/outbox instead of an inbox. */
  DEV_OUTBOX?: string;
  /** Sends email codes through Resend when set. */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  APPLE_BUNDLE_ID?: string;
}

const STATUS: Record<string, number> = { NOT_FOUND: 404, NOT_MEMBER: 403, NOT_OWNER: 403, FULL: 409, INVALID_OPS: 400 };

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const auth = flareAuth(env, {
      onLinkAccount: async ({ anonymousUserId, userId }) => {
        await relinkMember(env, anonymousUserId, userId);
      },
      sendEmailCode: async (email, code) => ctx.waitUntil(sendCode(env, email, code)),
      ...(env.APPLE_BUNDLE_ID && { apple: { appBundleIdentifier: env.APPLE_BUNDLE_ID } }),
    });

    if (url.pathname.startsWith("/v1/auth/")) return auth.handler(request);
    if (url.pathname === "/dev/outbox") return outbox(env, url);

    const files = spaceHttp(request, env, { prefix: "/v1", authenticate: (r) => authenticate(auth, r) });
    if (files) return files;
    if (!url.pathname.startsWith("/v1/")) return env.ASSETS.fetch(request);

    const who = await whoIs(auth, request.headers);
    if (!who) return Response.json({ code: "ATTESTATION_REQUIRED", message: "Sign in again." }, { status: 401 });
    return route(request, env, url, who);
  },
} satisfies ExportedHandler<Env>;

type Who = { userId: string; deviceId: string };

/** The JSON calls. The member is the user; the device is listed under them. */
async function route(request: Request, env: Env, url: URL, who: Who): Promise<Response> {
  const body: Record<string, unknown> =
    request.method === "POST" ? await request.json<Record<string, unknown>>().catch(() => ({})) : {};
  const path = url.pathname.slice("/v1".length);
  const device = {
    id: who.deviceId,
    name: String(body.deviceName ?? deviceName(request)),
    platform: platform(body.platform ?? request.headers.get("X-Device-Platform")),
  };
  const newMember = { id: who.userId, name: device.name, platform: device.platform, deviceId: device.id };

  // The spaces this user is in, for the web page's list (and to show that a
  // new phone signed in to an account already has them).
  if (request.method === "GET" && path === "/me/spaces") {
    const { results } = await env.DB.prepare("SELECT space_id FROM space_members WHERE member_id = ?")
      .bind(who.userId)
      .all<{ space_id: string }>();
    const spaces = [];
    for (const { space_id } of results) {
      const info = await spaceInfo(env, space_id, who.userId, device);
      if (info.ok) spaces.push(info.info);
    }
    return Response.json({ user: who.userId, device: who.deviceId, spaces });
  }
  if (request.method === "POST" && path === "/spaces") {
    return reply(await createSpace(env, newMember, String(body.name ?? "").slice(0, 60) || "Groceries"), "info");
  }
  const invite = /^\/invites\/([^/]+)$/.exec(path);
  if (invite && request.method === "GET") return reply(await previewInvite(env, decodeURIComponent(invite[1])), "preview");

  const match = /^\/spaces\/([0-9a-f]{64})(\/.*)?$/.exec(path);
  if (!match) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  const [, spaceId, rest = ""] = match;

  if (request.method === "GET" && rest === "") return reply(await spaceInfo(env, spaceId, who.userId, device), "info");
  if (request.method === "POST" && rest === "/join") {
    return reply(await joinSpace(env, spaceId, String(body.code ?? ""), newMember), "info");
  }
  if (request.method === "POST" && rest === "/leave") return reply(await leaveSpace(env, spaceId, who.userId));
  const remove = /^\/members\/([^/]+)\/remove$/.exec(rest);
  if (request.method === "POST" && remove) {
    return reply(await removeDevice(env, spaceId, who.userId, decodeURIComponent(remove[1])));
  }
  if (request.method === "POST" && rest === "/code/reset") return reply(await resetCode(env, spaceId, who.userId));
  if (request.method === "POST" && rest === "/push") {
    return reply(await pushOps(env, spaceId, who.userId, Array.isArray(body.ops) ? body.ops : []));
  }
  if (request.method === "GET" && rest === "/changes") {
    const since = Number(url.searchParams.get("since") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 0);
    return reply(await changes(env, spaceId, who.userId, since, limit));
  }

  // The web page keeps no store: it reads a collection as documents and
  // writes fields, stamped with the server's clock (what SyncGateway does
  // for a separate web Worker).
  const docs = /^\/docs\/([A-Za-z0-9_.:-]{1,64})$/.exec(rest);
  if (docs) {
    const space = spaceStub(env, spaceId);
    if (!space) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    if (request.method === "GET") {
      const ops = [];
      let since = 0;
      for (;;) {
        const page = await space.changes(who.userId, since, 0);
        if (!page.ok) return reply(page);
        ops.push(...page.ops);
        since = page.version;
        if (!page.more) break;
      }
      return Response.json({ version: since, docs: foldDocs(ops, docs[1], url.searchParams.get("orderBy") ?? undefined) });
    }
    if (request.method === "POST") {
      const writes = (Array.isArray(body.writes) ? body.writes : []) as Write[];
      const ops = stampWrites(writes.map((w) => ({ ...w, c: docs[1] })), await nodeId(who.deviceId), Date.now());
      return reply(await space.push(who.userId, ops));
    }
  }
  return Response.json({ code: "NOT_FOUND" }, { status: 404 });
}

/** A space's Result as HTTP: its value (or one field of it), or its error. */
function reply(result: Result<object>, field?: string): Response {
  if (!result.ok) return Response.json({ code: result.error, reason: result.reason }, { status: STATUS[result.error] ?? 400 });
  const { ok: _, ...value } = result as Record<string, unknown>;
  return Response.json(field ? value[field] : value);
}

function platform(value: unknown): Platform {
  return value === "ios" || value === "android" || value === "other" ? value : "web";
}

/** What the app calls this device (X-Device-Name), or a guess from the
 *  browser's User-Agent. */
function deviceName(request: Request): string {
  const named = decoded(request.headers.get("X-Device-Name") ?? "").trim();
  if (named) return named.slice(0, 60);
  const phone = request.headers.get("X-Device-Platform");
  if (phone === "ios" || phone === "android") return phone === "ios" ? "iPhone" : "Android phone";
  const ua = request.headers.get("User-Agent") ?? "";
  const browser = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** SpaceClient percent-encodes the name, since header values are ASCII. */
function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// -- email codes --------------------------------------------------------------

async function sendCode(env: Env, email: string, code: string) {
  if (env.DEV_OUTBOX === "true") {
    await env.DB.prepare("INSERT INTO dev_outbox (email, code, sent_at) VALUES (?, ?, ?)").bind(email, code, Date.now()).run();
    return;
  }
  if (!env.RESEND_API_KEY) throw new Error("Set RESEND_API_KEY, or DEV_OUTBOX=true while developing");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM ?? "Groceries <codes@example.com>",
      to: email,
      subject: `${code} is your sign-in code`,
      text: `Your sign-in code is ${code}. It works for 5 minutes.`,
    }),
  });
  if (!res.ok) console.log(JSON.stringify({ event: "email_code_failed", status: res.status }));
}

async function outbox(env: Env, url: URL): Promise<Response> {
  if (env.DEV_OUTBOX !== "true") return new Response("Not found", { status: 404 });
  const row = await env.DB.prepare("SELECT code FROM dev_outbox WHERE email = ? ORDER BY sent_at DESC LIMIT 1")
    .bind(url.searchParams.get("email") ?? "")
    .first<{ code: string }>();
  return Response.json({ code: row?.code ?? null });
}
