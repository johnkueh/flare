import { env, runInDurableObject } from "cloudflare:test";
import { serverWrite } from "@sync/server/spaces";
import type { SpaceObject, SpaceRpc, TriggerMessage } from "@sync/server/space";
import { syncTriggers } from "@sync/server/triggers";
import { describe, expect, it } from "vitest";
import { Client } from "./helpers";

// Triggers end to end: a change from a phone or the web page reaches the
// example's grocery trigger through the queue, and the server's write comes
// back. Then the space's reporting and the consumer, piece by piece.

const NODE = "00000000000000aa";

function stamp(ms: number, counter = 0, node = NODE) {
  return `${String(ms).padStart(15, "0")}-${counter.toString(16).padStart(4, "0")}-${node}`;
}

function setOp(d: string, f: string, v: unknown, ms = Date.now()) {
  return { c: "groceries", d, f, s: "", v, t: stamp(ms) };
}

async function newList(name = "Triggers") {
  const phone = new Client("Mia's iPhone");
  await phone.signInAnonymously();
  const list = await phone.createList(name);
  return { phone, list };
}

async function docs(phone: Client, spaceId: string) {
  const res = await phone.call<{ docs: Record<string, unknown>[] }>("GET", `/v1/spaces/${spaceId}/docs/groceries`);
  return res.body.docs;
}

/** Waits for the queue to deliver and the trigger to write back. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  return read();
}

function stub(spaceId: string) {
  return env.SPACES.get(env.SPACES.idFromString(spaceId)) as unknown as SpaceRpc;
}

/** Swaps the space's queue (its env is protected). */
function bind(space: SpaceObject, queue: unknown) {
  Object.assign((space as unknown as { env: object }).env, { SYNC_TRIGGERS: queue });
}

/** A queue that keeps what it's sent, or refuses while `failing`. */
function fakeQueue() {
  const sent: TriggerMessage[] = [];
  const queue = {
    failing: false,
    sent,
    async send(body: TriggerMessage) {
      if (queue.failing) throw new Error("queue down");
      sent.push(body);
    },
  };
  return queue;
}

describe("the example's trigger", () => {
  it("files an item a phone pushed under its aisle", async () => {
    const { phone, list } = await newList();
    const pushed = await phone.call("POST", `/v1/spaces/${list.spaceId}/push`, { ops: [setOp("milk", "name", "Milk")] });
    expect(pushed.status).toBe(200);
    const found = await eventually(() => docs(phone, list.spaceId), (d) => d[0]?.aisle !== undefined);
    expect(found).toMatchObject([{ id: "milk", name: "Milk", aisle: "Dairy" }]);
  });

  it("files an item the web page wrote, and refiles it when renamed", async () => {
    const { phone, list } = await newList();
    await phone.addItem(list.spaceId, "x", "Bread");
    await eventually(() => docs(phone, list.spaceId), (d) => d[0]?.aisle === "Bakery");
    await phone.call("POST", `/v1/spaces/${list.spaceId}/docs/groceries`, { writes: [{ d: "x", f: "name", v: "Bananas" }] });
    const found = await eventually(() => docs(phone, list.spaceId), (d) => d[0]?.aisle === "Produce");
    expect(found[0]).toMatchObject({ name: "Bananas", aisle: "Produce" });
  });
});

describe("serverWrite", () => {
  it("lands after a phone whose clock runs ahead", async () => {
    const { phone, list } = await newList();
    const ahead = Date.now() + 5 * 60 * 1000;
    await phone.call("POST", `/v1/spaces/${list.spaceId}/push`, { ops: [setOp("eggs", "done", true, ahead)] });
    const result = await serverWrite(env, list.spaceId, [{ c: "groceries", d: "eggs", f: "done", v: false }]);
    expect(result.ok).toBe(true);
    const found = await docs(phone, list.spaceId);
    expect(found.find((d) => d.id === "eggs")?.done).toBe(false);
  });

  it("refuses ops that aren't valid, and spaces that don't exist", async () => {
    const { list } = await newList();
    const bad = await serverWrite(env, list.spaceId, [{ c: "groceries", d: "x", f: "_secret", v: 1 }]);
    expect(bad).toMatchObject({ ok: false, error: "INVALID_OPS" });
    expect(await serverWrite(env, "nope", [])).toMatchObject({ ok: false, error: "NOT_FOUND" });
  });
});

