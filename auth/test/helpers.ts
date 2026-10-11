import { env, SELF } from "cloudflare:test";
import { expect } from "vitest";
// attest-ca loads reflect-metadata before x509.
import { createTestCA, type TestCA } from "./attest-ca";
import * as x509 from "@peculiar/x509";
import { encode } from "cborg";

export const BASE = "https://api.test/v1/auth";
export const APP_ID = "ABCDE12345.com.example.app";

/** The CA whose root the Worker trusts in tests (see vitest.config.ts). */
export const trustedCA: TestCA = JSON.parse(env.TEST_ATTEST_CA);
export { createTestCA };

export async function call(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await SELF.fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

export async function challenge(): Promise<string> {
  const res = await call("GET", "/attest/challenge");
  expect(res.status).toBe(200);
  return res.body.challenge;
}

export type AttestationOptions = {
  /** Challenge the nonce is computed from (defaults to the submitted one). */
  nonceChallenge?: string;
  appId?: string;
  aaguid?: "appattest" | "appattestdevelop" | string;
  counter?: number;
  ca?: TestCA;
  credentialId?: Uint8Array;
};

/** A fake iPhone: a P-256 key standing in for the Secure Enclave key, and
 *  the attestation and assertions Apple's DCAppAttestService would produce
 *  for it, signed by a test CA instead of Apple's. */
export class TestDevice {
  counter = 0;

  private constructor(
    readonly keys: CryptoKeyPair,
    readonly keyIdBytes: Uint8Array,
  ) {}

  static async create() {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
    return new TestDevice(keys, await sha256(raw));
  }

  get keyId() {
    return toBase64(this.keyIdBytes);
  }

  /** Base64 attestation object for `challenge`, as attestKey returns it. */
  async attestation(challenge: string, opts: AttestationOptions = {}): Promise<string> {
    const ca = opts.ca ?? trustedCA;
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", this.keys.publicKey)) as ArrayBuffer);
    const credentialId = opts.credentialId ?? this.keyIdBytes;
    const cose = encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, raw.subarray(1, 33)],
        [-3, raw.subarray(33, 65)],
      ]),
    );
    const authData = concat(
      await sha256(utf8(opts.appId ?? APP_ID)),
      Uint8Array.of(0x40),
      uint32(opts.counter ?? 0),
      aaguid(opts.aaguid ?? "appattest"),
      Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff),
      credentialId,
      cose,
    );
    const nonce = await sha256(concat(authData, await sha256(utf8(opts.nonceChallenge ?? challenge))));

    const intermediate = new x509.X509Certificate(ca.intermediatePem);
    const signingKey = await crypto.subtle.importKey(
      "jwk",
      ca.intermediateKey,
      { name: "ECDSA", namedCurve: "P-384" },
      false,
      ["sign"],
    );
    const leaf = await x509.X509CertificateGenerator.create({
      subject: `CN=${toHex(this.keyIdBytes)}`,
      issuer: intermediate.subject,
      publicKey: this.keys.publicKey,
      signingKey,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 24 * 60 * 60 * 1000),
      // SEQUENCE { [1] { OCTET STRING nonce } }, as Apple encodes it.
      extensions: [new x509.Extension("1.2.840.113635.100.8.2", false, concat(Uint8Array.of(0x30, 0x24, 0xa1, 0x22, 0x04, 0x20), nonce))],
    });
    const object = encode({
      fmt: "apple-appattest",
      attStmt: {
        x5c: [new Uint8Array(leaf.rawData), new Uint8Array(intermediate.rawData)],
        receipt: Uint8Array.of(1, 2, 3),
      },
      authData,
    });
    return toBase64(object);
  }

  /** Fetches a challenge and registers this key. */
  async register(opts: AttestationOptions & { keyId?: string; challenge?: string } = {}) {
    const c = opts.challenge ?? (await challenge());
    return call("POST", "/attest/apple", {
      body: { keyId: opts.keyId ?? this.keyId, attestation: await this.attestation(c, opts), challenge: c },
    });
  }

  /** App Attest headers for `body`, as generateAssertion would sign it.
   *  Bumps the counter unless one is given. */
  async sign(body: string, opts: { counter?: number; appId?: string } = {}): Promise<Record<string, string>> {
    const counter = opts.counter ?? ++this.counter;
    const authenticatorData = concat(await sha256(utf8(opts.appId ?? APP_ID)), Uint8Array.of(0x01), uint32(counter));
    const nonce = await sha256(concat(authenticatorData, await sha256(utf8(body))));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, nonce),
    );
    const assertion = encode({ signature: rawToDer(raw), authenticatorData });
    return { "X-App-Attest-Key-Id": this.keyId, "X-App-Attest-Assertion": toBase64(assertion) };
  }

  /** Signs in (anonymously by default) with an assertion over a fresh
   *  challenge, as the app does. */
  async signIn(opts: { path?: string; body?: unknown; counter?: number; appId?: string; headers?: Record<string, string> } = {}) {
    const c = await challenge();
    return call("POST", opts.path ?? "/sign-in/anonymous", {
      body: opts.body ?? {},
      headers: { "X-Attest-Challenge": c, ...(await this.sign(c, opts)), ...opts.headers },
    });
  }
}

/** A device whose key the Worker has accepted. */
export async function registeredDevice(): Promise<TestDevice> {
  const device = await TestDevice.create();
  const res = await device.register();
  expect(res.status).toBe(200);
  return device;
}

// -- bytes ---------------------------------------------------------------------

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export function utf8(text: string) {
  return new TextEncoder().encode(text);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function toHex(bytes: Uint8Array) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function uint32(n: number) {
  return Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function aaguid(text: string) {
  const out = new Uint8Array(16);
  out.set(utf8(text).subarray(0, 16));
  return out;
}

/** WebCrypto's r ‖ s to the DER the Secure Enclave produces. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const integer = (n: Uint8Array) => {
    let i = 0;
    while (i < n.length - 1 && n[i] === 0) i++;
    const trimmed = n.subarray(i);
    const body = trimmed[0] & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;
    return concat(Uint8Array.of(0x02, body.length), body);
  };
  const seq = concat(integer(raw.subarray(0, 32)), integer(raw.subarray(32)));
  return concat(Uint8Array.of(0x30, seq.length), seq);
}
