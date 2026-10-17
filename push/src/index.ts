// Push notifications for a Flare app's Worker (PUSH.md).
//
//   const push = flarePush(env, { notifications, identify });
//   const res = push.http(request);          // PUT/DELETE /v1/push/device
//   if (res) return res;
//   await push.notify("item_added", { members: [mia] }, { actor: "Sam", item: "milk" }, { scope: listId });
//
//   export default { fetch, queue: (batch, env) => flarePush(env, { notifications }).queue(batch) };
//
// Tokens live in the app's own D1 (migrations/push_tokens.sql), keyed by
// the same device id sync uses, so apps without accounts work too. Sends go
// through a Queue straight to APNs and FCM.

import { type ApnsConfig, sendApns } from "./apns.ts";
import { type FcmServiceAccount, sendFcm } from "./fcm.ts";
import type { PushMessage, PushPlatform, SendResult } from "./message.ts";
import { channelOf, checkNotifications, type Data, type NotificationKey, type NotificationsFile, render } from "./schema.ts";

export { apnsPayload, resetApnsToken, sendApns, type ApnsConfig } from "./apns.ts";
export { fcmPayload, resetFcmToken, sendFcm, type FcmServiceAccount } from "./fcm.ts";
export type { PushMessage, PushPlatform, SendResult } from "./message.ts";
export { checkNotifications, render, type Data, type NotificationKey, type NotificationsFile } from "./schema.ts";

export interface PushEnv {
  DB: D1Database;
  /** Where notify() puts messages. Without it they're sent right away. */
  PUSH_QUEUE?: Queue<PushMessage>;
  /** The APNs .p8 key's contents, its key id and your team id. */
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  /** Comma-separated bundle ids (e.g. "com.example.app,com.example.app.dev"); the first is the default. */
  APNS_TOPICS?: string;
  /** The Firebase service account JSON. */
  FCM_SERVICE_ACCOUNT?: string;
}

export type Permission = "allowed" | "quiet" | "blocked" | "not_asked";

/** Who a request is: the device, and the member it belongs to (the user,
 *  or before accounts the device itself). */
export type Identity = { device: string; member: string };

export interface FlarePushOptions<F extends NotificationsFile> {
  /** The app's notifications.json. */
  notifications: F;
  /** For `http()`: who the request is, or the response refusing it. */
  identify?: (request: Request) => Promise<Identity | Response>;
  /** Where the routes are mounted. Default "/v1". */
  prefix?: string;
  /** For tests: what APNs, FCM and Google's OAuth are reached with. */
  fetch?: typeof fetch;
  /** One JSON line per send result. Default console.log. */
  log?: (event: Record<string, unknown>) => void;
}

export type Recipients = { devices: string[] } | { members: string[] };

export interface NotifyOptions {
  /** What collapsing is per (a list, a chat): `key:scope` becomes the
   *  collapse id and the iOS thread id. Default: the key alone. */
  scope?: string;
  /** A device not to notify, typically the one that made the change. */
  except?: string;
}

type TokenRow = {
  device_id: string;
  member_id: string;
  platform: PushPlatform;
  token: string;
  apns_env: "sandbox" | "production" | null;
  app_id: string | null;
  permission: Permission;
  muted_channels: string;
};

const PERMISSIONS: readonly string[] = ["allowed", "quiet", "blocked", "not_asked"];
const MAX_RECIPIENTS = 500;

