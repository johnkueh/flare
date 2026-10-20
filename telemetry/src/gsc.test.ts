import assert from "node:assert/strict";
import { test } from "node:test";

import { daysAgo, type GscApiRow, gscRow, handleGscPull, pullDay } from "./gsc.ts";
import type { Row } from "./rows.ts";

const apiRow = (query: string): GscApiRow => ({ keys: [query, "https://ls.test/a", "aus", "DESKTOP"], clicks: 3, impressions: 40, ctr: 0.075, position: 4.567 });

test("gscRow: one row per keys, stable id, params for SQL", () => {
  const r = gscRow("sc-domain:ls.test", "ledgersignal", "2026-10-14", apiRow("voidable transactions"), "2026-10-17T06:00:00.000Z");
  assert.equal(r.name, "gsc_query");
  assert.equal(r.platform, "search");
  assert.equal(r.client_ts, "2026-10-14T00:00:00.000Z");
  assert.deepEqual(r.params, {
    site: "sc-domain:ls.test", date: "2026-10-14", query: "voidable transactions", page: "https://ls.test/a",
    country: "aus", device: "DESKTOP", clicks: 3, impressions: 40, position: 4.57,
  });
  const again = gscRow("sc-domain:ls.test", "ledgersignal", "2026-10-14", apiRow("voidable transactions"), "later");
  assert.equal(again.event_id, r.event_id);
  assert.notEqual(gscRow("sc-domain:ls.test", "ledgersignal", "2026-10-14", apiRow("other"), "x").event_id, r.event_id);
});

test("daysAgo", () => {
  assert.equal(daysAgo(Date.parse("2026-10-17T06:00:00Z"), 3), "2026-10-14");
});

async function serviceAccount() {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)).toString("base64");
  return JSON.stringify({ client_email: "sa@p.iam.gserviceaccount.com", private_key: `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n` });
}

test("pullDay signs a token, pages through the API and sends rows", async () => {
  const sent: Row[][] = [];
  const calls: { url: string; body: any }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    if (url.includes("oauth2")) {
      const assertion = new URLSearchParams(init.body as string).get("assertion") ?? "";
      assert.equal(assertion.split(".").length, 3);
      return Response.json({ access_token: "tok" });
    }
    const body = JSON.parse(init.body as string);
    calls.push({ url, body });
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer tok");
    const rows = body.startRow === 0 ? Array.from({ length: 25_000 }, (_, i) => apiRow(`q${i}`)) : [apiRow("last")];
    return Response.json({ rows });
  }) as typeof fetch;
  const env = {
    EVENTS: { send: async (rows: Row[]) => void sent.push(rows) },
    GSC_SERVICE_ACCOUNT: await serviceAccount(),
    GSC_SITES: JSON.stringify({ "sc-domain:ls.test": "ledgersignal" }),
  };
  const written = await pullDay(env as never, "2026-10-14", fetcher);
  assert.deepEqual(written, { "sc-domain:ls.test": 25_001 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /sites\/sc-domain%3Als\.test\/searchAnalytics\/query$/);
  assert.deepEqual(calls[0].body.dimensions, ["query", "page", "country", "device"]);
  assert.equal(calls[1].body.startRow, 25_000);
  assert.equal(sent.flat().length, 25_001);
  assert.ok(sent.every((chunk) => chunk.length <= 1000));
});

test("the pull endpoint needs the admin token and a date", async () => {
  const env = { EVENTS: { send: async () => {} }, GSC_ADMIN_TOKEN: "secret" } as never;
  const req = (auth: string, body: unknown) =>
    new Request("https://t/v1/gsc/pull", { method: "POST", headers: { authorization: auth }, body: JSON.stringify(body) });
  assert.equal((await handleGscPull(req("Bearer nope", {}), env)).status, 401);
  assert.equal((await handleGscPull(req("Bearer secret", { date: "yesterday" }), env)).status, 400);
  assert.equal((await handleGscPull(req("Bearer x", {}), { EVENTS: {} } as never)).status, 401);
});

test("pullDay with a site pulls only that property; one failing property doesn't stop the rest", async () => {
  const asked: string[] = [];
  const sent: Row[][] = [];
  const fetcher = (async (url: string) => {
    if (url.includes("oauth2")) return Response.json({ access_token: "tok" });
    const site = decodeURIComponent(url.split("/sites/")[1].split("/")[0]);
    asked.push(site);
    if (site === "sc-domain:denied.test") return new Response("User does not have sufficient permission", { status: 403 });
    return Response.json({ rows: [apiRow("q")] });
  }) as typeof fetch;
  const env = {
    EVENTS: { send: async (rows: Row[]) => void sent.push(rows) },
    GSC_SERVICE_ACCOUNT: await serviceAccount(),
    GSC_SITES: JSON.stringify({ "sc-domain:ls.test": "ledgersignal", "sc-domain:denied.test": "other", "sc-domain:rc.test": "reelschat" }),
  };
  assert.deepEqual(await pullDay(env as never, "2026-10-14", fetcher, "sc-domain:rc.test"), { "sc-domain:rc.test": 1 });
  assert.deepEqual(asked, ["sc-domain:rc.test"]);
  await assert.rejects(pullDay(env as never, "2026-10-14", fetcher, "sc-domain:nope.test"), /not in GSC_SITES/);

  asked.length = 0;
  sent.length = 0;
  await assert.rejects(pullDay(env as never, "2026-10-14", fetcher), /denied\.test 2026-10-14: 403[\s\S]*"sc-domain:rc\.test":1/);
  assert.deepEqual(asked, ["sc-domain:ls.test", "sc-domain:denied.test", "sc-domain:rc.test"]);
  assert.deepEqual(sent.flat().map((r) => r.app_id), ["ledgersignal", "reelschat"]);
});

test("the pull endpoint rejects a site that isn't in GSC_SITES", async () => {
  const env = { EVENTS: { send: async () => {} }, GSC_ADMIN_TOKEN: "secret", GSC_SITES: '{"sc-domain:ls.test":"ledgersignal"}' } as never;
  const res = await handleGscPull(
    new Request("https://t/v1/gsc/pull", { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify({ date: "2026-10-14", site: "sc-domain:x.test" }) }),
    env,
  );
  assert.equal(res.status, 400);
});
