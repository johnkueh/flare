// Must load before @peculiar/x509 (see ./apple.ts).
import "reflect-metadata";
import { X509Certificate } from "@peculiar/x509";
import {
  advanceCounter,
  allowsDevelopment,
  ANDROID_APP_ID_PREFIX,
  type AssertionResult,
  concat,
  consumeChallenge,
  derChildren,
  derRead,
  derToRawSignature,
  equal,
  fromBase64,
  type RegisterResult,
  sha256,
  toBase64,
} from "./apple";
import type { AttestEnv as Env } from "./env";

// Android Keystore key attestation, the Android app's stand-in for App
// Attest. Same shape: the app generates a hardware-backed EC key whose
// certificate chain carries our challenge (registration), then signs a
// fresh challenge with it whenever it signs in. The chain is checked
// offline against Google's attestation roots, so no Google account or API
// key is involved. Ported from Cooked's api/src/android-attest.ts.
// https://developer.android.com/privacy-and-security/security-key-attestation

/** Google's hardware attestation roots, from
 *  https://android.googleapis.com/attestation/root (fetched 2026-10-05):
 *  the RSA root (2022 re-issue; earlier issues share its key, and roots
 *  are matched by key) and the EC "Key Attestation CA1" root devices are
 *  moving to. */
const GOOGLE_ROOT_PEMS = [
  `-----BEGIN CERTIFICATE-----
MIIFHDCCAwSgAwIBAgIJAPHBcqaZ6vUdMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV
BAUTEGY5MjAwOWU4NTNiNmIwNDUwHhcNMjIwMzIwMTgwNzQ4WhcNNDIwMzE1MTgw
NzQ4WjAbMRkwFwYDVQQFExBmOTIwMDllODUzYjZiMDQ1MIICIjANBgkqhkiG9w0B
AQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xUFmOr75gvMsd/dTEDDJdS
Sxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5jlRfdnJLmN0pTy/4lj4/7
tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y//0rb+T+W8a9nsNL/ggj
nar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73XpXyTqRxB/M0n1n/W9nGq
C4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYImQQcHtGl/m00QLVWutHQ
oVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB+TxywElgS70vE0XmLD+O
JtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7quvmag8jfPioyKvxnK/Eg
sTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgpZrt3i5MIlCaY504LzSRi
igHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7gLiMm0jhO2B6tUXHI/+M
RPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82ixPvZtXQpUpuL12ab+9E
aDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+NpUFgNPN9PvQi8WEg5Um
AGMCAwEAAaNjMGEwHQYDVR0OBBYEFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMB8GA1Ud
IwQYMBaAFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMA8GA1UdEwEB/wQFMAMBAf8wDgYD
VR0PAQH/BAQDAgIEMA0GCSqGSIb3DQEBCwUAA4ICAQB8cMqTllHc8U+qCrOlg3H7
174lmaCsbo/bJ0C17JEgMLb4kvrqsXZs01U3mB/qABg/1t5Pd5AORHARs1hhqGIC
W/nKMav574f9rZN4PC2ZlufGXb7sIdJpGiO9ctRhiLuYuly10JccUZGEHpHSYM2G
tkgYbZba6lsCPYAAP83cyDV+1aOkTf1RCp/lM0PKvmxYN10RYsK631jrleGdcdkx
oSK//mSQbgcWnmAEZrzHoF1/0gso1HZgIn0YLzVhLSA/iXCX4QT2h3J5z3znluKG
1nv8NQdxei2DIIhASWfu804CA96cQKTTlaae2fweqXjdN1/v2nqOhngNyz1361mF
mr4XmaKH/ItTwOe72NI9ZcwS1lVaCvsIkTDCEXdm9rCNPAY10iTunIHFXRh+7KPz
lHGewCq/8TOohBRn0/NNfh7uRslOSZ/xKbN9tMBtw37Z8d2vvnXq/YWdsm1+JLVw
n6yYD/yacNJBlwpddla8eaVMjsF6nBnIgQOf9zKSe06nSTqvgwUHosgOECZJZ1Eu
zbH4yswbt02tKtKEFhx+v+OTge/06V+jGsqTWLsfrOCNLuA8H++z+pUENmpqnnHo
vaI47gC+TNpkgYGkkBT6B/m/U01BuOBBTzhIlMEZq9qkDWuM2cA5kW5V3FJUcfHn
w1IdYIg2Wxg7yHcQZemFQg==
-----END CERTIFICATE-----`,
  `-----BEGIN CERTIFICATE-----
MIICIjCCAaigAwIBAgIRAISp0Cl7DrWK5/8OgN52BgUwCgYIKoZIzj0EAwMwUjEc
MBoGA1UEAwwTS2V5IEF0dGVzdGF0aW9uIENBMTEQMA4GA1UECwwHQW5kcm9pZDET
MBEGA1UECgwKR29vZ2xlIExMQzELMAkGA1UEBhMCVVMwHhcNMjUwNzE3MjIzMjE4
WhcNMzUwNzE1MjIzMjE4WjBSMRwwGgYDVQQDDBNLZXkgQXR0ZXN0YXRpb24gQ0Ex
MRAwDgYDVQQLDAdBbmRyb2lkMRMwEQYDVQQKDApHb29nbGUgTExDMQswCQYDVQQG
EwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABCPaI3FO3z5bBQo8cuiEas4HjqCt
G/mLFfRT0MsIssPBEEU5Cfbt6sH5yOAxqEi5QagpU1yX4HwnGb7OtBYpDTB57uH5
Eczm34A5FNijV3s0/f0UPl7zbJcTx6xwqMIRq6NCMEAwDwYDVR0TAQH/BAUwAwEB
/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFFIyuyz7RkOb3NaBqQ5lZuA0QepA
MAoGCCqGSM49BAMDA2gAMGUCMETfjPO/HwqReR2CS7p0ZWoD/LHs6hDi422opifH
EUaYLxwGlT9SLdjkVpz0UUOR5wIxAIoGyxGKRHVTpqpGRFiJtQEOOTp/+s1GcxeY
uR2zh/80lQyu9vAFCj6E4AXc+osmRg==
-----END CERTIFICATE-----`,
];

