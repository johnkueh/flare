// The Google Play side: the Play Developer API as a service account
// (purchases.subscriptionsv2.get, and acknowledge, which Play needs within
// three days or it refunds the purchase), and checking the OIDC token
// Pub/Sub signs when it pushes a Real-Time Developer Notification.

import { importKey, signJwt, splitJws, verifyJws } from "./jwt.ts";
import type { State } from "./state.ts";

/** The service account JSON Google Cloud gives you (the fields used). */
export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const PUBLISHER = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

let cached: { email: string; token: string; expires: number } | null = null;

export function resetGoogleToken() {
  cached = null;
  jwks = null;
}

async function accessToken(account: GoogleServiceAccount, doFetch: typeof fetch, now: number): Promise<string> {
  if (cached && cached.email === account.client_email && now < cached.expires) return cached.token;
  const iat = Math.floor(now / 1000);
  const uri = account.token_uri ?? TOKEN_URI;
  const key = await importKey("RS256", account.private_key);
  const assertion = await signJwt("RS256", key, {}, { iss: account.client_email, scope: SCOPE, aud: uri, iat, exp: iat + 3600 });
  const res = await doFetch(uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!res.ok) throw new Error(`Google OAuth: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  // Renew five minutes early.
  cached = { email: account.client_email, token: body.access_token, expires: now + ((body.expires_in ?? 3600) - 300) * 1000 };
  return body.access_token;
}

/** The fields of a SubscriptionPurchaseV2 this package uses. */
export interface SubscriptionPurchaseV2 {
  subscriptionState?: string;
  acknowledgementState?: string;
  startTime?: string;
  linkedPurchaseToken?: string;
  testPurchase?: object;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  lineItems?: { productId: string; expiryTime?: string }[];
}

/** The purchase, or null when Play doesn't know the token (404/410). */
export async function getSubscription(
  account: GoogleServiceAccount,
  packageName: string,
  token: string,
  doFetch: typeof fetch,
  now: number,
): Promise<SubscriptionPurchaseV2 | null> {
  const res = await doFetch(`${PUBLISHER}/${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`, {
    headers: { authorization: `Bearer ${await accessToken(account, doFetch, now)}` },
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`Play Developer API: HTTP ${res.status}`);
  return (await res.json()) as SubscriptionPurchaseV2;
}

/** Acknowledges a subscription purchase. True when Play took it (or it was
 *  already acknowledged). */
export async function acknowledge(
  account: GoogleServiceAccount,
  packageName: string,
  productId: string,
  token: string,
  doFetch: typeof fetch,
  now: number,
): Promise<boolean> {
  const url = `${PUBLISHER}/${encodeURIComponent(packageName)}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`;
  const res = await doFetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken(account, doFetch, now)}`, "content-type": "application/json" },
    body: "{}",
  });
  return res.ok;
}

const STATES: Record<string, State> = {
  SUBSCRIPTION_STATE_ACTIVE: "active",
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "grace",
  SUBSCRIPTION_STATE_CANCELED: "canceled",
  SUBSCRIPTION_STATE_ON_HOLD: "hold",
  SUBSCRIPTION_STATE_PAUSED: "paused",
  SUBSCRIPTION_STATE_PENDING: "pending",
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "expired",
  SUBSCRIPTION_STATE_EXPIRED: "expired",
};

export type GoogleSummary = {
  state: State;
  productId: string | null;
  expiresAt: number | null;
  startedAt: number | null;
  acknowledged: boolean;
  accountToken: string | null;
  linkedPurchaseToken: string | null;
  test: boolean;
};

/** A purchase in this package's terms. An unknown state (Play adds one
 *  now and then) reads as "pending": no access, and logged by the caller. */
export function summarize(p: SubscriptionPurchaseV2): GoogleSummary {
  const expiries = (p.lineItems ?? []).map((l) => (l.expiryTime ? Date.parse(l.expiryTime) : Number.NaN)).filter((n) => !Number.isNaN(n));
  return {
    state: STATES[p.subscriptionState ?? ""] ?? "pending",
    productId: p.lineItems?.[0]?.productId ?? null,
    expiresAt: expiries.length ? Math.max(...expiries) : null,
    startedAt: p.startTime ? Date.parse(p.startTime) : null,
    acknowledged: p.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    accountToken: p.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
    linkedPurchaseToken: p.linkedPurchaseToken ?? null,
    test: Boolean(p.testPurchase),
  };
}

export function knownState(p: SubscriptionPurchaseV2): boolean {
  return (p.subscriptionState ?? "") in STATES;
}

// Pub/Sub push authentication: Google signs an OIDC token (RS256) for the
// service account named on the push subscription.

const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

let jwks: { keys: (JsonWebKey & { kid?: string })[]; expires: number } | null = null;

async function googleKey(kid: string, doFetch: typeof fetch, now: number): Promise<CryptoKey | null> {
  if (!jwks || now >= jwks.expires || !jwks.keys.some((k) => k.kid === kid)) {
    const res = await doFetch(GOOGLE_CERTS);
    if (!res.ok) throw new Error(`Google certs: HTTP ${res.status}`);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
    jwks = { keys: ((await res.json()) as { keys: (JsonWebKey & { kid?: string })[] }).keys, expires: now + maxAge * 1000 };
  }
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk) return null;
  const { kid: _kid, ...key } = jwk;
  return crypto.subtle.importKey("jwk", { ...key, alg: "RS256" }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

/** Null when `authorization` carries a token Google signed for `audience`
 *  on behalf of `email`; otherwise why not. */
export async function checkPushToken(
  authorization: string | null,
  expected: { audience: string; email: string },
  doFetch: typeof fetch,
  now: number,
): Promise<string | null> {
  const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
  if (!token) return "no bearer token";
  let jws: ReturnType<typeof splitJws>;
  try {
    jws = splitJws(token);
  } catch {
    return "not a JWT";
  }
  if (jws.header.alg !== "RS256" || typeof jws.header.kid !== "string") return "not an RS256 token";
  const key = await googleKey(jws.header.kid, doFetch, now);
  if (!key || !(await verifyJws("RS256", key, jws))) return "bad signature";
  const c = jws.payload;
  if (!ISSUERS.includes(String(c.iss))) return "wrong issuer";
  if (c.aud !== expected.audience) return "wrong audience";
  if (c.email !== expected.email || c.email_verified !== true) return "wrong service account";
  if (typeof c.exp !== "number" || c.exp * 1000 < now) return "expired";
  return null;
}

/** A Real-Time Developer Notification, decoded from the Pub/Sub message. */
export interface DeveloperNotification {
  packageName: string;
  eventTimeMillis?: string;
  subscriptionNotification?: { notificationType: number; purchaseToken: string };
  voidedPurchaseNotification?: { purchaseToken: string; productType?: number };
  testNotification?: object;
}

export function decodeNotification(body: unknown): DeveloperNotification | null {
  const data = (body as { message?: { data?: string } } | null)?.message?.data;
  if (typeof data !== "string") return null;
  try {
    const n = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))) as DeveloperNotification;
    return typeof n.packageName === "string" ? n : null;
  } catch {
    return null;
  }
}
