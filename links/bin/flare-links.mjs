#!/usr/bin/env node
// flare-links: set up and check an app's links (LINKS.md).
//
//   npx flare-links setup                   what to add to the iOS and Android apps
//   npx flare-links embed <dir>…            links.json into each app (relative symlinks; --copy copies)
//   npx flare-links events <events.json>    add link_opened and link_deferred_claimed to the app's events
//   npx flare-links capability [--dry-run]  turn on Associated Domains for each App ID (App Store Connect API)
//   npx flare-links play-sha [--write]      the Play app signing key's SHA-256 (Google Play Developer API)
//   npx flare-links check                   what Apple and Google see on the live domain, and the app copies
//   npx flare-links url <kind> key=value…
//
// Every command reads ./links.json, or --config <path>.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { addLinkEvents, appleAppSiteAssociation, assetLinks, certificateSha256, checkLinks, linkUrl, normalizeSha256 } from "../dist/index.js";
import { ascCredentials, enableAssociatedDomains, playCredentials, playSigningSha256 } from "./stores.mjs";

// --name value and --flag; everything else stays positional.
const [command, ...argv] = process.argv.slice(2);
const flags = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith("--")) rest.push(arg);
  else if (["--dry-run", "--write", "--copy"].includes(arg)) flags[arg.slice(2)] = true;
  else flags[arg.slice(2)] = argv[++i];
}
// `setup links.json` and `check links.json` still work, as before --config.
const configPath = flags.config ?? (["setup", "check"].includes(command) && rest[0]?.endsWith(".json") ? rest.shift() : "links.json");

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
  console.log(`1. Both apps: put links.json in the app, as a link to this file so it can't go stale:

  npx flare-links embed ios/<App>/Resources android/app/src/main/assets

  Add the iOS one to the app target once (Xcode follows the symlink). \`check\`
  fails if a copy in the repo ever drifts from ${configPath}.

2. Analytics: FlareLinks reports link_opened and link_deferred_claimed through
  onEvent. Add them to the app's event list:

  npx flare-links events analytics/events.json
`);
  if (file.ios) {
    console.log(`3. iOS: turn on Associated Domains for the App ID${file.ios.appIds.length > 1 ? "s" : ""}:

  npx flare-links capability          (App Store Connect API key; --dry-run to look first)

  Then the entitlement, in the app's .entitlements:

  <key>com.apple.developer.associated-domains</key>
  <array>
    <string>applinks:${file.domain}</string>
  </array>

  Apple's devices fetch the association file through Apple's CDN, which can
  take from minutes to a day to pick up a first deploy or a change. To test
  straight away, use this in debug builds instead, on a device or simulator
  with Developer Mode on:

    <string>applinks:${file.domain}?mode=developer</string>
`);
    if (file.scheme) {
      console.log(`  The landing page's Open button uses ${file.scheme}://link?url=…: register the
  ${file.scheme} URL scheme (CFBundleURLTypes) if the app doesn't already.
`);
    }
  }
  if (file.android) {
    console.log(`4. Android: inside the launcher activity in AndroidManifest.xml:

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

  android.sha256 needs the Play app signing key: Play re-signs every build
  it installs, so the upload key and the debug key don't verify for people
  who installed from Play. After the first upload to any track:

  npx flare-links play-sha --write    (Play service account; adds it to ${configPath})
`);
  }
  console.log(`5. Worker: call flareLinks(links).http(request) before anything that redirects,
  then deploy and run: npx flare-links check`);
}

// --- embed ----------------------------------------------------------------

function embed(dirs) {
  if (!dirs.length) fail("Usage: flare-links embed <dir>… [--copy]   e.g. ios/App/Resources android/app/src/main/assets");
  const source = resolve(configPath);
  for (const dir of dirs) {
    const target = resolve(dir, "links.json");
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target) || isLink(target)) {
      if (isLink(target) && resolve(dirname(target), readlinkSync(target)) === source && !flags.copy) {
        ok(`${relative(process.cwd(), target)} already links to ${relative(process.cwd(), source)}`);
        continue;
      }
      rmSync(target);
    }
    if (flags.copy) copyFileSync(source, target);
    else symlinkSync(relative(dirname(target), source), target);
    ok(`${relative(process.cwd(), target)} → ${relative(process.cwd(), source)}${flags.copy ? " (copy; `check` will flag it if it drifts)" : ""}`);
  }
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every other links.json in the repo for the same domain: the apps' copies. */
function appCopies(file) {
  let root = process.cwd();
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {}
  const skip = new Set(["node_modules", ".git", "build", "dist", "DerivedData", "Pods", ".gradle", ".build", ".wrangler"]);
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !skip.has(entry.name)) walk(path, depth + 1);
      else if (entry.name === "links.json" && resolve(path) !== resolve(configPath)) found.push(path);
    }
  };
  walk(root, 0);
  return found.filter((path) => {
    try {
      return JSON.parse(readFileSync(path, "utf8")).domain === file.domain;
    } catch {
      return isLink(path); // a broken symlink is worth reporting
    }
  });
}

// --- events ---------------------------------------------------------------

