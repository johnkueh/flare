import { describe, expect, it } from "vitest";
import { Client } from "./helpers";

// The example end to end, through the Worker: sign in, share a list, and
// keep it when an anonymous phone signs in to an account or a new phone
// signs in to the same one.

describe("first launch", () => {
  it("signs a phone in anonymously and lets it make a list", async () => {
    const phone = new Client("Mia's iPhone");
    const user = await phone.signInAnonymously();
    expect(user.isAnonymous).toBe(true);

    const list = await phone.createList("Weekly shop");
    expect(list.you).toBe(user.id);
    expect(list.owner).toBe(user.id);
    await phone.addItem(list.spaceId, "milk", "Milk");
    expect(await phone.items(list.spaceId)).toEqual(["Milk"]);
    expect((await phone.me()).spaces.map((s) => s.name)).toEqual(["Weekly shop"]);
  });

  it("refuses the lists to anyone signed out", async () => {
    const res = await new Client("Nobody").call("GET", "/v1/me/spaces");
    expect(res.status).toBe(401);
  });
});

describe("sharing", () => {
  it("lets a second person join by code and see the same items", async () => {
    const mia = new Client("Mia's iPhone");
    await mia.signInAnonymously();
    const list = await mia.createList("Shared");
    await mia.addItem(list.spaceId, "eggs", "Eggs");

    const sam = new Client("Chrome on Mac", "web");
    const samUser = await sam.signInWithEmail("sam@example.com");
    expect(samUser.isAnonymous).toBeFalsy();
    const preview = await sam.call("GET", `/v1/invites/${list.code}`);
    expect(preview.body.spaceId).toBe(list.spaceId);
    const joined = await sam.call("POST", `/v1/spaces/${list.spaceId}/join`, { code: list.code });
    expect(joined.status).toBe(200);
    expect(await sam.items(list.spaceId)).toEqual(["Eggs"]);

    await sam.addItem(list.spaceId, "bread", "Bread");
    expect(((await mia.items(list.spaceId)) as string[]).sort()).toEqual(["Bread", "Eggs"]);

    const info = (await mia.call("GET", `/v1/spaces/${list.spaceId}`)).body;
    expect(info.devices.map((m: { id: string }) => m.id).sort()).toEqual([info.you, samUser.id].sort());
  });

  it("keeps people who aren't members out", async () => {
    const mia = new Client("Mia's iPhone");
    await mia.signInAnonymously();
    const list = await mia.createList("Private");
    const stranger = new Client("Stranger");
    await stranger.signInAnonymously();
    expect(await stranger.items(list.spaceId)).toBe(403);
  });
});

describe("accounts", () => {
  it("moves an anonymous phone's lists to the account it signs in to", async () => {
    const phone = new Client("Ava's iPhone");
    const anonymous = await phone.signInAnonymously();
    const list = await phone.createList("Before signing in");
    await phone.addItem(list.spaceId, "rice", "Rice");
    const before = phone.token;

    const user = await phone.signInWithEmail("ava@example.com");
    expect(user.id).not.toBe(anonymous.id);
    const me = await phone.me();
    expect(me.user).toBe(user.id);
    expect(me.spaces.map((s) => s.spaceId)).toEqual([list.spaceId]);
    expect(await phone.items(list.spaceId)).toEqual(["Rice"]);

    const info = (await phone.call("GET", `/v1/spaces/${list.spaceId}`)).body;
    expect(info.owner).toBe(user.id);
    expect(info.devices.map((m: { id: string }) => m.id)).toEqual([user.id]);

    // The anonymous user's token is gone with it.
    phone.token = before;
    expect((await phone.call("GET", "/v1/me/spaces")).status).toBe(401);
  });

  it("gives a new phone signed in to the same account every list, listed under the person", async () => {
    const old = new Client("Old iPhone");
    await old.signInWithEmail("leo@example.com");
    const list = await old.createList("Leo's list");
    await old.addItem(list.spaceId, "tea", "Tea");

    const fresh = new Client("Pixel 9", "android");
    await fresh.signInWithEmail("leo@example.com");
    const me = await fresh.me();
    expect(me.spaces.map((s) => s.spaceId)).toEqual([list.spaceId]);
    expect(await fresh.items(list.spaceId)).toEqual(["Tea"]);

    const info = (await fresh.call("GET", `/v1/spaces/${list.spaceId}`)).body;
    expect(info.devices).toHaveLength(1);
    expect(info.devices[0].devices.map((d: { name: string }) => d.name).sort()).toEqual(["Old iPhone", "Pixel 9"].sort());
  });

  it("merges an anonymous phone into an account that's already in the same list", async () => {
    const zoe = new Client("Zoe's laptop", "web");
    const account = await zoe.signInWithEmail("zoe@example.com");
    const list = await zoe.createList("Flat");

    // Zoe's new phone joins as an anonymous user, then signs in.
    const phone = new Client("Zoe's iPhone");
    await phone.signInAnonymously();
    expect((await phone.call("POST", `/v1/spaces/${list.spaceId}/join`, { code: list.code })).status).toBe(200);
    const ownList = await phone.createList("Phone only");
    await phone.signInWithEmail("zoe@example.com");

    const me = await phone.me();
    expect(me.user).toBe(account.id);
    expect(me.spaces.map((s) => s.spaceId).sort()).toEqual([list.spaceId, ownList.spaceId].sort());
    const info = (await phone.call("GET", `/v1/spaces/${list.spaceId}`)).body;
    expect(info.devices.map((m: { id: string }) => m.id)).toEqual([account.id]);
  });
});

describe("dev outbox", () => {
  it("is off unless DEV_OUTBOX is on", async () => {
    // wrangler.jsonc turns it on for development; the check is the Worker's.
    const res = await new Client("x").call("GET", "/dev/outbox?email=none@example.com");
    expect(res.body).toEqual({ code: null });
  });
});
