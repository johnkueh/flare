import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, test } from "node:test";
// @ts-expect-error: plain JS, no types
import { enableAssociatedDomains, jwt, playSigningSha256 } from "../bin/stores.mjs";
import { addLinkEvents, certificateSha256 } from "./index.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fake fetch: routes "METHOD path-fragment" to a JSON body, and records calls. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url: String(url), body: init.body as string | undefined });
    const key = Object.keys(routes).find((k) => {
      const [m, fragment] = k.split(" ");
      return m === method && String(url).includes(fragment);
    });
    if (!key) return new Response(JSON.stringify({ errors: [{ detail: `no route for ${method} ${url}` }] }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return calls;
}

test("ES256 and RS256 tokens verify with the matching public key", () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const token = jwt({ alg: "ES256", kid: "K" }, { iss: "I" }, ec.privateKey.export({ type: "pkcs8", format: "pem" }));
  const [h, c, s] = token.split(".");
  assert.equal(Buffer.from(s, "base64url").length, 64); // raw r||s, as Apple wants
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rs = jwt({ alg: "RS256" }, { iss: "x" }, rsa.privateKey.export({ type: "pkcs8", format: "pem" }));
  const [h2, c2, s2] = rs.split(".");
  assert.ok(verify("sha256", Buffer.from(`${h2}.${c2}`), rsa.publicKey, Buffer.from(s2, "base64url")));
});

const ascKey = () => ({
  keyId: "K",
  issuerId: "I",
  key: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }),
});
const file = { domain: "example.com", name: "X", ios: { appIds: ["ABCDE12345.com.example.app"] }, links: { invite: { path: "/j/:code" } } };

test("capability turns Associated Domains on for the exact bundle id only", async () => {
  const calls = fakeFetch({
    "GET /bundleIds?": { data: [{ id: "B2", attributes: { identifier: "com.example.app.dev" } }, { id: "B1", attributes: { identifier: "com.example.app" } }] },
    "GET /bundleIds/B1/bundleIdCapabilities": { data: [{ attributes: { capabilityType: "PUSH_NOTIFICATIONS" } }] },
    "POST /bundleIdCapabilities": { data: {} },
  });
  const lines = await enableAssociatedDomains(file, ascKey());
  assert.equal(lines.length, 1);
  assert.ok(lines[0].ok && /turned Associated Domains on/.test(lines[0].text));
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(JSON.parse(post!.body!).data.relationships.bundleId.data.id, "B1");
  assert.match(calls[0].url, /filter\[identifier\]=com\.example\.app/);
});

test("capability leaves an App ID alone when it's already on, and dry-run never writes", async () => {
  fakeFetch({
    "GET /bundleIds?": { data: [{ id: "B1", attributes: { identifier: "com.example.app" } }] },
    "GET /bundleIds/B1/bundleIdCapabilities": { data: [{ attributes: { capabilityType: "ASSOCIATED_DOMAINS" } }] },
  });
  assert.match((await enableAssociatedDomains(file, ascKey()))[0].text, /already on/);

  const calls = fakeFetch({
    "GET /bundleIds?": { data: [{ id: "B1", attributes: { identifier: "com.example.app" } }] },
    "GET /bundleIds/B1/bundleIdCapabilities": { data: [] },
  });
  const [line] = await enableAssociatedDomains(file, ascKey(), { dryRun: true });
  assert.equal(line.ok, false);
  assert.ok(!calls.some((c) => c.method === "POST"));
});

test("play-sha reads the newest version code through a throwaway edit", async () => {
  const sa = { client_email: "a@b.iam.gserviceaccount.com", private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) };
  const calls = fakeFetch({
    "POST oauth2.googleapis.com/token": { access_token: "t" },
    "POST /com.example.app/edits": { id: "E" },
    "GET /edits/E/tracks": { tracks: [{ releases: [{ versionCodes: ["41", "43"] }] }, { releases: [{ versionCodes: ["42"] }] }] },
    "DELETE /edits/E": {},
    "GET /generatedApks/43": { generatedApks: [{ certificateSha256Hash: "0c5d2cd57192f07d66a26274e68bd30a0d90eeb45ef36050cce67b344e866680" }] },
  });
  const result = await playSigningSha256("com.example.app", sa);
  assert.equal(result.versionCode, 43);
  assert.equal(result.hashes.length, 1);
  assert.ok(calls.some((c) => c.method === "DELETE"));
});

test("certificate hashes read as hex or base64", () => {
  const hex = "0c5d2cd57192f07d66a26274e68bd30a0d90eeb45ef36050cce67b344e866680";
  const want = certificateSha256(hex);
  assert.equal(want?.length, 95);
  assert.equal(certificateSha256(Buffer.from(hex, "hex").toString("base64")), want);
  assert.equal(certificateSha256(Buffer.from(hex, "hex").toString("base64url")), want);
  assert.equal(certificateSha256("nope"), null);
});

test("link events go in, in the file's own shape, once", () => {
  const flare = addLinkEvents({ events: { signed_up: { params: { plan: "" } } } });
  assert.deepEqual(flare.added, ["link_opened", "link_deferred_claimed"]);
  assert.deepEqual((flare.file.events.link_deferred_claimed as { params: unknown }).params, { kind: "invite", via: "paste" });

  const listed = addLinkEvents({ events: { signed_up: { params: ["plan"] } } });
  assert.deepEqual((listed.file.events.link_opened as { params: unknown }).params, ["kind"]);

  assert.deepEqual(addLinkEvents(listed.file).added, []);
});
