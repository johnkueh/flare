import assert from "node:assert/strict";
import { test } from "node:test";

import { createFlags } from "./client.ts";
import { fileStorage } from "./node.ts";
import schema from "./fixture.flags.json" with { type: "json" };
import { evaluateFlag, evaluateFlags, type FlagshipBinding, flagsHttp } from "./server.ts";

// A stand-in for env.FLAGS: values per flag, optionally per targetingKey.
function fakeFlagship(values: Record<string, unknown | ((ctx: Record<string, unknown>) => unknown)>) {
  const seen: Record<string, unknown>[] = [];
  const details = (type: string) => async (key: string, fallback: unknown, ctx: Record<string, unknown> = {}) => {
    seen.push(ctx);
    if (!(key in values)) return { value: fallback, reason: "ERROR", errorCode: "FLAG_NOT_FOUND", errorMessage: `Flag '${key}' not found` };
    const raw = values[key];
    const value = typeof raw === "function" ? (raw as (c: Record<string, unknown>) => unknown)(ctx) : raw;
    const ok = type === "object" ? typeof value === "object" && value !== null : typeof value === type;
    if (!ok) return { value: fallback, reason: "ERROR", errorCode: "TYPE_MISMATCH" };
    return { value, reason: "TARGETING_MATCH", variant: String(value) };
  };
  const binding = {
    getBooleanDetails: details("boolean"),
    getStringDetails: details("string"),
    getNumberDetails: details("number"),
    getObjectDetails: details("object"),
  } as unknown as FlagshipBinding;
  return { binding, seen, values };
}

function worker(values: Parameters<typeof fakeFlagship>[0], extra: Partial<Parameters<typeof flagsHttp>[1]> = {}) {
  const fake = fakeFlagship(values);
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = flagsHttp(new Request(input, init), { binding: fake.binding, flags: schema, ...extra });
    return res ?? new Response("not found", { status: 404 });
  };
  return { ...fake, fetch: fetch as typeof globalThis.fetch };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://api.test/ofrep/v1/evaluate/flags", { method: "POST", body: JSON.stringify(body), headers });

test("the endpoint evaluates every flag in flags.json", async () => {
  const w = worker({ "new-checkout": true, "upload-limit": 25, "checkout-copy": "Pay", paywall: { price: "2.99" } });
  const res = await flagsHttp(post({ context: { targetingKey: "u1", platform: "ios", plan: "pro" } }), { binding: w.binding, flags: schema })!;
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("etag"));
  const body = (await res.json()) as { flags: { key: string; value?: unknown; errorCode?: string }[] };
  const byKey = Object.fromEntries(body.flags.map((f) => [f.key, f]));
  assert.equal(byKey["new-checkout"].value, true);
  assert.equal(byKey["upload-limit"].value, 25);
  assert.deepEqual(byKey.paywall.value, { price: "2.99" });
  assert.equal(byKey["kill-import"].errorCode, "FLAG_NOT_FOUND");
  // Only trusted attributes reach Flagship.
  assert.deepEqual(w.seen[0], { targetingKey: "u1", platform: "ios" });
});

test("same values: 304 on the ETag", async () => {
  const w = worker({ "upload-limit": 25 });
  const first = await flagsHttp(post({}), { binding: w.binding, flags: schema })!;
  const etag = first.headers.get("etag")!;
  const again = await flagsHttp(post({}, { "if-none-match": etag }), { binding: w.binding, flags: schema })!;
  assert.equal(again.status, 304);
  w.values["upload-limit"] = 30;
  const changed = await flagsHttp(post({}, { "if-none-match": etag }), { binding: w.binding, flags: schema })!;
  assert.equal(changed.status, 200);
});

test("other routes pass through; prefix, single flag, CORS, wrong method", async () => {
  const w = worker({ "upload-limit": 2.5 });
  const opts = { binding: w.binding, flags: schema, prefix: "/v1", cors: "*" as const };
  assert.equal(flagsHttp(new Request("https://api.test/v1/spaces"), opts), null);
  assert.equal(flagsHttp(post({}), opts), null);
  const one = await flagsHttp(new Request("https://api.test/v1/ofrep/v1/evaluate/flags/upload-limit", { method: "POST", body: "{}" }), opts)!;
  assert.equal(one.status, 400, "2.5 isn't a whole number");
  assert.equal(((await one.json()) as { errorCode: string }).errorCode, "TYPE_MISMATCH");
  const missing = await flagsHttp(new Request("https://api.test/v1/ofrep/v1/evaluate/flags/nope", { method: "POST", body: "{}" }), opts)!;
  assert.equal(missing.status, 404);
  const pre = await flagsHttp(new Request("https://api.test/v1/ofrep/v1/evaluate/flags", { method: "OPTIONS", headers: { origin: "https://web.test" } }), opts)!;
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  const get = await flagsHttp(new Request("https://api.test/v1/ofrep/v1/evaluate/flags"), opts)!;
  assert.equal(get.status, 405);
});