const KEY_DESCRIPTION_EXTENSION = "1.3.6.1.4.1.11129.2.1.17";
/** AuthorizationList tag of attestationApplicationId. */
const ATTESTATION_APPLICATION_ID_TAG = 709;
/** KeyDescription's SecurityLevel: Software 0, TrustedEnvironment 1, StrongBox 2. */
const HARDWARE_SECURITY_LEVELS = [1, 2];

// -- attestation ---------------------------------------------------------------

/** Verifies a Keystore certificate chain and stores its key. As with App
 *  Attest, the challenge is consumed first, so a failed attempt can't be
 *  retried with it. */
export async function registerAndroidKey(
  env: Env,
  input: { keyId: string; certificateChain: string[]; challenge: string },
): Promise<RegisterResult> {
  if (!(await consumeChallenge(env, input.challenge))) {
    return { ok: false, reason: "challenge", detail: "unknown, used or expired challenge" };
  }
  const fail = (detail: string): RegisterResult => ({ ok: false, reason: "attestation", detail });

  const keyId = fromBase64(input.keyId);
  if (keyId?.length !== 32) return fail("keyId isn't 32 bytes of base64");

  let chain: X509Certificate[];
  try {
    chain = input.certificateChain.map((b64) => new X509Certificate(fromBase64(b64) ?? new Uint8Array()));
  } catch {
    return fail("unparseable certificate");
  }
  if (chain.length < 2) return fail("chain has no root");
  const leaf = chain[0];

  // 1. Each certificate is signed by the next, and the last is a root.
  const root = await verifyChain(env, chain);
  if (!root) return fail("certificate chain doesn't verify");

  // 2. Only the leaf describes a key. An attested key could otherwise sign
  //    a certificate of its own with any key description it liked.
  if (chain.slice(1).some((cert) => cert.getExtension(KEY_DESCRIPTION_EXTENSION))) {
    return fail("key description outside the leaf");
  }
  const extension = leaf.getExtension(KEY_DESCRIPTION_EXTENSION);
  const description = extension ? parseKeyDescription(new Uint8Array(extension.value)) : null;
  if (!description) return fail("missing or malformed key description");

  // 3. The key was made for this challenge.
  const challengeHash = await sha256(new TextEncoder().encode(input.challenge));
  if (!equal(description.challenge, challengeHash)) return fail("challenge mismatch");

  // 4. By our app, signed with our certificate.
  const app = description.applicationId ? parseApplicationId(description.applicationId) : null;
  if (!app) return fail("missing or malformed attestationApplicationId");
  const packageName = listVar(env.ANDROID_APP_IDS).find((id) => app.packageNames.includes(id));
  if (!packageName) return fail("no package in ANDROID_APP_IDS");
  const digests = listVar(env.ANDROID_CERT_DIGESTS).map((d) => d.toLowerCase());
  if (digests.length && !app.signatureDigests.some((d) => digests.includes(d))) {
    return fail("signing certificate isn't in ANDROID_CERT_DIGESTS");
  }

  // 5. The key the app named is the one certified, and it's P-256.
  const spki = new Uint8Array(leaf.publicKey.rawData);
  try {
    await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    return fail("leaf key isn't P-256");
  }
  if (!equal(await sha256(spki), keyId)) return fail("keyId doesn't match the certified key");

  // 6. Hardware-backed under Google's root is production; anything else
  //    (software keystore, emulator, another root) is development.
  let environment: "production" | "development";
  if (root === "google" && HARDWARE_SECURITY_LEVELS.includes(description.securityLevel)) {
    environment = "production";
  } else if (allowsDevelopment(env)) environment = "development";
  else return fail("development attestation not allowed");

  // Never overwrite an existing key: that would reset its counter.
  await env.DB.prepare(
    `INSERT INTO attest_keys (key_id, public_key, sign_count, environment, app_id, receipt, created_at)
     VALUES (?, ?, 0, ?, ?, NULL, ?) ON CONFLICT (key_id) DO NOTHING`,
  )
    .bind(toBase64(keyId), toBase64(spki), environment, `${ANDROID_APP_ID_PREFIX}${packageName}`, Date.now())
    .run();
  return { ok: true, keyId: toBase64(keyId) };
}

