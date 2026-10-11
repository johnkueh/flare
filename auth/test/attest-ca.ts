// Must load before @peculiar/x509 (see src/attest/apple.ts).
import "reflect-metadata";
import * as x509 from "@peculiar/x509";

// A stand-in for Apple's App Attestation CA: a P-384 root and intermediate,
// as Apple uses. vitest.config.ts makes one in Node and trusts its root
// (APP_ATTEST_TEST_ROOT_PEM); tests make others to play an untrusted CA.

export type TestCA = { rootPem: string; intermediatePem: string; intermediateKey: JsonWebKey };

const CA_KEY = { name: "ECDSA", namedCurve: "P-384" };
const CA_SIGNING = { name: "ECDSA", hash: "SHA-384" };
const DAY = 24 * 60 * 60 * 1000;

export async function createTestCA(name = "Test App Attestation"): Promise<TestCA> {
  const notBefore = new Date(Date.now() - DAY);
  const notAfter = new Date(Date.now() + 365 * DAY);
  const rootKeys = (await crypto.subtle.generateKey(CA_KEY, true, ["sign", "verify"])) as CryptoKeyPair;
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    name: `CN=${name} Root CA`,
    keys: rootKeys,
    signingAlgorithm: CA_SIGNING,
    notBefore,
    notAfter,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  const intermediateKeys = (await crypto.subtle.generateKey(CA_KEY, true, ["sign", "verify"])) as CryptoKeyPair;
  const intermediate = await x509.X509CertificateGenerator.create({
    subject: `CN=${name} CA 1`,
    issuer: root.subject,
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    signingAlgorithm: CA_SIGNING,
    notBefore,
    notAfter,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
  });
  return {
    rootPem: root.toString("pem"),
    intermediatePem: intermediate.toString("pem"),
    intermediateKey: (await crypto.subtle.exportKey("jwk", intermediateKeys.privateKey)) as JsonWebKey,
  };
}
