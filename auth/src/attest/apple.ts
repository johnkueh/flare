// Must load before @peculiar/x509: its DI container (tsyringe) throws at
// import time without a Reflect metadata polyfill.
import "reflect-metadata";
import { X509Certificate } from "@peculiar/x509";
import { decode } from "cborg";
import type { AttestEnv as Env } from "./env";

// Apple App Attest, following "Validating apps that connect to your server".
// A device proves it's a genuine copy of the app by registering a Secure
// Enclave key once (attestation), then signs a fresh challenge with it
// (assertion) whenever it signs in. Keys are stored in D1 (attest_keys).
// Ported from Cooked's api/src/attest.ts; the import-token half is gone,
// since Better Auth's bearer sessions replace it.

/** Apple App Attestation Root CA, from apple.com/certificateauthority. */
const APPLE_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

const NONCE_EXTENSION = "1.2.840.113635.100.8.2";
/** attest_keys.app_id of Android keys is "android:<package name>". */
export const ANDROID_APP_ID_PREFIX = "android:";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// aaguid is 16 bytes: "appattestdevelop", or "appattest" padded with zeros.
const AAGUID_PRODUCTION = padTo16("appattest");
const AAGUID_DEVELOPMENT = padTo16("appattestdevelop");

// -- challenges ----------------------------------------------------------------

/** A random one-time challenge, valid for five minutes. The app hashes its
 *  UTF-8 bytes into the attestation's clientDataHash. */
export async function newChallenge(env: Env): Promise<string> {
  const challenge = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  // Expired rows are swept here rather than by a cron.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attest_challenges WHERE expires_at < ?").bind(now),
    env.DB.prepare("INSERT INTO attest_challenges (challenge, expires_at) VALUES (?, ?)").bind(
      challenge,
      now + CHALLENGE_TTL_MS,
    ),
  ]);
  return challenge;
}

/** Deletes the challenge; true only if it existed and hadn't expired. */
export async function consumeChallenge(env: Env, challenge: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "DELETE FROM attest_challenges WHERE challenge = ? RETURNING expires_at",
  )
    .bind(challenge)
    .first<{ expires_at: number }>();
  return !!row && row.expires_at > Date.now();
}

// -- attestation ---------------------------------------------------------------

export type RegisterResult =
  | { ok: true; keyId: string }
  | { ok: false; reason: "challenge" | "attestation"; detail: string };

/** Verifies an attestation object and stores the key. The challenge is
 *  consumed first, so a failed attempt can't be retried with it. */
export async function registerKey(
  env: Env,
  input: { keyId: string; attestation: string; challenge: string },
): Promise<RegisterResult> {
  if (!(await consumeChallenge(env, input.challenge))) {
    return { ok: false, reason: "challenge", detail: "unknown, used or expired challenge" };
  }
  const fail = (detail: string): RegisterResult => ({ ok: false, reason: "attestation", detail });

  const keyId = fromBase64(input.keyId);
  if (keyId?.length !== 32) return fail("keyId isn't 32 bytes of base64");

  let attestation: { fmt?: unknown; attStmt?: { x5c?: unknown; receipt?: unknown }; authData?: unknown };
  try {
    attestation = decode(fromBase64(input.attestation) ?? new Uint8Array()) as typeof attestation;
  } catch {
    return fail("attestation isn't CBOR");
  }
  if (attestation?.fmt !== "apple-appattest") return fail("fmt isn't apple-appattest");
  const x5c = attestation.attStmt?.x5c;
  const authData = attestation.authData;
  if (!Array.isArray(x5c) || x5c.length < 2 || !x5c.every(isBytes) || !isBytes(authData)) {
    return fail("missing x5c or authData");
  }

  // 1. The certificate chain ends at Apple's root (or the test root).
  let leaf: X509Certificate;
  let intermediate: X509Certificate;
  try {
    [leaf, intermediate] = x5c.map((der) => new X509Certificate(der));
  } catch {
    return fail("unparseable certificate");
  }
  const root = new X509Certificate(env.APP_ATTEST_TEST_ROOT_PEM || APPLE_ROOT_PEM);
  const date = new Date();
  const chained =
    (await leaf.verify({ publicKey: intermediate, date })) &&
    (await intermediate.verify({ publicKey: root, date })) &&
    root.notBefore < date &&
    date < root.notAfter;
  if (!chained) return fail("certificate chain doesn't verify to the trusted root");

  // 2–4. nonce = SHA256(authData ‖ SHA256(challenge)) is in the leaf.
  const clientDataHash = await sha256(new TextEncoder().encode(input.challenge));
  const nonce = await sha256(concat(authData, clientDataHash));
  const extension = leaf.getExtension(NONCE_EXTENSION);
  const certNonce = extension ? nonceFromExtension(new Uint8Array(extension.value)) : null;
  if (!certNonce || !equal(certNonce, nonce)) return fail("nonce mismatch");

  // 5. The key the app named is the one Apple certified.
  const spki = new Uint8Array(leaf.publicKey.rawData);
  let rawPoint: Uint8Array;
  try {
    const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, true, [
      "verify",
    ]);
    rawPoint = new Uint8Array(await crypto.subtle.exportKey("raw", key) as ArrayBuffer);
  } catch {
    return fail("leaf key isn't P-256");
  }
  if (!equal(await sha256(rawPoint), keyId)) return fail("keyId doesn't match the certified key");

  // 6–9. authData: our app, a fresh key, the right environment.
  const auth = parseAuthData(authData);
  if (!auth?.credentialId) return fail("authData has no attested credential");
  const appId = await matchAppId(env, auth.rpIdHash);
  if (!appId) return fail("rpIdHash isn't one of APP_ATTEST_APP_IDS");
  if (auth.signCount !== 0) return fail("counter isn't 0");
  let environment: "production" | "development";
  if (equal(auth.aaguid, AAGUID_PRODUCTION)) environment = "production";
  else if (equal(auth.aaguid, AAGUID_DEVELOPMENT) && allowsDevelopment(env)) environment = "development";
  else return fail("aaguid not allowed");
  if (!equal(auth.credentialId, keyId)) return fail("credentialId doesn't match keyId");

  // Never overwrite an existing key: that would reset its counter.
  const receipt = attestation.attStmt?.receipt;
  await env.DB.prepare(
    `INSERT INTO attest_keys (key_id, public_key, sign_count, environment, app_id, receipt, created_at)
     VALUES (?, ?, 0, ?, ?, ?, ?) ON CONFLICT (key_id) DO NOTHING`,
  )
    .bind(
      toBase64(keyId),
      toBase64(spki),
      environment,
      appId,
      isBytes(receipt) ? toBase64(receipt) : null,
      Date.now(),
    )
    .run();
  return { ok: true, keyId: toBase64(keyId) };
}