/** "google" when the chain ends at one of Google's roots (or the test
 *  root), "self-signed" when it ends at any other root that signs itself,
 *  null when it doesn't verify. A root matches by key, and its embedded
 *  copy's dates count, not the device's copy (old devices carry expired
 *  issues of the RSA root). */
async function verifyChain(env: Env, chain: X509Certificate[]): Promise<"google" | "self-signed" | null> {
  const date = new Date();
  try {
    for (let i = 0; i < chain.length - 1; i++) {
      if (!(await chain[i].verify({ publicKey: chain[i + 1], date }))) return null;
    }
    const last = chain[chain.length - 1];
    const lastKey = new Uint8Array(last.publicKey.rawData);
    const trusted = env.ANDROID_ATTEST_TEST_ROOT_PEM ? [env.ANDROID_ATTEST_TEST_ROOT_PEM] : GOOGLE_ROOT_PEMS;
    for (const pem of trusted) {
      const root = new X509Certificate(pem);
      if (equal(new Uint8Array(root.publicKey.rawData), lastKey)) {
        return root.notBefore < date && date < root.notAfter ? "google" : null;
      }
    }
    return (await last.verify({ publicKey: last, date })) ? "self-signed" : null;
  } catch {
    return null;
  }
}

// -- assertions ----------------------------------------------------------------

/** Checks a request signed with a registered Keystore key:
 *  `X-Android-Signature` is ECDSA P-256 / SHA-256 (DER, base64) over
 *  `SHA256(body) ‖ counter as 8 bytes big-endian`, and `X-Android-Counter`
 *  must be higher than any the key has used. Same result codes as App
 *  Attest assertions. */
