// App Store Connect and Google Play calls for flare-links (LINKS.md): turn
// on Associated Domains for an App ID, and read the Play app signing key.
// Plain fetch and node:crypto, no SDKs.

import { execFileSync } from "node:child_process";
import { sign } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const b64url = (data) => Buffer.from(data).toString("base64url");

function jwt(header, payload, key, options) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${input}.${b64url(sign("sha256", Buffer.from(input), { key, ...options }))}`;
}

async function call(url, init, what) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const detail = body?.errors?.[0]?.detail ?? body?.error?.message ?? body?.error_description ?? text.slice(0, 200);
    throw new Error(`${what}: ${res.status} ${detail}`);
  }
  return body;
}

// MARK: App Store Connect

/** An App Store Connect API key: flags, else ASC_KEY_ID / ASC_ISSUER_ID /
 *  ASC_KEY_FILEPATH (the names fastlane setups use), else
 *  ~/.appstoreconnect/AuthKey_<id>.p8. */
export function ascKey({ keyId = process.env.ASC_KEY_ID, issuerId = process.env.ASC_ISSUER_ID, keyFile = process.env.ASC_KEY_FILEPATH } = {}) {
  if (!keyId || !issuerId) {
    throw new Error("needs an App Store Connect API key: --key-id and --issuer-id (or ASC_KEY_ID and ASC_ISSUER_ID)");
  }
  const path = (keyFile ?? join(homedir(), ".appstoreconnect", `AuthKey_${keyId}.p8`)).replace(/^~/, homedir());
  if (!existsSync(path)) throw new Error(`no key file at ${path} (--key-file or ASC_KEY_FILEPATH)`);
  return { keyId, issuerId, pem: readFileSync(path, "utf8") };
}

function ascToken({ keyId, issuerId, pem }) {
  const now = Math.floor(Date.now() / 1000);
  return jwt(
    { alg: "ES256", kid: keyId, typ: "JWT" },
    { iss: issuerId, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" },
    pem,
    { dsaEncoding: "ieee-p1363" },
  );
}

/** Turns on ASSOCIATED_DOMAINS for a bundle id. "on" when it already was,
 *  "enabled" when this call turned it on. fastlane's
 *  `bundle_id.update_capability` fails here with "Unauthenticated"; the
 *  documented POST /v1/bundleIdCapabilities works with the same key. */
export async function enableAssociatedDomains(key, identifier) {
  const api = "https://api.appstoreconnect.apple.com/v1";
  const headers = { Authorization: `Bearer ${ascToken(key)}`, "Content-Type": "application/json" };
  const found = await call(`${api}/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=200`, { headers }, "bundleIds");
  // The filter matches prefixes too (com.example.app also finds com.example.app.widget).
  const bundle = found.data.find((b) => b.attributes.identifier === identifier);
  if (!bundle) throw new Error(`no App ID ${identifier} on this team (create it first)`);
  const caps = await call(`${api}/bundleIds/${bundle.id}/bundleIdCapabilities`, { headers }, "bundleIdCapabilities");
  if (caps.data.some((c) => c.attributes.capabilityType === "ASSOCIATED_DOMAINS")) return "on";
  await call(
    `${api}/bundleIdCapabilities`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: {
          type: "bundleIdCapabilities",
          attributes: { capabilityType: "ASSOCIATED_DOMAINS", settings: [] },
          relationships: { bundleId: { data: { type: "bundleIds", id: bundle.id } } },
        },
      }),
    },
    "enable ASSOCIATED_DOMAINS",
  );
  return "enabled";
}

// MARK: Google Play

/** A Google service account key file with access to the Play Console app:
 *  the flag, else GOOGLE_APPLICATION_CREDENTIALS / PLAY_JSON_KEY. */
export function playKey(file = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? process.env.PLAY_JSON_KEY) {
  if (!file) throw new Error("needs a Play service account key: --key <file.json> (or PLAY_JSON_KEY)");
  const path = file.replace(/^~/, homedir());
  if (!existsSync(path)) throw new Error(`no key file at ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

async function playToken(account) {
  const now = Math.floor(Date.now() / 1000);
  const aud = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const assertion = jwt(
    { alg: "RS256", typ: "JWT" },
    { iss: account.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud, iat: now, exp: now + 3600 },
    account.private_key,
  );
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
  return (await call(aud, { method: "POST", body }, "service account sign-in")).access_token;
}

/** The newest version code on any track: an edit is opened, read and
 *  deleted, so nothing changes in Play Console. */
async function latestVersionCode(api, headers, pkg) {
  const edit = await call(`${api}/${pkg}/edits`, { method: "POST", headers }, "open edit");
  try {
    const { tracks = [] } = await call(`${api}/${pkg}/edits/${edit.id}/tracks`, { headers }, "tracks");
    const codes = tracks.flatMap((t) => (t.releases ?? []).flatMap((r) => r.versionCodes ?? [])).map(Number);
    if (!codes.length) throw new Error(`${pkg} has no release on any track yet: upload a bundle first (internal testing is enough)`);
    return Math.max(...codes);
  } finally {
    await fetch(`${api}/${pkg}/edits/${edit.id}`, { method: "DELETE", headers }).catch(() => {});
  }
}

/** The Play app signing certificate SHA-256s (hex) for a package, from the
 *  APKs Play generated for a version code. */
export async function playSigningSha256(account, pkg, versionCode) {
  const api = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
  const headers = { Authorization: `Bearer ${await playToken(account)}` };
  const code = versionCode ?? (await latestVersionCode(api, headers, pkg));
  const res = await call(`${api}/${pkg}/generatedApks/${code}`, { headers }, `generatedApks for ${pkg} ${code}`);
  const hashes = [...new Set((res.generatedApks ?? []).map((g) => g.certificateSha256Hash).filter(Boolean))];
  if (!hashes.length) throw new Error(`Play has no generated APKs for ${pkg} ${code} (is Play App Signing on?)`);
  return { versionCode: code, hashes };
}

// MARK: Local keys

/** This machine's Android debug key SHA-256 (hex, lowercase), or null. */
export function debugKeySha256() {
  const keystore = join(homedir(), ".android", "debug.keystore");
  if (!existsSync(keystore)) return null;
  try {
    const out = execFileSync("keytool", ["-list", "-v", "-keystore", keystore, "-storepass", "android", "-alias", "androiddebugkey"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = out.match(/SHA256:\s*([0-9A-F:]+)/i);
    return match ? match[1].replace(/:/g, "").toLowerCase() : null;
  } catch {
    return null;
  }
}

// MARK: Built apps

/** links.json from a built .app (folder), .ipa, .apk or .aab, or null. */
export function bundledLinksJson(path) {
  if (!existsSync(path)) throw new Error("not found");
  if (statSync(path).isDirectory()) {
    // An .app is flat: resources sit at its root.
    return existsSync(join(path, "links.json")) ? readFileSync(join(path, "links.json"), "utf8") : null;
  }
  const quiet = { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] };
  const listing = execFileSync("unzip", ["-Z1", path], quiet);
  const entry = listing.split("\n").find((name) => /(^|\/)links\.json$/.test(name) && !name.includes("node_modules"));
  return entry ? execFileSync("unzip", ["-p", path, entry], quiet) : null;
}