// -- assertions ----------------------------------------------------------------

export type AssertionResult =
  | { ok: true; keyId: string }
  | { ok: false; code: "ATTESTATION_REQUIRED" | "INVALID_ASSERTION"; detail: string };

/** Checks a request's assertion against the stored key. clientData is the
 *  raw request body, so the signature covers exactly what was sent.
 *  ATTESTATION_REQUIRED means "register a key"; INVALID_ASSERTION means
 *  the key is known but this request didn't verify. */
export async function verifyAssertion(
  env: Env,
  headers: Headers,
  body: Uint8Array,
): Promise<AssertionResult> {
  const keyIdHeader = headers.get("X-App-Attest-Key-Id");
  const assertionHeader = headers.get("X-App-Attest-Assertion");
  if (!keyIdHeader || !assertionHeader) {
    return { ok: false, code: "ATTESTATION_REQUIRED", detail: "missing headers" };
  }
  const keyIdBytes = fromBase64(keyIdHeader);
  const row = keyIdBytes
    ? await env.DB.prepare(
        "SELECT public_key, sign_count, environment, app_id FROM attest_keys WHERE key_id = ?",
      )
        .bind(toBase64(keyIdBytes))
        .first<{ public_key: string; sign_count: number; environment: string; app_id: string }>()
    : null;
  // A development key stops working if development is switched off.
  // Android keys only sign the Android way (src/android-attest.ts).
  if (
    !row ||
    (row.environment === "development" && !allowsDevelopment(env)) ||
    row.app_id.startsWith(ANDROID_APP_ID_PREFIX)
  ) {
    return { ok: false, code: "ATTESTATION_REQUIRED", detail: "unknown key" };
  }
  const keyId = toBase64(keyIdBytes!);
  const invalid = (detail: string): AssertionResult => ({ ok: false, code: "INVALID_ASSERTION", detail });

  let assertion: { signature?: unknown; authenticatorData?: unknown };
  try {
    assertion = decode(fromBase64(assertionHeader) ?? new Uint8Array()) as typeof assertion;
  } catch {
    return invalid("assertion isn't CBOR");
  }
  const { signature, authenticatorData } = assertion ?? {};
  if (!isBytes(signature) || !isBytes(authenticatorData)) return invalid("missing signature or authenticatorData");
  const auth = parseAuthData(authenticatorData);
  if (!auth) return invalid("short authenticatorData");

  const nonce = await sha256(concat(authenticatorData, await sha256(body)));
  const rawSignature = derToRawSignature(signature);
  const key = await crypto.subtle.importKey(
    "spki",
    fromBase64(row.public_key)!,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid =
    !!rawSignature &&
    (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, rawSignature, nonce));
  if (!valid) return invalid("bad signature");

  const appIdHash = await sha256(new TextEncoder().encode(row.app_id));
  if (!equal(auth.rpIdHash, appIdHash)) return invalid("rpIdHash mismatch");

  if (!(await advanceCounter(env, keyId, auth.signCount))) return invalid("counter didn't increase");
  return { ok: true, keyId };
}

/** Saves a strictly increasing counter, checked and saved in one statement
 *  so two concurrent requests can't both use the same value. False when
 *  it didn't increase. */