export async function verifyAndroidAssertion(
  env: Env,
  headers: Headers,
  body: Uint8Array,
): Promise<AssertionResult> {
  const keyIdHeader = headers.get("X-Android-Key-Id");
  const counterHeader = headers.get("X-Android-Counter");
  const signatureHeader = headers.get("X-Android-Signature");
  if (!keyIdHeader || !counterHeader || !signatureHeader) {
    return { ok: false, code: "ATTESTATION_REQUIRED", detail: "missing headers" };
  }
  const keyIdBytes = fromBase64(keyIdHeader);
  const row = keyIdBytes
    ? await env.DB.prepare("SELECT public_key, environment, app_id FROM attest_keys WHERE key_id = ?")
        .bind(toBase64(keyIdBytes))
        .first<{ public_key: string; environment: string; app_id: string }>()
    : null;
  // App Attest keys only sign the Apple way; development keys stop
  // working if development is switched off.
  if (
    !row ||
    !row.app_id.startsWith(ANDROID_APP_ID_PREFIX) ||
    (row.environment === "development" && !allowsDevelopment(env))
  ) {
    return { ok: false, code: "ATTESTATION_REQUIRED", detail: "unknown key" };
  }
  const keyId = toBase64(keyIdBytes!);
  const invalid = (detail: string): AssertionResult => ({ ok: false, code: "INVALID_ASSERTION", detail });

  if (!/^\d{1,15}$/.test(counterHeader.trim())) return invalid("counter isn't a whole number");
  const counter = Number(counterHeader.trim());
  const counterBytes = new Uint8Array(8);
  new DataView(counterBytes.buffer).setBigUint64(0, BigInt(counter));

  const signature = fromBase64(signatureHeader);
  const rawSignature = signature && derToRawSignature(signature);
  const key = await crypto.subtle.importKey(
    "spki",
    fromBase64(row.public_key)!,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const message = concat(await sha256(body), counterBytes);
  const valid =
    !!rawSignature && (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, rawSignature, message));
  if (!valid) return invalid("bad signature");

  if (!(await advanceCounter(env, keyId, counter))) return invalid("counter didn't increase");
  return { ok: true, keyId };
}

// -- formats -------------------------------------------------------------------

type KeyDescription = {
  securityLevel: number;
  challenge: Uint8Array;
  /** attestationApplicationId's DER, from either authorization list. */
  applicationId: Uint8Array | null;
};

/** KeyDescription ::= SEQUENCE { attestationVersion INTEGER,
 *  attestationSecurityLevel ENUMERATED, keyMintVersion INTEGER,
 *  keyMintSecurityLevel ENUMERATED, attestationChallenge OCTET STRING,
 *  uniqueId OCTET STRING, softwareEnforced AuthorizationList,
 *  hardwareEnforced AuthorizationList, … }
 *  https://source.android.com/docs/security/features/keystore/attestation#schema */
function parseKeyDescription(der: Uint8Array): KeyDescription | null {
  const sequence = derRead(der, 0x30);
  const fields = sequence && derChildren(sequence.content);
  if (!fields || fields.length < 8) return null;
  const expected = [0x02, 0x0a, 0x02, 0x0a, 0x04, 0x04, 0x30, 0x30];
  if (expected.some((tag, i) => fields[i].tag !== tag)) return null;
  const level = fields[1].content;
  if (level.length !== 1) return null;

  // Each AuthorizationList is a SEQUENCE of [tag] EXPLICIT values.
  let applicationId: Uint8Array | null = null;
  for (const list of [fields[6], fields[7]]) {
    const entries = derChildren(list.content);
    if (!entries) return null;
    const entry = entries.find((e) => (e.tag & 0xe0) === 0xa0 && e.number === ATTESTATION_APPLICATION_ID_TAG);
    applicationId ??= (entry && derRead(entry.content, 0x04)?.content) ?? null;
  }
  return { securityLevel: level[0], challenge: fields[4].content, applicationId };
}

/** AttestationApplicationId ::= SEQUENCE {
 *    packageInfos SET OF SEQUENCE { packageName OCTET STRING, version INTEGER },
 *    signatureDigests SET OF OCTET STRING } */
function parseApplicationId(der: Uint8Array): { packageNames: string[]; signatureDigests: string[] } | null {
  const sequence = derRead(der, 0x30);
  const packages = sequence && derRead(sequence.content, 0x31);
  const digests = packages && derRead(sequence.content.subarray(packages.end), 0x31);
  const packageInfos = packages && derChildren(packages.content);
  const digestValues = digests && derChildren(digests.content);
  if (!packageInfos || !digestValues) return null;

  const packageNames: string[] = [];
  for (const info of packageInfos) {
    const name = info.tag === 0x30 ? derRead(info.content, 0x04) : null;
    if (!name) return null;
    packageNames.push(new TextDecoder().decode(name.content));
  }
  if (digestValues.some((d) => d.tag !== 0x04)) return null;
  return { packageNames, signatureDigests: digestValues.map((d) => toHex(d.content)) };
}

// -- helpers -------------------------------------------------------------------

function listVar(value: string | undefined): string[] {
  return (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
