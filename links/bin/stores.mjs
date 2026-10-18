// The two store chores `flare-links` does for you: turning on Associated
// Domains for each App ID (App Store Connect API), and reading the Play app
// signing key's SHA-256 (Google Play Developer API). No dependencies: the
// tokens are signed with node:crypto.

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const b64url = (data) => Buffer.from(data).toString("base64url");

/** A signed JWT. ES256 signatures are raw r||s, which is what ieee-p1363 gives. */
export function jwt(header, claims, pem) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const key = createPrivateKey(pem);
  const signature =
    header.alg === "ES256"
      ? sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" })
      : sign("sha256", Buffer.from(input), key);
  return `${input}.${b64url(signature)}`;
}

// --- App Store Connect -----------------------------------------------------

/** The API key from flags, or fastlane's environment variables. */
export function ascCredentials(flags, env = process.env) {
  const keyId = flags["key-id"] ?? env.APP_STORE_CONNECT_API_KEY_KEY_ID ?? env.ASC_KEY_ID;
  const issuerId = flags["issuer-id"] ?? env.APP_STORE_CONNECT_API_KEY_ISSUER_ID ?? env.ASC_ISSUER_ID;
  const path = flags.key ?? env.APP_STORE_CONNECT_API_KEY_KEY_FILEPATH ?? env.ASC_KEY_PATH;
  const key = path ? readFileSync(path, "utf8") : env.APP_STORE_CONNECT_API_KEY_KEY ?? env.ASC_KEY;
  const missing = [!keyId && "--key-id", !issuerId && "--issuer-id", !key && "--key <AuthKey.p8>"].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `An App Store Connect API key is needed: ${missing.join(", ")} (or fastlane's APP_STORE_CONNECT_API_KEY_KEY_ID, _ISSUER_ID and _KEY_FILEPATH). Make one in App Store Connect → Users and Access → Integrations, with the Admin or App Manager role.`,
    );
  }
  return { keyId, issuerId, key: key.replace(/\\n/g, "\n") };
}

function ascToken({ keyId, issuerId, key }, now = Math.floor(Date.now() / 1000)) {
  return jwt({ alg: "ES256", kid: keyId, typ: "JWT" }, { iss: issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }, key);
}

async function asc(token, path, init = {}) {
  const res = await fetch(`https://api.appstoreconnect.apple.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const why = body?.errors?.map((e) => e.detail ?? e.title).join("; ") ?? res.statusText;
    throw new Error(`App Store Connect ${res.status}: ${why}`);
  }
  return body;
}

/** Turns on Associated Domains for every ios.appIds entry. Returns one line per App ID. */
export async function enableAssociatedDomains(file, credentials, { dryRun = false } = {}) {
  const token = ascToken(credentials);
  const lines = [];
  for (const appId of file.ios?.appIds ?? []) {
    const identifier = appId.slice(appId.indexOf(".") + 1);
    // filter[identifier] matches prefixes too, so pick the exact one.
    const found = await asc(token, `/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=200`);
    const bundle = found.data.find((b) => b.attributes.identifier === identifier);
    if (!bundle) {
      lines.push({ ok: false, text: `${identifier}: no App ID with this bundle id in this team` });
      continue;
    }
    const caps = await asc(token, `/bundleIds/${bundle.id}/bundleIdCapabilities?limit=200`);
    if (caps.data.some((c) => c.attributes.capabilityType === "ASSOCIATED_DOMAINS")) {
      lines.push({ ok: true, text: `${identifier}: Associated Domains already on` });
      continue;
    }
    if (dryRun) {
      lines.push({ ok: false, text: `${identifier}: Associated Domains is off (run without --dry-run to turn it on)` });
      continue;
    }
    await asc(token, "/bundleIdCapabilities", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "bundleIdCapabilities",
          attributes: { capabilityType: "ASSOCIATED_DOMAINS" },
          relationships: { bundleId: { data: { type: "bundleIds", id: bundle.id } } },
        },
      }),
    });
    lines.push({ ok: true, text: `${identifier}: turned Associated Domains on. Profiles made before this need regenerating (Xcode does it for automatic signing).` });
  }
  return lines;
}

// --- Google Play -----------------------------------------------------------

/** The service account JSON from a flag, or fastlane supply's and Google's environment variables. */
export function playCredentials(flags, env = process.env) {
  const path = flags["service-account"] ?? env.SUPPLY_JSON_KEY ?? env.GOOGLE_APPLICATION_CREDENTIALS;
  const json = path ? readFileSync(path, "utf8") : env.SUPPLY_JSON_KEY_DATA;
  if (!json) {
    throw new Error(
      "A Google Play service account key is needed: --service-account <key.json> (or SUPPLY_JSON_KEY / GOOGLE_APPLICATION_CREDENTIALS). Invite the account in Play Console → Users and permissions, with access to the app.",
    );
  }
  return JSON.parse(json);
}

async function googleToken(account, now = Math.floor(Date.now() / 1000)) {
  const assertion = jwt(
    { alg: "RS256", typ: "JWT" },
    { iss: account.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 600 },
    account.private_key,
  );
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
  return body.access_token;
}

async function play(token, path, init = {}) {
  const res = await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Google Play ${res.status}: ${body?.error?.message ?? res.statusText}`);
  return body;
}

/** The newest version code on any track, read through a throwaway edit. */
async function latestVersionCode(token, pkg) {
  const edit = await play(token, `${pkg}/edits`, { method: "POST" });
  try {
    const { tracks = [] } = await play(token, `${pkg}/edits/${edit.id}/tracks`);
    const codes = tracks.flatMap((t) => (t.releases ?? []).flatMap((r) => r.versionCodes ?? [])).map(Number);
    return codes.length ? Math.max(...codes) : null;
  } finally {
    await play(token, `${pkg}/edits/${edit.id}`, { method: "DELETE" }).catch(() => {});
  }
}

/** The Play app signing certificate's SHA-256 for a package, as Play reports it
 *  on the APKs it generates from an uploaded bundle. */
export async function playSigningSha256(pkg, account, versionCode) {
  const token = await googleToken(account);
  const code = versionCode ?? (await latestVersionCode(token, pkg));
  if (code == null) throw new Error(`${pkg} has no uploads on any track yet. Upload one bundle (internal testing is enough), then run this again.`);
  const { generatedApks = [] } = await play(token, `${pkg}/generatedApks/${code}`);
  const hashes = [...new Set(generatedApks.map((g) => g.certificateSha256Hash).filter(Boolean))];
  if (!hashes.length) throw new Error(`Play hasn't generated APKs for ${pkg} version ${code}. Is Play App Signing on?`);
  return { versionCode: code, hashes };
}
