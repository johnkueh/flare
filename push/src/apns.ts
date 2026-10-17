// Apple Push Notification service, token-based (a .p8 key).
//
// APNs speaks HTTP/2 only. workerd itself doesn't, but deployed Workers
// reach Apple through Cloudflare's proxy, which upgrades the request
// (cloudflare/workerd#4841). `wrangler dev` can't reach APNs: test against
// a deployed Worker.

import { importKey, signJwt } from "./jwt.ts";
import type { PushMessage, SendResult } from "./message.ts";

export interface ApnsConfig {
  /** The .p8 file's contents. */
  key: string;
  keyId: string;
  teamId: string;
  /** Bundle ids this Worker may send to; the first is the default topic. */
  topics: string[];
}

const HOST = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" } as const;

// Apple refuses a provider token older than an hour and throttles one
// renewed more often than every 20 minutes.
const TOKEN_TTL_MS = 40 * 60 * 1000;

let cached: { keyId: string; jwt: string; at: number } | null = null;

export function resetApnsToken() {
  cached = null;
}

async function providerToken(config: ApnsConfig, now: number): Promise<string> {
  if (cached && cached.keyId === config.keyId && now - cached.at < TOKEN_TTL_MS) return cached.jwt;
  const key = await importKey("ES256", config.key);
  const jwt = await signJwt("ES256", key, { kid: config.keyId }, { iss: config.teamId, iat: Math.floor(now / 1000) });
  cached = { keyId: config.keyId, jwt, at: now };
  return jwt;
}

/** The JSON Apple gets. The app reads `data` from the notification's userInfo. */
export function apnsPayload(message: PushMessage): object {
  return {
    aps: {
      alert: { title: message.title, body: message.body },
      ...(message.sound && { sound: "default" }),
      ...(message.threadId && { "thread-id": message.threadId }),
      "interruption-level": message.interruption,
      // Lets a Notification Service Extension change it (images).
      "mutable-content": 1,
    },
    key: message.key,
    data: message.data,
  };
}

const GONE = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered", "ExpiredToken"]);
const STALE_PROVIDER_TOKEN = new Set(["ExpiredProviderToken", "InvalidProviderToken"]);

export async function sendApns(
  config: ApnsConfig,
  message: PushMessage,
  options: { fetch?: typeof fetch; now?: number } = {},
): Promise<SendResult> {
  const doFetch = options.fetch ?? fetch;
  const topic = message.appId && config.topics.includes(message.appId) ? message.appId : config.topics[0];
  if (!topic) return { status: "failed", reason: "no APNs topic" };
  const host = HOST[message.apnsEnv ?? "production"];

  let jwt: string;
  try {
    jwt = await providerToken(config, options.now ?? Date.now());
  } catch (e) {
    return { status: "failed", reason: `APNs key: ${e instanceof Error ? e.message : String(e)}` };
  }
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": topic,
    "apns-push-type": "alert",
    "apns-priority": message.interruption === "passive" ? "5" : "10",
    "content-type": "application/json",
  };
  if (message.collapseId) headers["apns-collapse-id"] = message.collapseId.slice(0, 64);

  let res: Response;
  try {
    res = await doFetch(`${host}/3/device/${message.token}`, { method: "POST", headers, body: JSON.stringify(apnsPayload(message)) });
  } catch (e) {
    return { status: "retry", reason: `network: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (res.status === 200) return { status: "sent", id: res.headers.get("apns-id") ?? undefined };

  const reason = ((await res.json().catch(() => null)) as { reason?: string } | null)?.reason ?? `HTTP ${res.status}`;
  if (res.status === 410 || GONE.has(reason)) return { status: "gone", reason };
  if (res.status === 403 && STALE_PROVIDER_TOKEN.has(reason)) {
    resetApnsToken();
    return { status: "retry", reason };
  }
  if (res.status === 429 || res.status >= 500) return { status: "retry", reason };
  return { status: "failed", reason };
}
