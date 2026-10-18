#!/usr/bin/env node
// flare-links: set up and check an app's links (LINKS.md).
//
//   npx flare-links setup [links.json]    what to add to the iOS and Android apps
//   npx flare-links apple [links.json]    turn on Associated Domains for each App ID
//   npx flare-links events [events.json]  add the link events to the app's telemetry
//   npx flare-links play-sha [links.json] read the Play app signing key; --write adds it
//   npx flare-links check [links.json]    what Apple and Google see on the live domain
//       --wait [minutes]  keep checking until Apple's CDN has the new file
//       --app <path>      also check the links.json inside a built .app/.ipa/.apk/.aab
//   npx flare-links url <kind> key=value… [--config links.json]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { appleAppSiteAssociation, assetLinks, checkLinks, linkUrl, normalizeSha256 } from "../dist/index.js";
import { ascKey, bundledLinksJson, debugKeySha256, enableAssociatedDomains, playKey, playSigningSha256 } from "./stores.mjs";

const [command, ...argv] = process.argv.slice(2);

// --name value flags; a flag with no value (or followed by another flag) is true.
const flags = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) {
    rest.push(argv[i]);
    continue;
  }
  const name = argv[i].slice(2);
  const next = argv[i + 1];
  flags[name] = next === undefined || next.startsWith("--") ? true : (i++, next);
}
const configPath = flags.config ?? (rest[0]?.endsWith(".json") && command !== "events" ? rest.shift() : "links.json");

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
const note = (text) => console.log(`… ${text}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The sha256 entries that are only this machine's debug key, as a warning, or null. */
function debugOnlyWarning(file) {
  const debug = debugKeySha256() && normalizeSha256(debugKeySha256());
  const keys = (file.android?.sha256 ?? []).map(normalizeSha256);
  if (!debug || !keys.length || keys.some((k) => k !== debug)) return null;
  return `android.sha256 only lists this machine's debug key (${debug.slice(0, 14)}…). Builds installed from Play are signed with the Play app signing key, so links open the browser there: run npx flare-links play-sha --write.`;
}

// MARK: setup

function setup(file) {
  const paths = Object.values(file.links).map((l) => l.path.replace(/:[^/]+/g, "*"));
  const config = relative(process.cwd(), resolve(configPath)) || "links.json";
  console.log(`iOS
  1. links.json in the app: drag ${config} into Xcode, untick "Copy items if
     needed" and tick the app target. Xcode copies the shared file into the
     bundle on every build, so there's no second copy to keep in step.
     npx flare-links check --app <path to the built .app> confirms it.
  2. The Associated Domains capability on the app target:

     <key>com.apple.developer.associated-domains</key>
     <array>
       <string>applinks:${file.domain}</string>
     </array>

  3. The App ID needs it too: npx flare-links apple (App Store Connect API key
     from ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_FILEPATH, or --key-id,
     --issuer-id and --key-file).
${file.scheme ? `  4. The landing page's Open button uses ${file.scheme}://link?url=…: register the
     ${file.scheme} URL scheme (CFBundleURLTypes) if the app doesn't already.
` : ""}
  Apple's devices read the association file through Apple's CDN, which can
  answer 404 for a while after the first deploy. To test straight away, use
  "applinks:${file.domain}?mode=developer" in a Debug build: simulators and
  devices with Developer Mode on then fetch it from ${file.domain} directly.
  npx flare-links check --wait waits until the CDN has it.
`);
  if (file.android) {
    console.log(`Android
  1. links.json from the shared file at build time, in app/build.gradle.kts
     (the path is relative to the app module):

     val flareLinks = tasks.register<Copy>("flareLinks") {
         from(file("<path to ${config}>"))
         into(layout.buildDirectory.dir("generated/flareLinks"))
     }
     android.sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/flareLinks"))
     tasks.named("preBuild") { dependsOn(flareLinks) }

     It lands in assets/links.json: context.assets.open("links.json").
  2. Inside the launcher activity in AndroidManifest.xml:

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
  3. In build.gradle: implementation("com.android.installreferrer:installreferrer:2.2")
  4. android.sha256 needs the Play app signing key for builds from Play (not
     the upload key): npx flare-links play-sha --write, once Play has a build.
`);
    const warning = debugOnlyWarning(file);
    if (warning) console.log(`  ! ${warning}\n`);
  }
  console.log(`Telemetry
  npx flare-links events [path/to/events.json] adds link_opened and
  link_deferred_claimed (what FlareLinks reports through onEvent), then run
  your events codegen if the app has one.

Worker
  Call flareLinks(links).http(request) before anything that redirects, then
  deploy and run: npx flare-links check`);
}

// MARK: apple

async function apple(file) {
  const ids = flags["bundle-id"] ? [flags["bundle-id"]] : file.ios?.appIds.map((id) => id.replace(/^[A-Z0-9]{10}\./, "")) ?? [];
  if (!ids.length) fail("links.json has no ios.appIds (or pass --bundle-id)");
  let key;
  try {
    key = ascKey({ keyId: flags["key-id"], issuerId: flags["issuer-id"], keyFile: flags["key-file"] });
  } catch (error) {
    fail(error.message);
  }
  let enabled = 0;
  for (const id of ids) {
    try {
      const state = await enableAssociatedDomains(key, id);
      if (state === "enabled") enabled++;
      ok(`${id}: Associated Domains ${state === "on" ? "already on" : "turned on"}`);
    } catch (error) {
      bad(`${id}: ${error.message}`);
    }
  }
  if (enabled) note("Profiles made before this don't have the capability: regenerate them (Xcode's automatic signing does it on the next build).");
}

