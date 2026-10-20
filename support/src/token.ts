// Signed tokens: `<base64url JSON>.<base64url HMAC-SHA256>`. No dependencies, so an app's own
// Worker can import this to vouch for its signed-in user:
//
//   import { signIdentity } from "@flare/support/token";
//   // GET /api/support-token, for a signed-in user only
//   return Response.json({ token: await signIdentity(env.SUPPORT_APP_SECRET, { app: "ledgersignal", sub: user.id, email: user.email, name: user.name, org: firm.name }) });
//
// The widget passes the token to the support Worker, which checks it against the same per-app
// secret (APP_SECRETS) before it treats the visitor as that user.

/** Who the app says the visitor is. `sub` is the app's own user id. */
export type Identity = { app: string; sub: string; email?: string; name?: string; org?: string };

const encoder = new TextEncoder();

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const keys = new Map<string, Promise<CryptoKey>>();
const key = (secret: string) => {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, k);
  }
  return k;
};

/** HMAC-SHA256 of `data`, base64url. */
export async function hmac(secret: string, data: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(data))));
}

/** Signs `payload` with an expiry `ttlSeconds` from now. */
export async function sign(secret: string, payload: object, ttlSeconds: number): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  return `${body}.${await hmac(secret, body)}`;
}

/** The payload, or null when the signature is wrong, the token expired or it isn't one of ours. */
export async function verify<T>(secret: string, token: string): Promise<T | null> {
  const [body, sig, extra] = token.split(".");
  if (!(body && sig) || extra !== undefined) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await key(secret), fromB64url(sig), encoder.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as T & { exp?: number };
    if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

/** A token for the widget saying who the signed-in visitor is. Short-lived: the widget asks again on each page load. */
export const signIdentity = (appSecret: string, identity: Identity, ttlSeconds = 600) => sign(appSecret, identity, ttlSeconds);
