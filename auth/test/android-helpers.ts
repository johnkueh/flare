// Must load before @peculiar/x509 (see src/attest/apple.ts).
import "reflect-metadata";
import { env } from "cloudflare:test";
import { expect } from "vitest";
import * as x509 from "@peculiar/x509";
import type { TestCA } from "./attest-ca";
import { call, challenge, concat, rawToDer, sha256, toBase64, utf8 } from "./helpers";

export const ANDROID_PACKAGE = "com.johnkueh.cooked";

/** The CA whose root stands in for Google's (see vitest.config.ts). */
export const trustedAndroidCA: TestCA = JSON.parse(env.TEST_ANDROID_CA);

export type AndroidChainOptions = {
  /** Challenge whose hash goes in the key description (defaults to the
   *  submitted one). */
  attestedChallenge?: string;
  packageName?: string;
  /** SHA-256 digests of the app's signing certificates. */
  signatureDigests?: Uint8Array[];
  /** 0 Software, 1 TrustedEnvironment, 2 StrongBox. */
  securityLevel?: number;
  ca?: TestCA;
  /** Sign the leaf with this key and put `issuerChain` above it instead
   *  of the CA's intermediate and root. */
  issuer?: { key: CryptoKey; chain: string[] };
};

/** A fake Android phone: a P-256 key standing in for the Keystore key,
 *  the certificate chain KeyStore.getCertificateChain would return for it
 *  (signed by a test CA instead of Google's), and signed requests. */
export class AndroidTestDevice {
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
    const spki = new Uint8Array((await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer);
    return new AndroidTestDevice(keys, await sha256(spki));
  }

  get keyId() {
    return toBase64(this.keyIdBytes);
  }

  /** Base64 DER certificates, leaf first, attesting this key for `challenge`. */
  async certificateChain(challenge: string, opts: AndroidChainOptions = {}): Promise<string[]> {
    const ca = opts.ca ?? trustedAndroidCA;
    const description = keyDescription({
      challengeHash: await sha256(utf8(opts.attestedChallenge ?? challenge)),
      securityLevel: opts.securityLevel ?? 1,
      packageName: opts.packageName ?? ANDROID_PACKAGE,
      signatureDigests: opts.signatureDigests ?? [new Uint8Array(32).fill(0xab)],
    });
    const intermediate = new x509.X509Certificate(ca.intermediatePem);
    const issuerChain = opts.issuer?.chain ?? [
      toBase64(new Uint8Array(intermediate.rawData)),
      toBase64(new Uint8Array(new x509.X509Certificate(ca.rootPem).rawData)),
    ];
    const signingKey =
      opts.issuer?.key ??
      (await crypto.subtle.importKey("jwk", ca.intermediateKey, { name: "ECDSA", namedCurve: "P-384" }, false, [
        "sign",
      ]));
    const issuer = new x509.X509Certificate(fromBase64(issuerChain[0]));
    const leaf = await x509.X509CertificateGenerator.create({
      subject: "CN=Android Keystore Key",
      issuer: issuer.subject,
      publicKey: this.keys.publicKey,
      signingKey,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      // Keystore's defaults when the app doesn't set a validity.
      notBefore: new Date(0),
      notAfter: new Date("2048-01-01T00:00:00Z"),
      extensions: [new x509.Extension("1.3.6.1.4.1.11129.2.1.17", false, description)],
    });
    return [toBase64(new Uint8Array(leaf.rawData)), ...issuerChain];
  }

  /** Fetches a challenge and registers this key. */
  async register(opts: AndroidChainOptions & { keyId?: string; challenge?: string } = {}) {
    const c = opts.challenge ?? (await challenge());
    return call("POST", "/attest/android", {
      body: { keyId: opts.keyId ?? this.keyId, certificateChain: await this.certificateChain(c, opts), challenge: c },
    });
  }

  /** X-Android-* headers for `body`. Bumps the counter unless one is given. */
  async sign(body: string, opts: { counter?: number } = {}): Promise<Record<string, string>> {
    const counter = opts.counter ?? ++this.counter;
    const counterBytes = new Uint8Array(8);
    new DataView(counterBytes.buffer).setBigUint64(0, BigInt(counter));
    const message = concat(await sha256(utf8(body)), counterBytes);
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, message),
    );
    return {
      "X-Android-Key-Id": this.keyId,
      "X-Android-Counter": String(counter),
      "X-Android-Signature": toBase64(rawToDer(raw)),
    };
  }

  /** Signs in (anonymously by default) with a signature over a fresh
   *  challenge, as the app does. */
  async signIn(opts: { path?: string; body?: unknown; counter?: number; headers?: Record<string, string> } = {}) {
    const c = await challenge();
    return call("POST", opts.path ?? "/sign-in/anonymous", {
      body: opts.body ?? {},
      headers: { "X-Attest-Challenge": c, ...(await this.sign(c, opts)), ...opts.headers },
    });
  }
}

/** An Android device whose key the Worker has accepted. */
export async function registeredAndroidDevice(opts: AndroidChainOptions = {}): Promise<AndroidTestDevice> {
  const device = await AndroidTestDevice.create();
  const res = await device.register(opts);
  expect(res.status).toBe(200);
  return device;
}

// -- KeyDescription ------------------------------------------------------------

/** The attestation extension's value, as KeyMint 2.0 (version 200) encodes
 *  it: attestationApplicationId sits in softwareEnforced. */
function keyDescription(opts: {
  challengeHash: Uint8Array;
  securityLevel: number;
  packageName: string;
  signatureDigests: Uint8Array[];
}): Uint8Array {
  const applicationId = der(
    0x30,
    der(0x31, der(0x30, der(0x04, utf8(opts.packageName)), der(0x02, Uint8Array.of(1)))),
    der(0x31, ...opts.signatureDigests.map((d) => der(0x04, d))),
  );
  // [709] EXPLICIT: context-specific, constructed, high tag number 709.
  const softwareEnforced = der(0x30, der([0xbf, 0x85, 0x45], der(0x04, applicationId)));
  // A hardware entry the parser must skip: [702] origin = GENERATED (0).
  const hardwareEnforced = der(0x30, der([0xbf, 0x85, 0x3e], der(0x02, Uint8Array.of(0))));
  return der(
    0x30,
    der(0x02, Uint8Array.of(0, 200)),
    der(0x0a, Uint8Array.of(opts.securityLevel)),
    der(0x02, Uint8Array.of(0, 200)),
    der(0x0a, Uint8Array.of(opts.securityLevel)),
    der(0x04, opts.challengeHash),
    der(0x04, new Uint8Array()),
    softwareEnforced,
    hardwareEnforced,
  );
}

/** A DER TLV with a definite length. */
function der(tag: number | number[], ...content: Uint8Array[]): Uint8Array {
  const body = concat(...content);
  const n = body.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return concat(Uint8Array.from(typeof tag === "number" ? [tag] : tag), Uint8Array.from(length), body);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
