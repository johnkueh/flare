// The two signed tokens push needs, with WebCrypto only: ES256 for APNs
// (the .p8 key) and RS256 for Google's OAuth (the service account key).

export function base64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The DER bytes inside a PEM ("-----BEGIN PRIVATE KEY-----"), or of a
 *  bare base64 body. Escaped newlines (as in a JSON secret) are fine. */
export function pemBytes(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----(BEGIN|END)[^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
