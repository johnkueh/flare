// The App Store side: Apple's signed JWS (a transaction, renewal info or a
// whole App Store Server Notification) checked against Apple's root
// certificate, and the App Store Server API's "Get All Subscription
// Statuses", which every notification re-reads instead of trusting the
// order notifications arrive in.

import { fromBase64, importKey, signJwt, splitJws, verifyJws } from "./jwt.ts";
import { equal, parseCertificate, publicKey, signedBy, type Certificate } from "./x509.ts";
import type { State } from "./state.ts";

/** Apple Root CA - G3 (SHA-256 63:34:3A:BF:…:3E:91:79), from
 *  https://www.apple.com/certificateauthority/AppleRootCA-G3.cer */
export const APPLE_ROOT_CA_G3 =
  "MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==";

// Apple marks the certificates that may sign App Store data with these
// extensions (the same check as Apple's App Store Server Library).
const LEAF_MARKER = "1.2.840.113635.100.6.11.1";
const INTERMEDIATE_MARKER = "1.2.840.113635.100.6.2.1";

export class AppleSignatureError extends Error {}

/** The payload of a JWS Apple signed, after checking its x5c chain ends at
 *  one of `roots` (base64 DER; default Apple Root CA - G3) and the leaf
 *  signed it. Throws AppleSignatureError otherwise. */
export async function verifyAppleJws(jws: string, roots: string[] = [APPLE_ROOT_CA_G3], now = Date.now()): Promise<Record<string, unknown>> {
  let parts: ReturnType<typeof splitJws>;
  try {
    parts = splitJws(jws);
  } catch {
    throw new AppleSignatureError("not a JWS");
  }
  const x5c = parts.header.x5c;
  if (parts.header.alg !== "ES256" || !Array.isArray(x5c) || x5c.length !== 3) throw new AppleSignatureError("expected ES256 with a three-certificate x5c");
  let chain: Certificate[];
  try {
    chain = x5c.map((c) => parseCertificate(fromBase64(String(c))));
  } catch (e) {
    throw new AppleSignatureError(`bad certificate: ${(e as Error).message}`);
  }
  const [leaf, intermediate, root] = chain;
  if (!roots.some((r) => equal(fromBase64(r), root.der))) throw new AppleSignatureError("chain doesn't end at a trusted Apple root");
  for (const cert of chain) {
    if (now < cert.notBefore || now > cert.notAfter) throw new AppleSignatureError("certificate outside its validity period");
  }
  if (!intermediate.isCA || !intermediate.extensions.includes(INTERMEDIATE_MARKER)) throw new AppleSignatureError("intermediate isn't Apple's");
  if (!leaf.extensions.includes(LEAF_MARKER)) throw new AppleSignatureError("leaf isn't an App Store signing certificate");
  if (!(await signedBy(intermediate, root)) || !(await signedBy(leaf, intermediate))) throw new AppleSignatureError("broken certificate chain");
  if (leaf.curve !== "P-256" || !(await verifyJws("ES256", await publicKey(leaf), parts))) throw new AppleSignatureError("bad signature");
  return parts.payload;
}

/** The fields of a JWSTransactionDecodedPayload this package uses. */
export interface AppleTransaction {
  originalTransactionId: string;
  transactionId: string;
  bundleId: string;
  productId: string;
  environment: "Sandbox" | "Production" | string;
  purchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  appAccountToken?: string;
  type?: string;
}

export function asTransaction(payload: Record<string, unknown>): AppleTransaction {
  const t = payload as unknown as AppleTransaction;
  if (typeof t.originalTransactionId !== "string" || typeof t.bundleId !== "string" || typeof t.productId !== "string") {
    throw new AppleSignatureError("not a transaction");
  }
  return t;
}

/** Status in Get All Subscription Statuses: 1 active, 2 expired, 3 billing
 *  retry, 4 grace period, 5 revoked. Auto-renew off while active is
 *  "canceled": access lasts until expiresDate. */
export function appleState(status: number | undefined, autoRenew: boolean | undefined, t: AppleTransaction, now: number): State {
  if (t.revocationDate) return "revoked";
  switch (status) {
    case 1:
      return autoRenew === false ? "canceled" : "active";
    case 2:
      return "expired";
    case 3:
      return "hold";
    case 4:
      return "grace";
    case 5:
      return "revoked";
    default:
      // No status (a client report without the API set up): go by expiry.
      return t.expiresDate && t.expiresDate > now ? "active" : "expired";
  }
}

/** The App Store Server API key: an In-App Purchase key from App Store
 *  Connect (Users and Access → Integrations). */
export interface AppleApiKey {
  keyP8: string;
  keyId: string;
  issuerId: string;
}

const API = { Production: "https://api.storekit.itunes.apple.com", Sandbox: "https://api.storekit-sandbox.itunes.apple.com" };

let cachedToken: { key: string; bundleId: string; token: string; expires: number } | null = null;

export function resetAppleToken() {
  cachedToken = null;
}

async function apiToken(key: AppleApiKey, bundleId: string, now: number): Promise<string> {
  if (cachedToken && cachedToken.key === key.keyId && cachedToken.bundleId === bundleId && now < cachedToken.expires) return cachedToken.token;
  const iat = Math.floor(now / 1000);
  const signer = await importKey("ES256", key.keyP8);
  // Apple allows up to an hour; renew five minutes early.
  const token = await signJwt("ES256", signer, { kid: key.keyId }, { iss: key.issuerId, iat, exp: iat + 3600, aud: "appstoreconnect-v1", bid: bundleId });
  cachedToken = { key: key.keyId, bundleId, token, expires: now + 55 * 60 * 1000 };
  return token;
}

export type AppleStatus = { status: number; signedTransactionInfo: string; signedRenewalInfo?: string };

/** The latest status of the subscription `originalTransactionId` belongs
 *  to, or null when Apple doesn't know it. */
export async function subscriptionStatus(
  key: AppleApiKey,
  t: Pick<AppleTransaction, "originalTransactionId" | "bundleId" | "environment">,
  doFetch: typeof fetch,
  now: number,
): Promise<AppleStatus | null> {
  const base = t.environment === "Sandbox" ? API.Sandbox : API.Production;
  const res = await doFetch(`${base}/inApps/v1/subscriptions/${encodeURIComponent(t.originalTransactionId)}`, {
    headers: { authorization: `Bearer ${await apiToken(key, t.bundleId, now)}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`App Store Server API: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { lastTransactions?: (AppleStatus & { originalTransactionId: string })[] }[] };
  for (const group of body.data ?? []) {
    for (const last of group.lastTransactions ?? []) {
      if (last.originalTransactionId === t.originalTransactionId) return last;
    }
  }
  return null;
}

/** A deterministic UUID for a user, for StoreKit's appAccountToken and
 *  Play's obfuscated account id (both want an opaque value, not the id). */
export async function accountToken(userId: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`flare-billing:${userId}`)));
  hash[6] = (hash[6] & 0x0f) | 0x80; // UUID version 8 (custom)
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = [...hash.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
