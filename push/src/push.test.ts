// Wire format and results against fake APNs, FCM and OAuth servers, with
// real keys (made here) so the signatures are checked too.
//
//   pnpm test   (node --test, no Worker needed)

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { resetApnsToken, sendApns } from "./apns.ts";
import { resetFcmToken, sendFcm } from "./fcm.ts";
import { checkNotifications, render } from "./schema.ts";
import { parseDevice } from "./index.ts";
import type { PushMessage } from "./message.ts";

async function pkcs8Pem(key: CryptoKey): Promise<string> {
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key));
  const b64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function verify(alg: "ES256" | "RS256", publicKey: CryptoKey, jwt: string) {
  const [h, c, s] = jwt.split(".");
  const params = alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  const ok = await crypto.subtle.verify(params, publicKey, fromBase64url(s), new TextEncoder().encode(`${h}.${c}`));
  assert.ok(ok, "signature verifies");
  return {
    header: JSON.parse(new TextDecoder().decode(fromBase64url(h))),
    claims: JSON.parse(new TextDecoder().decode(fromBase64url(c))),
  };
}

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fn, calls };
}

const base: PushMessage = {
  v: 1,
  key: "item_added",
  device: "dev-1",
  platform: "ios",
  token: "ab".repeat(32),
  apnsEnv: "sandbox",
  appId: "com.example.groceries.dev",
  title: "Sam",
  body: "Added milk",
  collapseId: "item_added:list-1",
  threadId: "item_added:list-1",
  interruption: "active",
  channel: "list",
  sound: true,
  data: { item: "milk" },
};

describe("APNs", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const config = { key: await pkcs8Pem(pair.privateKey), keyId: "KEY1234567", teamId: "TEAM123456", topics: ["com.example.groceries", "com.example.groceries.dev"] };
  beforeEach(resetApnsToken);

  it("posts a signed alert to the token's host with collapse and topic", async () => {
    const fake = fakeFetch(() => new Response(null, { status: 200, headers: { "apns-id": "abc" } }));
    const result = await sendApns(config, base, { fetch: fake.fn, now: 1_700_000_000_000 });
    assert.deepEqual(result, { status: "sent", id: "abc" });
    const [call] = fake.calls;
    assert.equal(call.url, `https://api.sandbox.push.apple.com/3/device/${base.token}`);
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["apns-topic"], "com.example.groceries.dev");
    assert.equal(headers["apns-collapse-id"], "item_added:list-1");
    assert.equal(headers["apns-push-type"], "alert");
    assert.equal(headers["apns-priority"], "10");
    const { header, claims } = await verify("ES256", pair.publicKey, headers.authorization.replace(/^bearer /, ""));
    assert.deepEqual(header, { alg: "ES256", typ: "JWT", kid: "KEY1234567" });
    assert.deepEqual(claims, { iss: "TEAM123456", iat: 1_700_000_000 });
    const body = JSON.parse(String(call.init.body));
    assert.deepEqual(body.aps.alert, { title: "Sam", body: "Added milk" });
    assert.equal(body.aps["thread-id"], "item_added:list-1");
    assert.equal(body.aps["interruption-level"], "active");
    assert.deepEqual(body.data, { item: "milk" });
  });

  it("reuses the provider token, and defaults the topic and host", async () => {
    const fake = fakeFetch(() => new Response(null, { status: 200 }));
    const other = { ...base, appId: "com.someone.else", apnsEnv: undefined, interruption: "passive" as const, collapseId: undefined };
    await sendApns(config, other, { fetch: fake.fn, now: 1_000_000 });
    await sendApns(config, other, { fetch: fake.fn, now: 1_000_000 + 30 * 60_000 });
    const [a, b] = fake.calls.map((c) => c.init.headers as Record<string, string>);
    assert.equal(fake.calls[0].url.startsWith("https://api.push.apple.com/"), true);
    assert.equal(a["apns-topic"], "com.example.groceries");
    assert.equal(a["apns-priority"], "5");
    assert.equal(a["apns-collapse-id"], undefined);
    assert.equal(a.authorization, b.authorization);
  });

  it("maps Apple's answers", async () => {
    const answer = (status: number, reason: string) => fakeFetch(() => Response.json({ reason }, { status })).fn;
    assert.equal((await sendApns(config, base, { fetch: answer(410, "Unregistered") })).status, "gone");
    assert.equal((await sendApns(config, base, { fetch: answer(400, "BadDeviceToken") })).status, "gone");
    assert.equal((await sendApns(config, base, { fetch: answer(429, "TooManyRequests") })).status, "retry");
    assert.equal((await sendApns(config, base, { fetch: answer(503, "ServiceUnavailable") })).status, "retry");
    assert.equal((await sendApns(config, base, { fetch: answer(403, "ExpiredProviderToken") })).status, "retry");
    assert.equal((await sendApns(config, base, { fetch: answer(400, "PayloadTooLarge") })).status, "failed");
    const down = (async () => {
      throw new Error("reset");
    }) as typeof fetch;
    assert.equal((await sendApns(config, base, { fetch: down })).status, "retry");
  });
});