export async function advanceCounter(env: Env, keyId: string, counter: number): Promise<boolean> {
  const saved = await env.DB.prepare(
    "UPDATE attest_keys SET sign_count = ?, last_used_at = ? WHERE key_id = ? AND sign_count < ?",
  )
    .bind(counter, Date.now(), keyId, counter)
    .run();
  return saved.meta.changes > 0;
}

// -- formats -------------------------------------------------------------------

type AuthData = {
  rpIdHash: Uint8Array;
  signCount: number;
  aaguid: Uint8Array;
  credentialId: Uint8Array | null;
};

/** WebAuthn authenticator data: rpIdHash(32) flags(1) signCount(4), then
 *  for attestations aaguid(16) credentialIdLength(2) credentialId … */
function parseAuthData(data: Uint8Array): AuthData | null {
  if (data.length < 37) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: AuthData = {
    rpIdHash: data.subarray(0, 32),
    signCount: view.getUint32(33),
    aaguid: new Uint8Array(),
    credentialId: null,
  };
  if (data.length >= 55) {
    const length = view.getUint16(53);
    out.aaguid = data.subarray(37, 53);
    if (data.length >= 55 + length) out.credentialId = data.subarray(55, 55 + length);
  }
  return out;
}

/** The nonce extension is DER: SEQUENCE { [1] EXPLICIT OCTET STRING }. */
function nonceFromExtension(der: Uint8Array): Uint8Array | null {
  const sequence = derRead(der, 0x30);
  const tagged = sequence && derRead(sequence.content, 0xa1);
  return (tagged && derRead(tagged.content, 0x04)?.content) ?? null;
}

/** App Attest and Android Keystore signatures are DER (X9.62); WebCrypto
 *  wants r ‖ s. */
export function derToRawSignature(der: Uint8Array): Uint8Array | null {
  const sequence = derRead(der, 0x30);
  const r = sequence && derRead(sequence.content, 0x02);
  const s = r && derRead(sequence.content.subarray(r.end), 0x02);
  if (!r || !s) return null;
  const out = new Uint8Array(64);
  for (const [i, n] of [r.content, s.content].entries()) {
    const trimmed = n.subarray(Math.max(0, n.length - 32));
    if (n.length > 33 || (n.length === 33 && n[0] !== 0)) return null;
    out.set(trimmed, i * 32 + 32 - trimmed.length);
  }
  return out;
}

export type DerElement = {
  /** The identifier octet: class, constructed bit and (low) tag number. */
  tag: number;
  /** The tag number, including high-tag-number form ([709] → 709). */
  number: number;
  content: Uint8Array;
  /** Offset just past this element. */
  end: number;
};

/** One DER TLV at the start of `bytes`, if it has the expected tag. */
export function derRead(bytes: Uint8Array, tag: number): DerElement | null {
  const element = derNext(bytes);
  return element?.tag === tag ? element : null;
}

/** The DER TLV at the start of `bytes`, whatever its tag. */
export function derNext(bytes: Uint8Array): DerElement | null {
  if (bytes.length < 2) return null;
  const tag = bytes[0];
  let number = tag & 0x1f;
  let offset = 1;
  if (number === 0x1f) {
    // High tag number: base-128 digits, high bit set on all but the last.
    number = 0;
    do {
      if (offset >= bytes.length || offset > 4) return null;
      number = (number << 7) | (bytes[offset] & 0x7f);
    } while (bytes[offset++] & 0x80);
  }
  if (offset >= bytes.length) return null;
  let length = bytes[offset++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 3 || bytes.length < offset + count) return null;
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | bytes[offset + i];
    offset += count;
  }
  if (offset + length > bytes.length) return null;
  return { tag, number, content: bytes.subarray(offset, offset + length), end: offset + length };
}

/** Every TLV in `bytes` (a SEQUENCE's or SET's content); null if any is
 *  malformed. */
export function derChildren(bytes: Uint8Array): DerElement[] | null {
  const out: DerElement[] = [];
  for (let rest = bytes; rest.length; ) {
    const element = derNext(rest);
    if (!element) return null;
    out.push(element);
    rest = rest.subarray(element.end);
  }
  return out;
}

// -- helpers -------------------------------------------------------------------

export function allowsDevelopment(env: Env): boolean {
  return env.APP_ATTEST_ALLOW_DEVELOPMENT === "true";
}

/** The "<team id>.<bundle id>" whose SHA-256 is rpIdHash, if any. */
async function matchAppId(env: Env, rpIdHash: Uint8Array): Promise<string | null> {
  for (const appId of (env.APP_ATTEST_APP_IDS ?? "").split(",").map((a) => a.trim()).filter(Boolean)) {
    if (equal(await sha256(new TextEncoder().encode(appId)), rpIdHash)) return appId;
  }
  return null;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function padTo16(text: string): Uint8Array {
  const out = new Uint8Array(16);
  out.set(new TextEncoder().encode(text));
  return out;
}

/** Standard or URL-safe base64; null when it isn't base64. */
export function fromBase64(value: string): Uint8Array | null {
  try {
    const normalised = value.trim().replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(normalised), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
