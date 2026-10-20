// Signed tokens with WebCrypto only. Signing: ES256 for the App Store
// Server API (the In-App Purchase .p8 key) and RS256 for Google's OAuth
// (the service account key), the same signer as @flare/push. Reading:
// splitting a JWS and checking an RS256 or ES256 signature.

export function base64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64 or base64url to bytes. */
export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The DER bytes inside a PEM ("-----BEGIN PRIVATE KEY-----"), or of a
 *  bare base64 body. Escaped newlines (as in a JSON secret) are fine. */
export function pemBytes(pem: string): Uint8Array<ArrayBuffer> {
  return fromBase64(pem.replace(/\\n/g, "\n").replace(/-----(BEGIN|END)[^-]+-----/g, ""));
}

export type Alg = "ES256" | "RS256";

const PARAMS = {
  ES256: { key: { name: "ECDSA", namedCurve: "P-256" }, sign: { name: "ECDSA", hash: "SHA-256" } },
  RS256: { key: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, sign: { name: "RSASSA-PKCS1-v1_5" } },
} as const;

export function importKey(alg: Alg, pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pemBytes(pem), PARAMS[alg].key, false, ["sign"]);
}

/** header.claims.signature. ECDSA's WebCrypto output is already JWS's r||s. */
export async function signJwt(alg: Alg, key: CryptoKey, header: object, claims: object): Promise<string> {
  const input = `${base64url(JSON.stringify({ alg, typ: "JWT", ...header }))}.${base64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign(PARAMS[alg].sign, key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(sig))}`;
}

export type Jws = { header: Record<string, unknown>; payload: Record<string, unknown>; input: Uint8Array<ArrayBuffer>; signature: Uint8Array<ArrayBuffer> };

/** The parts of a compact JWS, unverified. Throws on anything else. */
export function splitJws(jws: string): Jws {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("not a JWS");
  const decode = (s: string) => JSON.parse(new TextDecoder().decode(fromBase64(s))) as Record<string, unknown>;
  return {
    header: decode(parts[0]),
    payload: decode(parts[1]),
    input: new Uint8Array(new TextEncoder().encode(`${parts[0]}.${parts[1]}`)),
    signature: fromBase64(parts[2]),
  };
}

/** Checks a JWS signature with a public key (ES256 r||s, or RS256). */
export function verifyJws(alg: Alg, key: CryptoKey, jws: Jws): Promise<boolean> {
  return crypto.subtle.verify(PARAMS[alg].sign, key, jws.signature, jws.input);
}
