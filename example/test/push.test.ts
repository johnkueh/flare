// Push in the example Worker: phones register their tokens, and adding to a
// shared list notifies the other members' phones, but not the sender's.
// APNs and FCM are fakes here; the wire format is tested in push/.

import { env } from "cloudflare:test";
import { flarePush, type PushMessage } from "@flare/push";
import { notifySpace } from "@flare/push/spaces";
import { describe, expect, it } from "vitest";
import notifications from "../notifications.json";
import { Client } from "./helpers";

const IOS_TOKEN = "a1".repeat(32);
const ANDROID_TOKEN = "fcm:android-token-0123456789";

async function register(client: Client, body: Record<string, unknown>) {
  const res = await client.call("PUT", "/v1/push/device", body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function rows(...members: string[]) {
  const { results } = await env.DB.prepare(
    `SELECT device_id, member_id, platform, token, permission FROM push_tokens WHERE member_id IN (${members.map(() => "?").join(",")}) ORDER BY platform`,
  )
    .bind(...members)
    .all();
  return results;
}

/** A throwaway APNs key, PEM like a .p8 file. */
async function apnsKey() {
  const key = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", key.privateKey)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
}

/** The example's push, sending inline (no queue) to a fake APNs. */
async function fakePush(answer: () => Response = () => new Response(null, { status: 200 })) {
  const sent: string[] = [];
  const push = flarePush(
    { ...env, PUSH_QUEUE: undefined, APNS_KEY_P8: await apnsKey(), APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_TOPICS: "com.example.groceries" },
    {
      notifications,
      log: () => {},
      fetch: async (input) => {
        sent.push(String(input));
        return answer();
      },
    },
  );
  return { push, sent };
}

describe("push", () => {
  it("registers a device under its user, and moves it when the token changes hands", async () => {
    const sam = new Client("Sam's iPhone");
    const user = await sam.signInAnonymously();
    expect((await sam.call("PUT", "/v1/push/device", { platform: "ios", token: "nope" })).status).toBe(400);
    await register(sam, { platform: "ios", token: IOS_TOKEN, apnsEnv: "sandbox", permission: "quiet" });
    expect(await rows(user.id)).toEqual([expect.objectContaining({ platform: "ios", token: IOS_TOKEN, permission: "quiet" })]);

    // Reinstalled: a new user and device with the same token; the old row goes.
    const again = new Client("Sam's iPhone");
    const reinstalled = await again.signInAnonymously();
    await register(again, { platform: "ios", token: IOS_TOKEN, permission: "allowed" });
    expect(await rows(user.id)).toEqual([]);
    expect(await rows(reinstalled.id)).toEqual([expect.objectContaining({ permission: "allowed" })]);

    expect((await again.call("DELETE", "/v1/push/device")).status).toBe(200);
    expect(await rows(reinstalled.id)).toEqual([]);
    expect((await new Client("x").call("PUT", "/v1/push/device", { platform: "ios", token: IOS_TOKEN })).status).toBe(401);
  });

  it("keeps the device when the anonymous user signs in to an account", async () => {
    const phone = new Client("Leo's Pixel", "android");
    const anonymous = await phone.signInAnonymously();
    await register(phone, { platform: "android", token: "fcm:leo-token-0123456789" });
    const account = await phone.signInWithEmail("leo-push@example.com");
    expect(await rows(anonymous.id)).toEqual([]);
    expect(await rows(account.id)).toEqual([expect.objectContaining({ platform: "android" })]);
  });

  it("notifies the list's other members, not the sender, and skips blocked or muted devices", async () => {
    const sam = new Client("Sam's iPhone");
    await sam.signInAnonymously();
    const list = await sam.createList("Flat");
    await register(sam, { platform: "ios", token: "b2".repeat(32) });

    const mia = new Client("Mia's Pixel", "android");
    const miaUser = await mia.signInAnonymously();
    expect((await mia.call("POST", `/v1/spaces/${list.spaceId}/join`, { code: list.code })).status).toBe(200);
    await register(mia, { platform: "android", token: ANDROID_TOKEN });

    const leo = new Client("Leo's iPhone");
    await leo.signInAnonymously();
    expect((await leo.call("POST", `/v1/spaces/${list.spaceId}/join`, { code: list.code })).status).toBe(200);
    await register(leo, { platform: "ios", token: "c3".repeat(32), permission: "blocked" });

    const samMe = await sam.me();
    const { push } = await fakePush();
    const queued = await notifySpace(env, push, list.spaceId, { from: samMe.user, except: samMe.device }, "item_added", {
      list: "Flat",
      actor: "Sam",
      item: "milk",
    });
    expect(queued.map((m: PushMessage) => [m.platform, m.title, m.body])).toEqual([["android", "Flat", "Sam added milk"]]);
    expect(queued[0]).toMatchObject({ collapseId: `item_added:${list.spaceId}`, channel: "list", data: { item: "milk" } });

    // Mia switches the list channel off in Android's settings.
    await register(mia, { platform: "android", token: ANDROID_TOKEN, mutedChannels: ["list"] });
    expect(await notifySpace(env, push, list.spaceId, { from: samMe.user }, "item_added", { item: "eggs" })).toEqual([]);

    // Someone outside the list can't notify it.
    expect(await notifySpace(env, push, list.spaceId, { from: miaUser.id.replace(/.$/, "x") }, "item_added", {})).toEqual([]);
  });

  it("sends inline without a queue, and deletes a token APNs says is gone", async () => {
    const sam = new Client("Sam's iPhone");
    const user = await sam.signInAnonymously();
    await register(sam, { platform: "ios", token: "d4".repeat(32), apnsEnv: "sandbox" });
    const { push, sent } = await fakePush(() => Response.json({ reason: "Unregistered" }, { status: 410 }));
    const [msg] = await push.notify("item_added", { members: [user.id] }, { list: "Flat", actor: "Mia", item: "tea" });
    expect(msg.body).toBe("Mia added tea");
    expect(sent).toEqual([`https://api.sandbox.push.apple.com/3/device/${"d4".repeat(32)}`]);
    expect(await rows(user.id)).toEqual([]);
  });

  it("queues through PUSH_QUEUE when it's bound", async () => {
    const sam = new Client("Sam's iPhone");
    const user = await sam.signInAnonymously();
    await register(sam, { platform: "ios", token: "e5".repeat(32) });
    const sentBatches: unknown[] = [];
    const push = flarePush(
      { ...env, PUSH_QUEUE: { sendBatch: async (b: unknown[]) => void sentBatches.push(b) } as unknown as Queue<PushMessage> },
      { notifications },
    );
    await push.notify("item_added", { devices: [(await sam.me()).device] }, { item: "jam" });
    expect(sentBatches).toEqual([[expect.objectContaining({ contentType: "json", body: expect.objectContaining({ device: expect.any(String) }) })]]);
    expect(await rows(user.id)).toHaveLength(1);
  });
});
