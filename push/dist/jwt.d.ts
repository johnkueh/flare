export declare function base64url(bytes: Uint8Array | string): string;
/** The DER bytes inside a PEM ("-----BEGIN PRIVATE KEY-----"), or of a
 *  bare base64 body. Escaped newlines (as in a JSON secret) are fine. */
export declare function pemBytes(pem: string): Uint8Array<ArrayBuffer>;
export type Alg = "ES256" | "RS256";
export declare function importKey(alg: Alg, pem: string): Promise<CryptoKey>;
/** header.claims.signature. ECDSA's WebCrypto output is already JWS's r||s. */
export declare function signJwt(alg: Alg, key: CryptoKey, header: object, claims: object): Promise<string>;