export function flarePush<F extends NotificationsFile>(env: PushEnv, options: FlarePushOptions<F>) {
  const problems = checkNotifications(options.notifications);
  if (problems.length) throw new Error(`notifications.json: ${problems.join("; ")}`);
  const prefix = options.prefix ?? "/v1";
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));

  /** PUT and DELETE `{prefix}/push/device`, or null for any other route. */
  function http(request: Request): Promise<Response> | null {
    if (new URL(request.url).pathname !== `${prefix}/push/device`) return null;
    return handle(request);
  }

  async function handle(request: Request): Promise<Response> {
    if (!options.identify) throw new Error("flarePush: pass identify to serve http()");
    if (request.method !== "PUT" && request.method !== "DELETE") return new Response("Method not allowed", { status: 405 });
    const who = await options.identify(request);
    if (who instanceof Response) return who;
    if (request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM push_tokens WHERE device_id = ?").bind(who.device).run();
      return Response.json({ ok: true });
    }
    const body = await request.json<Record<string, unknown>>().catch(() => null);
    const device = parseDevice(body);
    if (typeof device === "string") return Response.json({ code: "INVALID_DEVICE", reason: device }, { status: 400 });
    await env.DB.batch([
      // A token that moved to another device id (a reinstall) leaves its old row.
      env.DB.prepare("DELETE FROM push_tokens WHERE token = ? AND device_id != ?").bind(device.token, who.device),
      env.DB.prepare(
        `INSERT INTO push_tokens (device_id, member_id, platform, token, apns_env, app_id, permission, muted_channels, locale, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET member_id = excluded.member_id, platform = excluded.platform,
           token = excluded.token, apns_env = excluded.apns_env, app_id = excluded.app_id, permission = excluded.permission,
           muted_channels = excluded.muted_channels, locale = excluded.locale, updated_at = excluded.updated_at`,
      ).bind(
        who.device,
        who.member,
        device.platform,
        device.token,
        device.apnsEnv,
        device.appId,
        device.permission,
        JSON.stringify(device.mutedChannels),
        device.locale,
        Date.now(),
      ),
    ]);
    return Response.json({ ok: true });
  }

  /**
   * Renders `key` for each of the recipients' devices that can show it and
   * queues one message per device. Blocked devices, and Android devices
   * with the notification's channel switched off, are skipped. Returns the
   * messages queued.
   */
  async function notify(key: NotificationKey<F>, to: Recipients, data: Data = {}, notifyOptions: NotifyOptions = {}): Promise<PushMessage[]> {
    const spec = options.notifications.notifications[key];
    if (!spec) throw new Error(`notifications.json has no "${key}"`);
    const ids = [...new Set("devices" in to ? to.devices : to.members)].slice(0, MAX_RECIPIENTS);
    if (ids.length === 0) return [];
    const column = "devices" in to ? "device_id" : "member_id";
    const { results } = await env.DB.prepare(
      `SELECT * FROM push_tokens WHERE ${column} IN (${ids.map(() => "?").join(",")}) AND permission != 'blocked'`,
    )
      .bind(...ids)
      .all<TokenRow>();

    const channel = channelOf(options.notifications, key);
    const group = notifyOptions.scope ? `${key}:${notifyOptions.scope}` : key;
    const strings = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
    const messages: PushMessage[] = [];
    for (const row of results) {
      if (row.device_id === notifyOptions.except) continue;
      if (row.platform === "android" && channel && mutedChannels(row).includes(channel)) continue;
      messages.push({
        v: 1,
        key,
        device: row.device_id,
        platform: row.platform,
        token: row.token,
        ...(row.apns_env && { apnsEnv: row.apns_env }),
        ...(row.app_id && { appId: row.app_id }),
        title: render(spec.title, data).slice(0, 200),
        body: render(spec.body, data).slice(0, 1000),
        ...(spec.collapse && { collapseId: group }),
        threadId: group,
        interruption: spec.interruption ?? "active",
        ...(channel && { channel }),
        sound: spec.sound ?? true,
        data: strings,
      });
    }
    if (messages.length === 0) return messages;
    if (env.PUSH_QUEUE) {
      for (let i = 0; i < messages.length; i += 100) {
        await env.PUSH_QUEUE.sendBatch(messages.slice(i, i + 100).map((body) => ({ body, contentType: "json" as const })));
      }
    } else {
      await deliver(messages);
    }
    return messages;
  }

  /** Sends each message, deletes the tokens APNs or FCM says are gone, and
   *  returns each result in order. */
  async function deliver(messages: PushMessage[]): Promise<SendResult[]> {
    return Promise.all(messages.map(send));
  }

  async function send(message: PushMessage): Promise<SendResult> {
    const result = message.platform === "ios" ? await viaApns(message) : await viaFcm(message);
    log({
      event: result.status === "sent" ? "push_sent" : `push_${result.status}`,
      key: message.key,
      platform: message.platform,
      device: message.device,
      ...("reason" in result && { reason: result.reason }),
    });
    if (result.status === "gone") {
      // Only this token: the device may already have registered a new one.
      await env.DB.prepare("DELETE FROM push_tokens WHERE device_id = ? AND token = ?").bind(message.device, message.token).run();
    }
    return result;
  }

  function viaApns(message: PushMessage): Promise<SendResult> {
    const config = apnsConfig(env);
    if (!config) return Promise.resolve({ status: "failed", reason: "APNs isn't configured (APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPICS)" });
    return sendApns(config, message, { fetch: options.fetch });
  }

  function viaFcm(message: PushMessage): Promise<SendResult> {
    const account = fcmAccount(env);
    if (!account) return Promise.resolve({ status: "failed", reason: "FCM isn't configured (FCM_SERVICE_ACCOUNT)" });
    return sendFcm(account, message, { fetch: options.fetch });
  }

  /** The Queue consumer: retries with backoff what APNs or FCM couldn't
   *  take right now, drops the rest once tried. */
  async function queue(batch: MessageBatch<PushMessage>): Promise<void> {
    await Promise.all(
      batch.messages.map(async (msg) => {
        if (msg.body?.v !== 1) return msg.ack();
        const result = await send(msg.body);
        if (result.status === "retry") {
          msg.retry({ delaySeconds: result.after ?? Math.min(300, 5 * 2 ** (msg.attempts - 1)) });
        } else {
          msg.ack();
        }
      }),
    );
  }

  return { http, notify, deliver, queue };
}

