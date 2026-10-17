import assert from "node:assert/strict";
import { test } from "node:test";

import { browserIds, mountEvents, serverTelemetry } from "./server.ts";

const IID = "a".repeat(32);
const SID = "b".repeat(32);

function binding(status = 204) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  return {
    calls,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(init?.body as string) });
      return new Response(null, { status });
    },
  };
}

const withCookie = (cookie: string, country?: string) => {
  const r = new Request("https://app.test/api/x", { method: "POST", headers: { cookie } });
  if (country) Object.defineProperty(r, "cf", { value: { country } });
  return r;
};

test("browserIds reads the browser sender's cookie and ignores junk", () => {
  assert.deepEqual(browserIds(withCookie(`a=1; flare_ids=${IID}.${SID}`)), { installId: IID, sessionId: SID });
  assert.deepEqual(browserIds(withCookie(`flare_ids=${IID}.`)), { installId: IID, sessionId: "" });
  assert.equal(browserIds(withCookie("flare_ids=nope.x")), null);
  assert.equal(browserIds(undefined), null);
});

test("track joins the browser session and passes on the user and country", async () => {
  const b = binding();
  const t = serverTelemetry({ target: b, appId: "ledgersignal", appKey: "k_test", events: { events: { statement_extracted: { params: { pages: 0 } } } } });
  const pending: Promise<unknown>[] = [];
  await t.track("statement_extracted", { pages: 12 }, { userId: "u1", request: withCookie(`flare_ids=${IID}.${SID}`, "AU"), waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(b.calls.length, 1);
  const { url, headers, body } = b.calls[0];
  assert.equal(new URL(url).pathname, "/v1/events");
  assert.equal(headers.get("x-app-key"), "k_test");
  assert.equal(body.context.platform, "server");
  assert.equal(body.context.install_id, IID);
  assert.equal(body.context.country, "AU");
  assert.deepEqual(body.events[0].params, { pages: 12 });
  assert.equal(body.events[0].session_id, SID);
  assert.equal(body.events[0].user_id, "u1");
});

test("without a browser it's install 'server'; a failed send doesn't throw", async () => {
  const t = serverTelemetry({
    target: { fetch: async () => { throw new Error("down"); } },
    appId: "x", appKey: "k",
  });
  await t.track("job_done", { n: 1 });
  await t.reportError(new Error("boom"));
  const b = binding();
  await serverTelemetry({ target: b, appId: "x", appKey: "k" }).reportError(new TypeError("bad"));
  assert.equal(b.calls[0].body.context.install_id, "server");
  assert.equal(b.calls[0].body.events[0].name, "error");
  assert.equal(b.calls[0].body.events[0].params.type, "TypeError");
});

test("mountEvents forwards the batch with the visitor's country and the Worker's status", async () => {
  const b = binding(401);
  const req = new Request("https://app.test/api/events", {
    method: "POST",
    headers: { "x-app-key": "k_test" },
    body: JSON.stringify({ context: { app_id: "x", country: "XX" }, sent_at: 1, events: [] }),
  });
  Object.defineProperty(req, "cf", { value: { country: "AU" } });
  const res = await mountEvents(req, b);
  assert.equal(res.status, 401);
  assert.equal(b.calls[0].headers.get("x-app-key"), "k_test");
  assert.equal(b.calls[0].body.context.country, "AU");
  assert.equal((await mountEvents(new Request("https://app.test/api/events"), b)).status, 405);
});