describe("the space's reports", () => {
  it("reports once per burst, from the version before the first change", async () => {
    const { list } = await newList();
    await runInDurableObject(env.SPACES.get(env.SPACES.idFromString(list.spaceId)), async (space: SpaceObject) => {
      const queue = fakeQueue();
      bind(space, queue);
      const before = (space.changes(list.you, 0, 0) as { version: number }).version;
      space.push(list.you, [setOp("a", "name", "Apples")]);
      space.push(list.you, [setOp("b", "name", "Bread")]);
      // Nothing changed: no report needed.
      space.push(list.you, []);
      await space.alarm();
      expect(queue.sent).toEqual([{ spaceId: list.spaceId, from: before, to: before + 2 }]);
      await space.alarm();
      expect(queue.sent).toHaveLength(1);
    });
  });

  it("keeps a failed report and sends it on the next try", async () => {
    const { list } = await newList();
    await runInDurableObject(env.SPACES.get(env.SPACES.idFromString(list.spaceId)), async (space: SpaceObject, state) => {
      const queue = fakeQueue();
      bind(space, queue);
      space.push(list.you, [setOp("a", "name", "Apples")]);
      queue.failing = true;
      await space.alarm();
      expect(queue.sent).toEqual([]);
      expect(await state.storage.getAlarm()).not.toBeNull();
      queue.failing = false;
      await space.alarm();
      expect(queue.sent).toHaveLength(1);
    });
  });

  it("reports nothing without the queue bound", async () => {
    const { list } = await newList();
    await runInDurableObject(env.SPACES.get(env.SPACES.idFromString(list.spaceId)), async (space: SpaceObject, state) => {
      bind(space, undefined);
      await state.storage.deleteAlarm();
      space.push(list.you, [setOp("a", "name", "Apples")]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("keeps a pending report when the last member leaves", async () => {
    const { list } = await newList();
    await runInDurableObject(env.SPACES.get(env.SPACES.idFromString(list.spaceId)), async (space: SpaceObject, state) => {
      const queue = fakeQueue();
      bind(space, queue);
      space.push(list.you, [setOp("a", "name", "Apples")]);
      space.leave(list.you);
      // Let the alarm settle (it may run by itself), then run it to be sure.
      await new Promise((r) => setTimeout(r, 50));
      await space.alarm();
      expect(queue.sent).toHaveLength(1);
      // The empty space's deletion is still scheduled.
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now() + 60_000);
    });
  });
});

describe("changedDocs", () => {
  it("gives merged documents, deleted ones as null, filtered by field", async () => {
    const { list } = await newList();
    const space = stub(list.spaceId);
    await space.push(list.you, [setOp("a", "name", "Apples"), setOp("b", "name", "Bread"), setOp("c", "done", true)]);
    // A second edit to "a" from another device, and "b" deleted.
    const later = Date.now() + 1;
    await space.push(list.you, [
      { c: "groceries", d: "a", f: "done", s: "", v: true, t: stamp(later, 0, "00000000000000bb") },
      { c: "groceries", d: "b", f: "_del", s: "", v: true, t: stamp(later) },
    ]);
    const all = await space.changedDocs(0, 1000, { groceries: null });
    expect(all.ok && all.docs.map((d) => [d.id, d.doc && { name: d.doc.name, done: d.doc.done }])).toEqual([
      ["a", { name: "Apples", done: true }],
      ["b", null],
      ["c", { name: undefined, done: true }],
    ]);
    const named = await space.changedDocs(0, 1000, { groceries: ["name"] });
    expect(named.ok && named.docs.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

describe("syncTriggers", () => {
  it("acks a range its triggers handled and retries one whose trigger threw", async () => {
    const { list } = await newList();
    await stub(list.spaceId).push(list.you, [setOp("a", "name", "Apples")]);
    const seen: string[] = [];
    const outcome: string[] = [];
    const batch = (from: number) =>
      ({
        messages: [
          {
            body: { spaceId: list.spaceId, from, to: 1000 },
            ack: () => outcome.push("ack"),
            retry: () => outcome.push("retry"),
          },
        ],
      }) as unknown as MessageBatch<TriggerMessage>;

    await syncTriggers(env, { groceries: { changed: ({ doc }) => void seen.push(String(doc?.name)) } }).queue(batch(0));
    await syncTriggers(env, { groceries: { changed: () => Promise.reject(new Error("boom")) } }).queue(batch(0));
    // Nothing changed after `from`: no trigger runs.
    await syncTriggers(env, { groceries: { changed: () => Promise.reject(new Error("boom")) } }).queue(batch(1000));
    expect(seen).toEqual(["Apples"]);
    expect(outcome).toEqual(["ack", "retry", "ack"]);
  });
});