export type FlarePush<F extends NotificationsFile> = ReturnType<typeof flarePush<F>>;

/** Moves a member's devices to another member id, as when an anonymous
 *  user signs in to an account (call it next to relinkMember). */
export async function relinkPushMember(env: Pick<PushEnv, "DB">, from: string, to: string): Promise<void> {
  await env.DB.prepare("UPDATE push_tokens SET member_id = ? WHERE member_id = ?").bind(to, from).run();
}

function mutedChannels(row: TokenRow): string[] {
  try {
    const parsed: unknown = JSON.parse(row.muted_channels);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function apnsConfig(env: PushEnv): ApnsConfig | null {
  if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPICS) return null;
  const topics = env.APNS_TOPICS.split(",").map((t) => t.trim()).filter(Boolean);
  return { key: env.APNS_KEY, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topics };
}

function fcmAccount(env: PushEnv): FcmServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try {
    const account = JSON.parse(env.FCM_SERVICE_ACCOUNT) as FcmServiceAccount;
    return account.project_id && account.client_email && account.private_key ? account : null;
  } catch {
    return null;
  }
}

type Device = {
  platform: PushPlatform;
  token: string;
  apnsEnv: "sandbox" | "production" | null;
  appId: string | null;
  permission: Permission;
  mutedChannels: string[];
  locale: string | null;
};

/** The PUT body, or what's wrong with it. */
export function parseDevice(body: Record<string, unknown> | null): Device | string {
  if (!body) return "expected a JSON body";
  const { platform, token, apnsEnv, appId, permission, mutedChannels, locale } = body;
  if (platform !== "ios" && platform !== "android") return "platform is ios or android";
  if (typeof token !== "string") return "token is a string";
  if (platform === "ios" && !/^[0-9a-fA-F]{32,200}$/.test(token)) return "an APNs token is hex";
  if (platform === "android" && !/^[\x21-\x7e]{16,4096}$/.test(token)) return "an FCM token is printable ASCII";
  if (apnsEnv !== undefined && apnsEnv !== null && apnsEnv !== "sandbox" && apnsEnv !== "production") {
    return "apnsEnv is sandbox or production";
  }
  if (permission !== undefined && !PERMISSIONS.includes(permission as string)) return `permission is one of ${PERMISSIONS.join(", ")}`;
  const muted = Array.isArray(mutedChannels) ? mutedChannels.filter((c): c is string => typeof c === "string" && c.length <= 64).slice(0, 50) : [];
  return {
    platform,
    token: platform === "ios" ? token.toLowerCase() : token,
    apnsEnv: platform === "ios" ? ((apnsEnv as Device["apnsEnv"]) ?? "production") : null,
    appId: typeof appId === "string" && appId.length <= 200 ? appId : null,
    permission: (permission as Permission | undefined) ?? "allowed",
    mutedChannels: muted,
    locale: typeof locale === "string" && locale.length <= 35 ? locale : null,
  };
}
