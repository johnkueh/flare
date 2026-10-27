// A shared grocery list on Flare. One Worker serves the whole backend: auth
// (@flare/auth), the spaces (@sync/server), push notifications
// (@flare/push) and a web page (public/). It's
// the smallest app that uses every piece, and what the end-to-end tests
// drive.
//
//   /v1/auth/*                  Better Auth: anonymous, email code, Apple
//   /v1/spaces/...              PROTOCOL.md's calls, as the signed-in user
//   /v1/spaces/{id}/docs/{c}    the web page's reads and writes (as SyncGateway does)
//   /ofrep/v1/evaluate/flags    feature flags from flags.json (@flare/flags)
//   /v1/push/device             this phone's push token (@flare/push)
//   /dev/outbox                 the last email code sent (DEV_OUTBOX only)
//
// A trigger (@sync/server/triggers) files each item under an aisle once its
// name is set, from a phone or the web page alike.

import { authenticate, type FlareAuthEnv, flareAuth, whoIs } from "@flare/auth";
import { type FlagshipBinding, flagsHttp } from "@flare/flags/server";
import { type FlarePush, flarePush, type PushEnv, type PushMessage, relinkPushMember } from "@flare/push";
import { notifySpace } from "@flare/push/spaces";
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
import { syncTriggers, type SyncTriggers, type TriggerMessage } from "@sync/server/triggers";
import flags from "../flags.json";
import notifications from "../notifications.json";

export { SpaceObject } from "@sync/server/space";
export { SyncGateway } from "@sync/server/gateway";

export interface Env extends FlareAuthEnv, SpacesEnv, PushEnv {
  SPACE_FILES: R2Bucket;
  ASSETS: Fetcher;
  /** Cloudflare Flagship: the flags in flags.json. */
  FLAGS: FlagshipBinding;
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
        await relinkPushMember(env, anonymousUserId, userId);
      },
      sendEmailCode: async (email, code) => ctx.waitUntil(sendCode(env, email, code)),
      ...(env.APPLE_BUNDLE_ID && { apple: { appBundleIdentifier: env.APPLE_BUNDLE_ID } }),
    });

    if (url.pathname.startsWith("/v1/auth/")) return auth.handler(request);

    // Flags for whoever asks: the signed-in user when there is one, else the
    // id the app or page sent (a random one per install).
    const flagged = flagsHttp(request, {
      binding: env.FLAGS,
      flags,
      context: async ({ request, defaults }) => ({
        ...defaults,
        targetingKey: (await whoIs(auth, request.headers))?.userId ?? defaults.targetingKey,
      }),
    });
    if (flagged) return flagged;
    if (url.pathname === "/dev/outbox") return outbox(env, url);

    const push = flarePush(env, {
      notifications,
      identify: async (r) => {
        const who = await whoIs(auth, r.headers);
        if (!who) return Response.json({ code: "ATTESTATION_REQUIRED", message: "Sign in again." }, { status: 401 });
        return { device: who.deviceId, member: who.userId };
      },
    });
    const pushed = push.http(request);
    if (pushed) return pushed;

    const files = spaceHttp(request, env, { prefix: "/v1", authenticate: (r) => authenticate(auth, r) });
    if (files) return files;
    if (!url.pathname.startsWith("/v1/")) return env.ASSETS.fetch(request);

    const who = await whoIs(auth, request.headers);
    if (!who) return Response.json({ code: "ATTESTATION_REQUIRED", message: "Sign in again." }, { status: 401 });
    return route(request, env, url, who, (spaceId, names) => ctx.waitUntil(notifyAdded(env, push, spaceId, who, request, names)));
  },

  // Two queues: changes the spaces report (triggers), and push
  // notifications queued by notify(), sent to APNs and FCM.
  async queue(batch, env) {
    if (batch.queue === "flare-example-sync-triggers") {
      await syncTriggers(env, triggers).queue(batch as MessageBatch<TriggerMessage>);
    } else {
      await flarePush(env, { notifications }).queue(batch as MessageBatch<PushMessage>);
    }
  },
} satisfies ExportedHandler<Env>;

/** What the server does when items change. */
export const triggers: SyncTriggers<Env> = {
  groceries: {
    // Not "aisle": the trigger's own write doesn't call it again.
    fields: ["name"],
    // Filing is free, and a busy household names more than the default 50
    // items a day.
    limit: { count: 1000, per: "day" },
    async changed({ space, id, doc }) {
      if (typeof doc?.name !== "string") return;
      const aisle = aisleOf(doc.name);
      if (doc.aisle !== aisle) await space.write([{ c: "groceries", d: id, f: "aisle", v: aisle }]);
    },
  },
};

const AISLES: Record<string, string[]> = {
  Produce: ["apple", "banana", "lettuce", "onion", "potato", "tomato", "carrot", "lemon"],
  Dairy: ["milk", "cheese", "yoghurt", "yogurt", "butter", "cream", "eggs"],
  Bakery: ["bread", "rolls", "bagel", "croissant"],
};

/** A rough aisle from an item's name. */
export function aisleOf(name: string): string {
  const lower = name.toLowerCase();
  for (const [aisle, words] of Object.entries(AISLES)) if (words.some((w) => lower.includes(w))) return aisle;
  return "Other";
}

/** Tells the list's other members what was just added. */
async function notifyAdded(env: Env, push: FlarePush<typeof notifications>, spaceId: string, who: Who, request: Request, names: string[]) {
  if (names.length === 0) return;
  const info = await spaceInfo(env, spaceId, who.userId);
  const list = info.ok ? info.info.name : "Groceries";
  const item = names.length === 1 ? names[0] : `${names.length} items`;
  await notifySpace(env, push, spaceId, { from: who.userId, except: who.deviceId }, "item_added", {
    list,
    actor: deviceName(request),
    item,
  });
}

/** The item names a batch of writes or ops sets (new items and renames). */
function addedNames(changes: unknown[]): string[] {
  const names = new Set<string>();
  for (const c of changes) {
    const op = c as { c?: unknown; f?: unknown; v?: unknown };
    if ((op.c === undefined || op.c === "groceries") && op.f === "name" && typeof op.v === "string" && op.v.trim()) names.add(op.v.trim());
  }
  return [...names];
}

type Who = { userId: string; deviceId: string };

/** The JSON calls. The member is the user; the device is listed under them. */
async function route(
  request: Request,
  env: Env,
  url: URL,
  who: Who,
  added: (spaceId: string, names: string[]) => void,
): Promise<Response> {
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
    const ops = Array.isArray(body.ops) ? body.ops : [];
    const result = await pushOps(env, spaceId, who.userId, ops);
    if (result.ok) added(spaceId, addedNames(ops));
    return reply(result);
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
      const result = await space.push(who.userId, ops);
      if (result.ok) added(spaceId, addedNames(ops));
      return reply(result);
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