function events(path) {
  if (!path) fail("Usage: flare-links events <events.json>");
  let current = { events: {} };
  if (existsSync(path)) current = JSON.parse(readFileSync(path, "utf8"));
  const { file, added } = addLinkEvents(current);
  if (!added.length) return ok(`${path} already has link_opened and link_deferred_claimed`);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  ok(`added ${added.join(" and ")} to ${path}. If the app generates code from it, regenerate that now.`);
}

// --- store chores -----------------------------------------------------------

async function capability(file) {
  if (!file.ios?.appIds?.length) fail(`${configPath} has no ios.appIds`);
  for (const line of await enableAssociatedDomains(file, ascCredentials(flags), { dryRun: flags["dry-run"] })) {
    (line.ok ? ok : bad)(line.text);
  }
}

async function playSha(file) {
  const pkg = flags.package ?? file.android?.packages?.[0];
  if (!pkg) fail(`${configPath} has no android.packages; pass --package`);
  const { versionCode, hashes } = await playSigningSha256(pkg, playCredentials(flags), flags["version-code"] ? Number(flags["version-code"]) : undefined);
  const digests = hashes.map(certificateSha256).filter(Boolean);
  if (!digests.length) fail(`Play answered with a hash I can't read: ${hashes.join(", ")}`);
  for (const digest of digests) console.log(`${pkg} (version ${versionCode}) is signed by Play with ${digest}`);
  const have = new Set((file.android.sha256 ?? []).map(normalizeSha256));
  const missing = digests.filter((d) => !have.has(d));
  if (!missing.length) return ok(`${configPath} already has it`);
  if (!flags.write) {
    bad(`${configPath} doesn't list it yet: run again with --write, then deploy the Worker`);
    return;
  }
  // Raw edit of the file, so key order and the rest of it stay as they are.
  const raw = JSON.parse(readFileSync(resolve(configPath), "utf8"));
  raw.android.sha256 = [...missing.map((d) => d.replace(/:/g, "").toLowerCase()), ...(raw.android.sha256 ?? [])];
  writeFileSync(resolve(configPath), `${JSON.stringify(raw, null, 2)}\n`);
  ok(`added it to ${configPath}. Deploy the Worker, then run: npx flare-links check`);
}

/** The SHA-256 of this machine's Android debug key, if keytool and the key are there. */
function localDebugSha256() {
  const keystore = join(homedir(), ".android", "debug.keystore");
  if (!existsSync(keystore)) return null;
  try {
    const out = execFileSync("keytool", ["-list", "-v", "-keystore", keystore, "-alias", "androiddebugkey", "-storepass", "android", "-keypass", "android"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = out.match(/SHA256:\s*([0-9A-F:]{95})/i);
    return match ? normalizeSha256(match[1]) : null;
  } catch {
    return null;
  }
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
  const source = readFileSync(resolve(configPath), "utf8");
  for (const copy of appCopies(file)) {
    const name = relative(process.cwd(), copy);
    let text = null;
    try {
      text = readFileSync(copy, "utf8");
    } catch {}
    if (text === null) bad(`${name}  is a broken link: npx flare-links embed ${relative(process.cwd(), dirname(copy))}`);
    else if (text !== source) bad(`${name}  differs from ${configPath}: npx flare-links embed ${relative(process.cwd(), dirname(copy))}`);
    else ok(`${name}  matches ${configPath}`);
  }
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
    else
      console.log(`… Apple's CDN copy ${cdn.status === 200 ? "is older" : `answers ${cdn.status}`}. Installs read the CDN, which catches up within a day.
  To test now, build with "applinks:${file.domain}?mode=developer" on a device or simulator with Developer Mode on.`);
  } catch (error) {
    console.log(`… Apple's CDN: ${error.message}`);
  }
  if (file.android) {
    const debug = localDebugSha256();
    const digests = (file.android.sha256 ?? []).map(normalizeSha256);
    if (debug && digests.length && digests.every((d) => d === debug)) {
      bad(`android.sha256 has only this machine's debug key. Installs from Play are signed with the Play app signing key: npx flare-links play-sha --write`);
    }
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

try {
  switch (command) {
    case "setup":
      setup(load());
      break;
    case "check":
      await check(load());
      break;
    case "embed":
      load();
      embed(rest);
      break;
    case "events":
      events(rest[0]);
      break;
    case "capability":
      await capability(load());
      break;
    case "play-sha":
      await playSha(load());
      break;
    case "url": {
      const file = load();
      const [kind, ...pairs] = rest;
      console.log(linkUrl(file, kind, Object.fromEntries(pairs.map((p) => p.split("=")))));
      break;
    }
    default:
      console.log(`Usage: flare-links <command> [--config links.json]
  setup                    what to add to the iOS and Android apps
  embed <dir>… [--copy]    put links.json in each app (relative symlinks)
  events <events.json>     add the link analytics events
  capability [--dry-run]   turn on Associated Domains for each App ID
  play-sha [--write]       read the Play app signing key's SHA-256
  check                    check the live domain and the app copies
  url <kind> key=value…    print a link`);
      process.exit(command ? 1 : 0);
  }
} catch (error) {
  fail(error.message);
}
