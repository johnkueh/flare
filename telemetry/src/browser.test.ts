// Runs in Node, without a window: the timer, queue, sessions and batches.
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseStack, type TelemetryStorage, telemetry } from "./browser.ts";

const events = { events: { csv_exported: { params: { rows: 0, view: "" } } } } as const;

function setup(status = 204) {
  const store = new Map<string, string>();
  const storage: TelemetryStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) };
  const sent: { url: string; init: RequestInit; body: any }[] = [];
  let code = status;
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(init.body as string) });
    if (code === 0) throw new TypeError("offline");
    return new Response(null, { status: code });
  }) as typeof globalThis.fetch;
  const make = () => telemetry({ appId: "ledgersignal", appKey: "k_test", events, storage, fetch, flushIntervalMs: 60_000, appVersion: "1.2" });
  return { store, storage, sent, make, setStatus: (s: number) => (code = s) };
}

test("first run sends session_start and first_open, then tracked events, in one batch", async () => {
  const s = setup();
  const t = s.make();
  t.identify("user_1");
  t.track("csv_exported", { rows: 12, view: undefined });
  await t.flush();
  t.close();
  assert.equal(s.sent.length, 1);
  const { url, init, body } = s.sent[0];
  assert.equal(url, "/api/events");
  assert.equal((init.headers as Record<string, string>)["x-app-key"], "k_test");
  assert.deepEqual(body.events.map((e: any) => e.name), ["session_start", "first_open", "csv_exported"]);
  assert.deepEqual(body.context, {
    app_id: "ledgersignal", env: "prod", platform: "web", install_id: t.installId,
    app_version: "1.2", app_build: null, os_version: null, device_model: null,
    locale: body.context.locale, sdk: "flare-telemetry-web/0.6.0",
  });
  const e = body.events[2];
  assert.deepEqual(e.params, { rows: 12 });
  assert.equal(e.user_id, "user_1");
  assert.equal(e.session_id, t.sessionId);
  assert.match(t.installId, /^[0-9a-f]{32}$/);
});

test("a second page load keeps the install and session and sends no first_open", async () => {
  const s = setup();
  const a = s.make();
  await a.flush();
  a.close();
  const b = s.make();
  b.track("csv_exported", {});
  await b.flush();
  b.close();
  assert.equal(b.installId, a.installId);
  assert.equal(b.sessionId, a.sessionId);
  assert.deepEqual(s.sent[1].body.events.map((e: any) => e.name), ["csv_exported"]);
});

test("keeps events through offline and 5xx, drops a batch the Worker rejects", async () => {
  const s = setup(0);
  const t = s.make();
  t.track("csv_exported", {});
  await t.flush();
  s.setStatus(503);
  await t.flush();
  s.setStatus(204);
  await t.flush();
  assert.equal(s.sent.length, 3);
  assert.equal(s.sent[2].body.events.length, 3, "nothing lost before the success");
  await t.flush();
  assert.equal(s.sent.length, 3, "queue empty after success");

  s.setStatus(400);
  t.track("csv_exported", {});
  await t.flush();
  s.setStatus(204);
  await t.flush();
  assert.equal(s.sent.length, 4, "a 400 batch isn't retried");
  t.close();
});

test("the queue survives a reload before it's sent", async () => {
  const s = setup(0);
  const a = s.make();
  a.track("csv_exported", { rows: 1 });
  a.close();
  s.setStatus(204);
  const b = s.make();
  await b.flush();
  b.close();
  assert.ok(s.sent.at(-1)?.body.events.some((e: any) => e.name === "csv_exported"));
});

test("bad names are dropped and reportError sends frames and breadcrumbs", async () => {
  const s = setup();
  const t = s.make();
  (t.track as (n: string) => void)("Not Snake");
  t.reportError(new RangeError("boom"));
  await t.flush();
  t.close();
  const names = s.sent[0].body.events.map((e: any) => e.name);
  assert.deepEqual(names, ["session_start", "first_open", "error"]);
  const p = s.sent[0].body.events[2].params;
  assert.equal(p.type, "RangeError");
  assert.equal(p.message, "boom");
  assert.ok(Array.isArray(p.frames));
  assert.deepEqual(p.breadcrumbs.map((c: any) => c.name), ["session_start", "first_open"]);
});

test("parseStack reads Chrome and Safari lines and marks this origin in-app", () => {
  const chrome = "Error: x\n    at save (https://app.test/assets/index-ab12.js:1:2345)\n    at https://cdn.other/lib.js:9:8";
  assert.deepEqual(parseStack(chrome, "https://app.test"), [
    { function: "save", file_line: "/assets/index-ab12.js:1:2345", module: "/assets/index-ab12.js", in_app: true },
    { function: null, file_line: "/lib.js:9:8", module: "/lib.js", in_app: false },
  ]);
  const safari = "save@https://app.test/a.js:3:4";
  assert.equal(parseStack(safari, "https://app.test")[0].function, "save");
});

test("track is typed from events.json", () => {
  const s = setup();
  const t = s.make();
  t.track("csv_exported", { rows: 1, view: "all" });
  t.track("page_view", { path: "/x" });
  // @ts-expect-error not in events.json
  t.track("csv_exportd", {});
  // @ts-expect-error rows is a number
  t.track("csv_exported", { rows: "1" });
  // @ts-expect-error not a declared param
  t.track("csv_exported", { other: 1 });
  t.close();
});

test("pagePath rewrites page_view paths, and a throwing rewrite still sends the view", async () => {
  const s = setup();
  const t = telemetry({
    appId: "ledgersignal",
    appKey: "k_test",
    storage: s.storage,
    fetch: (async (url: string, init: RequestInit) => {
      s.sent.push({ url, init, body: JSON.parse(init.body as string) });
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch,
    flushIntervalMs: 60_000,
    pagePath: (p) => {
      if (p === "/boom") throw new Error("bug");
      return p.replace(/^\/cases\/[^/]+/, "/cases/:slug");
    },
  });
  t.pageView("/cases/smith-pty-ltd/transactions");
  t.pageView("/cases/jones/transactions");
  t.pageView("/boom");
  await t.flush();
  t.close();
  const views = s.sent[0].body.events.filter((e: any) => e.name === "page_view").map((e: any) => e.params.path);
  assert.deepEqual(views, ["/cases/:slug/transactions", "/boom"], "the same rewritten path twice is one view");
});
