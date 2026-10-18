#!/usr/bin/env node
// flare-links: set up and check an app's links (LINKS.md).
//
//   npx flare-links setup [links.json]   what to add to the iOS and Android apps
//   npx flare-links check [links.json]   what Apple and Google see on the live domain
//   npx flare-links url <kind> key=value… [--config links.json]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appleAppSiteAssociation, assetLinks, checkLinks, linkUrl } from "../dist/index.js";

const [command, ...rest] = process.argv.slice(2);
const configFlag = rest.indexOf("--config");
const configPath = configFlag >= 0 ? rest.splice(configFlag, 2)[1] : rest[0]?.endsWith(".json") ? rest.shift() : "links.json";

function load() {
  let file;
  try {
    file = JSON.parse(readFileSync(resolve(configPath), "utf8"));
  } catch (error) {
    fail(`Couldn't read ${configPath}: ${error.message}`);
  }
  const problems = checkLinks(file);
  if (problems.length) fail(`${configPath}:\n  ${problems.join("\n  ")}`);
  return file;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const ok = (text) => console.log(`✓ ${text}`);
const bad = (text) => {
  console.log(`✗ ${text}`);
  process.exitCode = 1;
};

function setup(file) {
  const paths = Object.values(file.links).map((l) => l.path.replace(/:[^/]+/g, "*"));
  console.log(`iOS: add the Associated Domains capability to the app target, with:

  <key>com.apple.developer.associated-domains</key>
  <array>
    <string>applinks:${file.domain}</string>
  </array>

  The App ID needs Associated Domains turned on too (developer portal, or
  App Store Connect API bundleIdCapabilities ASSOCIATED_DOMAINS). While
  testing, "applinks:${file.domain}?mode=developer" skips Apple's CDN on
  devices with Developer Mode on.
`);
  if (file.scheme) {
    console.log(`  The landing page's Open button uses ${file.scheme}://link?url=…: register the
  ${file.scheme} URL scheme (CFBundleURLTypes) if the app doesn't already.
`);
  }
  if (file.android) {
    console.log(`Android: inside the launcher activity in AndroidManifest.xml:

  <intent-filter android:autoVerify="true">
      <action android:name="android.intent.action.VIEW" />
      <category android:name="android.intent.category.DEFAULT" />
      <category android:name="android.intent.category.BROWSABLE" />
      <data android:scheme="https" android:host="${file.domain}" />
${paths.map((p) => `      <data android:pathPattern="${p.replace(/\*/g, ".*")}" />`).join("\n")}
  </intent-filter>
${file.scheme ? `  <intent-filter>
      <action android:name="android.intent.action.VIEW" />
      <category android:name="android.intent.category.DEFAULT" />
      <category android:name="android.intent.category.BROWSABLE" />
      <data android:scheme="${file.scheme}" android:host="link" />
  </intent-filter>
` : ""}
  and in build.gradle: implementation("com.android.installreferrer:installreferrer:2.2")
  android.sha256 needs the Play app signing key's SHA-256 (Play Console →
  Test and release → App integrity) for builds from Play.
`);
  }
  console.log(`Worker: call flareLinks(links).http(request) before anything that redirects,
then deploy and run: npx flare-links check`);
}

async function fetchJson(url) {
  const res = await fetch(url, { redirect: "manual", headers: { Accept: "application/json" } });
  const type = res.headers.get("content-type") ?? "";
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, type, body };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function check(file) {
  const want = appleAppSiteAssociation(file);
  for (const host of [file.domain, `www.${file.domain}`]) {
    const url = `https://${host}/.well-known/apple-app-site-association`;
    try {
      const res = await fetchJson(url);
      if (res.status !== 200) bad(`${url}  ${res.status}${res.status >= 300 && res.status < 400 ? " (Apple won't follow redirects)" : ""}`);
      else if (!res.type.includes("application/json")) bad(`${url}  served as ${res.type}, should be application/json`);
      else if (!same(res.body, want)) bad(`${url}  differs from links.json (deployed?)`);
      else ok(`${url}`);
    } catch (error) {
      (host === file.domain ? bad : ok)(`${url}  ${host === file.domain ? error.message : "not served (fine unless links use www)"}`);
    }
  }
  try {
    const cdn = await fetchJson(`https://app-site-association.cdn-apple.com/a/v1/${file.domain}`);
    if (cdn.status === 200 && same(cdn.body, want)) ok("Apple's CDN copy matches");
    else console.log(`… Apple's CDN copy ${cdn.status === 200 ? "is older" : `answers ${cdn.status}`}; it refreshes within about a day. Devices in developer mode skip it.`);
  } catch (error) {
    console.log(`… Apple's CDN: ${error.message}`);
  }
  if (file.android) {
    const url = `https://${file.domain}/.well-known/assetlinks.json`;
    try {
      const res = await fetchJson(url);
      if (res.status !== 200 || !same(res.body, assetLinks(file))) bad(`${url}  ${res.status === 200 ? "differs from links.json" : res.status}`);
      else ok(url);
    } catch (error) {
      bad(`${url}  ${error.message}`);
    }
    try {
      const api = new URL("https://digitalassetlinks.googleapis.com/v1/statements:list");
      api.searchParams.set("source.web.site", `https://${file.domain}`);
      api.searchParams.set("relation", "delegate_permission/common.handle_all_urls");
      const res = await fetchJson(api);
      const packages = new Set((res.body?.statements ?? []).map((s) => s.target?.androidApp?.packageName));
      for (const pkg of file.android.packages) (packages.has(pkg) ? ok : bad)(`Google's Digital Asset Links API lists ${pkg}`);
    } catch (error) {
      console.log(`… Digital Asset Links API: ${error.message}`);
    }
  }
  for (const [kind, link] of Object.entries(file.links)) {
    const sample = link.path.replace(/:([^/]+)/g, "TEST");
    const url = `https://${file.domain}${sample}`;
    try {
      const res = await fetch(url);
      const html = await res.text();
      if (res.status === 404) ok(`${url}  404 (describe rejected the sample, so the page is wired)`);
      else if (res.status !== 200 || !html.includes("og:title")) bad(`${url}  ${res.status}, no landing page`);
      else ok(`${url}  landing page renders (${kind})`);
    } catch (error) {
      bad(`${url}  ${error.message}`);
    }
  }
}

switch (command) {
  case "setup":
    setup(load());
    break;
  case "check":
    await check(load());
    break;
  case "url": {
    const file = load();
    const [kind, ...pairs] = rest;
    console.log(linkUrl(file, kind, Object.fromEntries(pairs.map((p) => p.split("=")))));
    break;
  }
  default:
    console.log("Usage: flare-links setup|check [links.json]\n       flare-links url <kind> key=value… [--config links.json]");
    process.exit(command ? 1 : 0);
}
