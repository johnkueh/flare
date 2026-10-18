import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appleAppSiteAssociation,
  assetLinks,
  checkLinks,
  flareLinks,
  type LinksFile,
  linkUrl,
  normalizeSha256,
  parseLink,
  REFERRER_KEY,
  storeUrl,
} from "./index.ts";

const file: LinksFile = {
  domain: "example.com",
  name: "Groceries",
  scheme: "groceries",
  ios: { appIds: ["ABCDE12345.com.example.app"], store: "https://testflight.apple.com/join/abc" },
  android: { packages: ["com.example.app", "com.example.app.dev"], sha256: ["0c5d2cd57192f07d66a26274e68bd30a0d90eeb45ef36050cce67b344e866680"] },
  links: {
    invite: { path: "/j/:code", deferred: true },
    item: { path: "/lists/:list/items/:item" },
  },
};

test("a good file has no problems, a bad one says why", () => {
  assert.deepEqual(checkLinks(file), []);
  const problems = checkLinks({ ...file, domain: "https://x.com/", links: { Bad: { path: "j/:code" } } });
  assert.equal(problems.length, 3);
});

test("parses https links on the domain and www, and the scheme wrapper", () => {
  assert.deepEqual(parseLink(file, "https://example.com/j/7KQ2-M9XD"), {
    kind: "invite",
    params: { code: "7KQ2-M9XD" },
    url: "https://example.com/j/7KQ2-M9XD",
  });
  assert.equal(parseLink(file, "https://www.example.com/j/ABC/")?.params.code, "ABC");
  assert.deepEqual(parseLink(file, "https://example.com/lists/a%20b/items/2")?.params, { list: "a b", item: "2" });
  assert.equal(parseLink(file, "groceries://link?url=https%3A%2F%2Fexample.com%2Fj%2FXY")?.params.code, "XY");
  assert.equal(parseLink(file, "https://other.com/j/ABC"), null);
  assert.equal(parseLink(file, "https://example.com/j"), null);
  assert.equal(parseLink(file, "https://example.com/j/a/b"), null);
  assert.equal(parseLink(file, "not a link"), null);
});

test("finds the link inside shared text", () => {
  const link = parseLink(file, "Join Flat on Groceries with code 7KQ2-M9XD https://example.com/j/7KQ2-M9XD.");
  assert.equal(link?.params.code, "7KQ2-M9XD");
});

test("builds links, encoding each part", () => {
  assert.equal(linkUrl(file, "invite", { code: "7KQ2M9XD" }), "https://example.com/j/7KQ2M9XD");
  assert.equal(linkUrl(file, "item", { list: "a b", item: "1" }), "https://example.com/lists/a%20b/items/1");
  assert.throws(() => linkUrl(file, "invite", {}));
  assert.throws(() => linkUrl(file, "nope", {}));
});

test("the Play link carries deferred links as the install referrer", () => {
  const url = "https://example.com/j/AB";
  const play = new URL(storeUrl(file, "android", url, true)!);
  assert.equal(play.searchParams.get("id"), "com.example.app");
  const referrer = new URLSearchParams(play.searchParams.get("referrer")!);
  assert.equal(referrer.get(REFERRER_KEY), url);
  assert.equal(new URL(storeUrl(file, "android", url, false)!).searchParams.get("referrer"), null);
  assert.equal(storeUrl(file, "ios", url, true), "https://testflight.apple.com/join/abc");
});

test("apple-app-site-association lists each path with wildcards", () => {
  assert.deepEqual(appleAppSiteAssociation(file), {
    applinks: {
      details: [
        {
          appIDs: ["ABCDE12345.com.example.app"],
          components: [
            { "/": "/j/*", comment: "invite" },
            { "/": "/lists/*/items/*", comment: "item" },
          ],
        },
      ],
    },
  });
});

test("assetlinks uses colon fingerprints for every package", () => {
  const statements = assetLinks(file);
  assert.equal(statements.length, 2);
  assert.equal(statements[0].target.sha256_cert_fingerprints[0].slice(0, 8), "0C:5D:2C");
  assert.equal(normalizeSha256("nope"), null);
});

test("http serves the files and a landing page, and passes on the rest", async () => {
  const links = flareLinks(file, {
    describe: (link) => (link.params.code === "GONE" ? false : { title: "Mia invited you to Flat", detail: link.params.code }),
    page: { icon: "/icon.png" },
  });
  const aasa = await links.http(new Request("https://www.example.com/.well-known/apple-app-site-association"));
  assert.equal(aasa?.headers.get("Content-Type"), "application/json");
  const assets = await links.http(new Request("https://example.com/.well-known/assetlinks.json"));
  assert.equal(((await assets!.json()) as unknown[]).length, 2);

  const page = await links.http(new Request("http://localhost:8787/j/AB12"));
  const html = await page!.text();
  assert.match(html, /<title>Mia invited you to Flat<\/title>/);
  assert.match(html, /groceries:\/\/link\?url=https%3A%2F%2Fexample\.com%2Fj%2FAB12/);
  assert.match(html, /flare_link%3Dhttps/);

  assert.equal((await links.http(new Request("https://example.com/j/GONE")))?.status, 404);
  assert.equal(await links.http(new Request("https://example.com/")), null);
  assert.equal(await links.http(new Request("https://example.com/j/AB", { method: "POST" })), null);
});

test("the landing page escapes what describe returns", async () => {
  const links = flareLinks(file, { describe: () => ({ title: '<script>alert("x")</script>' }) });
  const html = await (await links.http(new Request("https://example.com/j/AB")))!.text();
  assert.doesNotMatch(html, /<script>alert/);
});