test("the app's context hook decides who is evaluated", async () => {
  const w = worker({ "new-checkout": (ctx: Record<string, unknown>) => ctx.plan === "pro" });
  const res = await flagsHttp(post({ context: { targetingKey: "spoofed", plan: "pro" } }), {
    binding: w.binding,
    flags: schema,
    context: ({ defaults }) => ({ ...defaults, targetingKey: "real-user", plan: "free" }),
  })!;
  const body = (await res.json()) as { flags: { key: string; value?: unknown }[] };
  assert.equal(body.flags.find((f) => f.key === "new-checkout")?.value, false);
  assert.equal(w.seen[0].targetingKey, "real-user");
});

test("server-side reads are typed and fall back to defaults", async () => {
  const w = worker({ "new-checkout": true, "checkout-copy": 3 });
  const all = await evaluateFlags(w.binding, schema, { targetingKey: "u1" });
  const b: boolean = all["new-checkout"];
  const n: number = all["upload-limit"];
  assert.equal(b, true);
  assert.equal(n, 10);
  assert.equal(all["checkout-copy"], "Buy now");
  const copy: string = await evaluateFlag(w.binding, schema, "checkout-copy");
  assert.equal(copy, "Buy now");
});

test("client: defaults, then server values; read flags wait, live ones don't", async () => {
  const w = worker({ "new-checkout": true, "upload-limit": 25, "kill-import": true });
  const flags = createFlags({ server: "https://api.test", flags: schema, fetch: w.fetch, refreshOnStart: false, refreshInterval: 0 });
  const before: boolean = flags.get("new-checkout");
  assert.equal(before, false);
  let told: string[] = [];
  flags.subscribe((keys) => (told = keys));
  const changed = await flags.refresh();
  assert.deepEqual(changed.sort(), ["kill-import", "upload-limit"]);
  assert.deepEqual(told.sort(), ["kill-import", "upload-limit"]);
  assert.equal(flags.get("new-checkout"), false, "on screen, so it waits");
  assert.equal(flags.get("upload-limit"), 25);
  assert.equal(flags.get("kill-import"), true);
  assert.deepEqual(flags.activate(), ["new-checkout"]);
  assert.equal(flags.get("new-checkout"), true);
  assert.equal(flags.get("paywall").trialDays, 7);
  assert.ok(flags.fetchedAt);
});

test("client: offline keeps last-known values, and they survive a restart", async () => {
  const w = worker({ "upload-limit": 25 });
  const path = `${process.env.TMPDIR ?? "/tmp"}/flare-flags-test-${process.pid}.json`;
  const first = createFlags({ server: "https://api.test", flags: schema, fetch: w.fetch, storage: fileStorage(path), refreshInterval: 0 });
  await first.ready;
  assert.equal(first.get("upload-limit"), 25);
  const id = first.identity;

  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const second = createFlags({ server: "https://api.test", flags: schema, fetch: offline, storage: fileStorage(path), refreshInterval: 0 });
  await second.ready;
  assert.equal(second.identity, id, "same install id");
  assert.equal(second.get("upload-limit"), 25, "last known value");
  assert.match(second.lastError?.message ?? "", /fetch failed/);
});

test("client: 304 and server errors keep values; users get their own", async () => {
  const w = worker({ "upload-limit": (ctx: Record<string, unknown>) => (ctx.targetingKey === "u1" ? 50 : 25) });
  let calls = 0;
  const counting = (async (i: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    return w.fetch(i, init);
  }) as typeof fetch;
  const flags = createFlags({ server: "https://api.test", flags: schema, fetch: counting, storage: null, refreshInterval: 0 });
  await flags.ready;
  assert.equal(flags.get("upload-limit"), 25);
  assert.deepEqual(await flags.refresh(), []);
  assert.equal(calls, 2);
  const switching = flags.setUser("u1");
  assert.equal(flags.get("upload-limit"), 10, "the default until u1's values arrive");
  assert.deepEqual(await switching, ["upload-limit"]);
  assert.equal(flags.get("upload-limit"), 50);
  assert.equal(flags.identity, "u1");

  const broken = createFlags({
    server: "https://api.test",
    flags: schema,
    fetch: (async () => new Response("no", { status: 503 })) as typeof fetch,
    refreshInterval: 0,
  });
  await broken.ready;
  assert.equal(broken.get("upload-limit"), 10);
  assert.match(broken.lastError?.message ?? "", /503/);
});

test("bad flags.json fails fast", () => {
  assert.throws(() => createFlags({ server: "", flags: { flags: { "1x": { default: 1 } } } }), /keys start with a letter/);
  assert.throws(() => createFlags({ server: "", flags: { flags: { x: {} as never } } }), /needs a "default"/);
});
