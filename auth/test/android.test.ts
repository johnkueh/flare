import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerAndroidKey } from "../src/attest/android";
import type { AttestEnv } from "../src/attest/env";
import { ANDROID_PACKAGE, AndroidTestDevice, registeredAndroidDevice, trustedAndroidCA } from "./android-helpers";
import { call, challenge, createTestCA } from "./helpers";

// Android Keystore registration end to end, against a test CA
// (vitest.config.ts) in place of Google's roots. Ported from Cooked's
// api/test/android-attest.test.ts.

/** The Worker's env with some vars changed, for calling src/ directly. */
function envWith(vars: Record<string, string>): AttestEnv {
  return { ...env, ...vars } as unknown as AttestEnv;
}

async function keyRow(keyId: string) {
  return env.DB.prepare("SELECT sign_count, environment, app_id, receipt FROM attest_keys WHERE key_id = ?")
    .bind(keyId)
    .first();
}

describe("POST /attest/android", () => {
  it("accepts a hardware-backed key under Google's root, then sign-ins", async () => {
    const device = await AndroidTestDevice.create();
    const res = await device.register();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ keyId: device.keyId });
    expect(await keyRow(device.keyId)).toEqual({
      sign_count: 0,
      environment: "production",
      app_id: `android:${ANDROID_PACKAGE}`,
      receipt: null,
    });

    expect((await device.signIn()).status).toBe(200);
  });

  it("treats StrongBox as production", async () => {
    const device = await registeredAndroidDevice({ securityLevel: 2 });
    expect((await keyRow(device.keyId))?.environment).toBe("production");
  });

  it.each([
    ["a software key under Google's root", async () => ({ securityLevel: 0 })],
    ["a key under another self-signed root", async () => ({ ca: await createTestCA("Emulator") })],
  ])("accepts %s as development while development is allowed", async (_, options) => {
    const device = await registeredAndroidDevice(await options());
    expect((await keyRow(device.keyId))?.environment).toBe("development");
    expect((await device.signIn()).status).toBe(200);
  });

  it("rejects development keys while development is off", async () => {
    const off = envWith({ APP_ATTEST_ALLOW_DEVELOPMENT: "false" });
    for (const opts of [{ securityLevel: 0 }, { ca: await createTestCA("Emulator") }]) {
      const device = await AndroidTestDevice.create();
      const c = await challenge();
      const result = await registerAndroidKey(off, {
        keyId: device.keyId,
        certificateChain: await device.certificateChain(c, opts),
        challenge: c,
      });
      expect(result).toMatchObject({ ok: false, reason: "attestation", detail: "development attestation not allowed" });
    }
  });

  it("rejects a challenge it never issued, and burns the one it did", async () => {
    const device = await AndroidTestDevice.create();
    expect((await device.register({ challenge: "made-up-challenge" })).body.code).toBe("INVALID_CHALLENGE");

    const c = await challenge();
    expect((await device.register({ challenge: c, packageName: "com.example.other" })).body.code).toBe(
      "INVALID_ATTESTATION",
    );
    expect((await device.register({ challenge: c })).body.code).toBe("INVALID_CHALLENGE");
  });

  it.each([
    ["a key made for another challenge", { attestedChallenge: "something-else" }],
    ["another app's package", { packageName: "com.example.other" }],
  ])("rejects %s", async (_, opts) => {
    const res = await (await AndroidTestDevice.create()).register(opts);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_ATTESTATION");
  });

  it("checks the signing certificate when ANDROID_CERT_DIGESTS is set", async () => {
    const signer = new Uint8Array(32).fill(0x5c);
    const hex = [...signer].map((b) => b.toString(16).padStart(2, "0")).join("");
    const pinned = envWith({ ANDROID_CERT_DIGESTS: `0000, ${hex}` });
    const attempt = async (signatureDigests: Uint8Array[]) => {
      const device = await AndroidTestDevice.create();
      const c = await challenge();
      const certificateChain = await device.certificateChain(c, { signatureDigests });
      return registerAndroidKey(pinned, { keyId: device.keyId, certificateChain, challenge: c });
    };
    expect(await attempt([new Uint8Array(32).fill(1)])).toMatchObject({
      ok: false,
      detail: "signing certificate isn't in ANDROID_CERT_DIGESTS",
    });
    expect(await attempt([new Uint8Array(32).fill(1), signer])).toMatchObject({ ok: true });
  });

  it("rejects a keyId that isn't the certified key", async () => {
    const device = await AndroidTestDevice.create();
    const other = await AndroidTestDevice.create();
    const res = await device.register({ keyId: other.keyId });
    expect(res.body.code).toBe("INVALID_ATTESTATION");
  });

  it("rejects a chain that doesn't link up", async () => {
    // Signed by the trusted intermediate, but presented under another CA.
    const rogue = await createTestCA("Rogue");
    const key = await crypto.subtle.importKey(
      "jwk",
      trustedAndroidCA.intermediateKey,
      { name: "ECDSA", namedCurve: "P-384" },
      false,
      ["sign"],
    );
    const rogueChain = (await (await AndroidTestDevice.create()).certificateChain("x", { ca: rogue })).slice(1);
    const res = await (await AndroidTestDevice.create()).register({ issuer: { key, chain: rogueChain } });
    expect(res.body.code).toBe("INVALID_ATTESTATION");
  });

  it("rejects a key description forged under an attested key", async () => {
    // A genuine key signs a certificate of its own claiming to be StrongBox.
    const genuine = await registeredAndroidDevice({ securityLevel: 0 });
    const chain = await genuine.certificateChain("x", { securityLevel: 0 });
    const forger = await AndroidTestDevice.create();
    const res = await forger.register({ securityLevel: 2, issuer: { key: genuine.keys.privateKey, chain } });
    expect(res.body.code).toBe("INVALID_ATTESTATION");
  });

  it("rejects garbage", async () => {
    const c = await challenge();
    const device = await AndroidTestDevice.create();
    const res = await call("POST", "/attest/android", {
      body: { keyId: device.keyId, certificateChain: ["bm90IGEgY2VydA=="], challenge: c },
    });
    expect(res.body.code).toBe("INVALID_ATTESTATION");
  });

  it("never overwrites a registered key", async () => {
    const device = await registeredAndroidDevice();
    expect((await device.signIn({ counter: 9 })).status).toBe(200);
    expect((await device.register()).status).toBe(200);
    expect((await keyRow(device.keyId))?.sign_count).toBe(9);
  });
});