// MARK: events

const LINK_EVENTS = {
  link_opened: { description: "A link opened the app (Flare links). kind: the link's kind in links.json.", params: ["kind"] },
  link_deferred_claimed: {
    description: "A link tapped before installing reached the app on first launch (Flare links). kind: the link's kind. via: paste (iPhone), referrer (Android, Play).",
    params: ["kind", "via"],
  },
};

function events() {
  const path = rest[0] ?? flags.file ?? (existsSync("analytics/events.json") ? "analytics/events.json" : "events.json");
  let file;
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Couldn't read ${path}: ${error.message} (pass the path to the app's events.json)`);
  }
  file.events ??= {};
  // Older files list params by name; newer ones give an example value per param.
  const listed = Object.values(file.events).some((e) => Array.isArray(e.params));
  let added = 0;
  for (const [name, event] of Object.entries(LINK_EVENTS)) {
    if (file.events[name]) {
      ok(`${name} already in ${path}`);
      continue;
    }
    file.events[name] = { description: event.description, params: listed ? event.params : Object.fromEntries(event.params.map((p) => [p, ""])) };
    added++;
    ok(`${name} added to ${path}`);
  }
  if (added) {
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    note("Run the app's events codegen if it has one (Swift and Kotlin enums, a Rust core), so the names compile.");
  }
}

// MARK: play-sha

async function playSha(file) {
  const pkg = flags.package ?? file.android?.packages[0];
  if (!pkg) fail("links.json has no android.packages (or pass --package)");
  let found;
  try {
    found = await playSigningSha256(playKey(flags.key), pkg, flags["version-code"] ? Number(flags["version-code"]) : undefined);
  } catch (error) {
    fail(`${pkg}: ${error.message}`);
  }
  const have = new Set((file.android?.sha256 ?? []).map(normalizeSha256));
  for (const hash of found.hashes) {
    const hex = normalizeSha256(hash);
    if (!hex) {
      bad(`Play returned an unexpected certificate hash: ${hash}`);
      continue;
    }
    console.log(`${pkg} (version ${found.versionCode}) Play app signing SHA-256:\n  ${hex}`);
    if (have.has(hex)) ok("already in links.json");
    else if (flags.write) {
      const raw = JSON.parse(readFileSync(resolve(configPath), "utf8"));
      raw.android.sha256 = [...(raw.android.sha256 ?? []), hex];
      writeFileSync(resolve(configPath), `${JSON.stringify(raw, null, 2)}\n`);
      ok(`added to ${configPath}: deploy the Worker, then npx flare-links check`);
    } else note(`not in links.json yet: rerun with --write, or add "${hex}" to android.sha256`);
  }
}

// MARK: check

async function fetchJson(url) {
  const res = await fetch(url, { redirect: "manual", headers: { Accept: "application/json" } });
  const type = res.headers.get("content-type") ?? "";
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, type, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkCdn(file, want) {
  const url = `https://app-site-association.cdn-apple.com/a/v1/${file.domain}`;
  const minutes = flags.wait === true ? 15 : Number(flags.wait ?? 0);
  const until = Date.now() + minutes * 60_000;
  for (let first = true; ; first = false) {
    let cdn;
    try {
      cdn = await fetchJson(url);
    } catch (error) {
      note(`Apple's CDN: ${error.message}`);
      return;
    }
    if (cdn.status === 200 && same(cdn.body, want)) return ok("Apple's CDN copy matches");
    if (Date.now() >= until) {
      const state = cdn.status === 200 ? "still has an older copy" : `answers ${cdn.status}`;
      note(`Apple's CDN ${state}. Installs read the file through it, so universal links won't open the app until it updates (usually minutes after a first deploy, up to a day after a change; a 404 is cached for a while too). Meanwhile "applinks:${file.domain}?mode=developer" in a Debug build reads ${file.domain} directly. Run with --wait to keep checking.`);
      return;
    }
    if (first) note(`waiting up to ${minutes} min for Apple's CDN (it answers ${cdn.status === 200 ? "with an older copy" : cdn.status})…`);
    await sleep(30_000);
  }
}

function checkApp(file) {
  const path = flags.app;
  let json;
  try {
    json = bundledLinksJson(resolve(path));
  } catch (error) {
    return bad(`${path}: ${error.message}`);
  }
  if (json === null) return bad(`${path} has no links.json (see npx flare-links setup)`);
  let inApp;
  try {
    inApp = JSON.parse(json);
  } catch {
    return bad(`${path}: its links.json isn't valid JSON`);
  }
  same(inApp, file) ? ok(`${path} has the same links.json`) : bad(`${path} has a different links.json (rebuild after changing it)`);
}

async function check(file) {
  if (flags.app) checkApp(file);
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
  await checkCdn(file, want);
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
      note(`Digital Asset Links API: ${error.message}`);
    }
    const warning = debugOnlyWarning(file);
    if (warning) note(warning);
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
  case "apple":
    await apple(load());
    break;
  case "events":
    events();
    break;
  case "play-sha":
    await playSha(load());
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
    console.log(`Usage: flare-links setup|apple|play-sha|check [links.json]
       flare-links check --wait [minutes] --app <built app>
       flare-links events [events.json]
       flare-links url <kind> key=value… [--config links.json]`);
    process.exit(command ? 1 : 0);
}