describe("FCM", async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const account = {
    project_id: "groceries-123",
    client_email: "push@groceries-123.iam.gserviceaccount.com",
    // As it sits in the service account JSON: escaped newlines.
    private_key: (await pkcs8Pem(pair.privateKey)).replace(/\n/g, "\\n"),
  };
  const android: PushMessage = { ...base, platform: "android", token: "fcm-token-0123456789:abc", apnsEnv: undefined, appId: undefined };
  beforeEach(resetFcmToken);

  function google(send: (call: Call) => Response) {
    return fakeFetch((call) =>
      call.url === "https://oauth2.googleapis.com/token" ? Response.json({ access_token: "ya29.token", expires_in: 3600 }) : send(call),
    );
  }

  it("gets an OAuth token with a signed assertion, then sends the message", async () => {
    const fake = google(() => Response.json({ name: "projects/groceries-123/messages/1" }));
    const result = await sendFcm(account, android, { fetch: fake.fn, now: 1_700_000_000_000 });
    assert.deepEqual(result, { status: "sent", id: "projects/groceries-123/messages/1" });
    const [oauth, send] = fake.calls;
    const assertion = new URLSearchParams(String(oauth.init.body)).get("assertion")!;
    const { claims } = await verify("RS256", pair.publicKey, assertion);
    assert.equal(claims.iss, account.client_email);
    assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
    assert.equal(claims.exp - claims.iat, 3600);
    assert.equal(send.url, "https://fcm.googleapis.com/v1/projects/groceries-123/messages:send");
    assert.equal((send.init.headers as Record<string, string>).authorization, "Bearer ya29.token");
    const { message } = JSON.parse(String(send.init.body));
    assert.equal(message.token, android.token);
    assert.deepEqual(message.notification, { title: "Sam", body: "Added milk" });
    assert.deepEqual(message.data, { key: "item_added", item: "milk" });
    assert.equal(message.android.notification.tag, "item_added:list-1");
    assert.equal(message.android.notification.channel_id, "list");
    assert.equal(message.android.priority, "high");
  });

  it("keeps the OAuth token between sends", async () => {
    const fake = google(() => Response.json({ name: "x" }));
    await sendFcm(account, android, { fetch: fake.fn, now: 1_000_000 });
    await sendFcm(account, android, { fetch: fake.fn, now: 1_000_000 + 50 * 60_000 });
    assert.equal(fake.calls.filter((c) => c.url.includes("oauth2")).length, 1);
  });

  it("maps Google's answers", async () => {
    const error = (status: number, code: string, message = "") =>
      google(() =>
        Response.json(
          { error: { status: code, message, details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: code }] } },
          { status },
        ),
      ).fn;
    assert.equal((await sendFcm(account, android, { fetch: error(404, "UNREGISTERED") })).status, "gone");
    assert.equal((await sendFcm(account, android, { fetch: error(400, "INVALID_ARGUMENT", "The registration token is not a valid FCM registration token") })).status, "gone");
    assert.equal((await sendFcm(account, android, { fetch: error(400, "INVALID_ARGUMENT", "Invalid JSON payload") })).status, "failed");
    assert.equal((await sendFcm(account, android, { fetch: error(429, "QUOTA_EXCEEDED") })).status, "retry");
    assert.equal((await sendFcm(account, android, { fetch: error(503, "UNAVAILABLE") })).status, "retry");
    assert.equal((await sendFcm(account, android, { fetch: error(401, "UNAUTHENTICATED") })).status, "retry");
  });
});

describe("notifications.json", () => {
  it("renders templates", () => {
    assert.equal(render("{{actor}} added {{ item }}{{missing}}", { actor: "Sam", item: "milk" }), "Sam added milk");
    assert.equal(render("{{n}} left", { n: 3 }), "3 left");
  });

  it("finds problems", () => {
    assert.deepEqual(checkNotifications({ channels: { list: { name: "List" } }, notifications: { item_added: { title: "a", body: "b", channel: "list" } } }), []);
    const problems = checkNotifications({
      notifications: { "Bad-Key": { title: "a", body: "b" }, ok: { title: "a", body: "b", channel: "nope", interruption: "loud" as never } },
    });
    assert.equal(problems.length, 3);
  });
});

describe("device registration body", () => {
  it("accepts and normalises", () => {
    const ios = parseDevice({ platform: "ios", token: "AB".repeat(32), permission: "quiet", appId: "com.example.app" });
    assert.deepEqual(ios, {
      platform: "ios",
      token: "ab".repeat(32),
      apnsEnv: "production",
      appId: "com.example.app",
      permission: "quiet",
      mutedChannels: [],
      locale: null,
    });
    const droid = parseDevice({ platform: "android", token: "fcm-token-0123456789:abc", mutedChannels: ["list", 3] });
    assert.equal(typeof droid === "object" && droid.mutedChannels.join(), "list");
  });

  it("refuses junk", () => {
    assert.equal(typeof parseDevice(null), "string");
    assert.equal(typeof parseDevice({ platform: "web", token: "x" }), "string");
    assert.equal(typeof parseDevice({ platform: "ios", token: "not hex" }), "string");
    assert.equal(typeof parseDevice({ platform: "ios", token: "ab".repeat(32), permission: "maybe" }), "string");
  });
});
