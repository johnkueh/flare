import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerKey } from "../src/attest/apple";
import type { AttestEnv } from "../src/attest/env";
import { call, challenge, createTestCA, TestDevice } from "./helpers";

// App Attest registration end to end against a test CA (vitest.config.ts)
// in place of Apple's. Ported from Cooked's api/test/attest.test.ts.

describe("challenges", () => {
  it("are random and URL-safe", async () => {
    const a = await challenge();
    const b = await challenge();
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe("POST /attest/apple", () => {
  it("accepts a valid attestation, then sign-ins", async () => {
    const device = await TestDevice.create();
    const res = await device.register();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ keyId: device.keyId });

    const row = await env.DB.prepare("SELECT sign_count, environment, app_id FROM attest_keys WHERE key_id = ?")
      .bind(device.keyId)
      .first();
    expect(row).toEqual({
      sign_count: 0,
      environment: "production",
      app_id: "ABCDE12345.com.example.app",
    });

    expect((await device.signIn()).status).toBe(200);
  });

  it("accepts development keys while APP_ATTEST_ALLOW_DEVELOPMENT is on", async () => {
    const device = await TestDevice.create();
    expect((await device.register({ aaguid: "appattestdevelop" })).status).toBe(200);

    const off = { ...env, APP_ATTEST_ALLOW_DEVELOPMENT: "false" } as unknown as AttestEnv;
    const other = await TestDevice.create();
    const c = await challenge();
    const result = await registerKey(off, {
      keyId: other.keyId,
      attestation: await other.attestation(c, { aaguid: "appattestdevelop" }),
      challenge: c,
    });
    expect(result).toMatchObject({ ok: false, reason: "attestation", detail: "aaguid not allowed" });
  });

  it("rejects a challenge it never issued", async () => {
    const device = await TestDevice.create();
    const res = await device.register({ challenge: "made-up-challenge" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_CHALLENGE");
  });

  it("rejects a used challenge", async () => {
    const c = await challenge();
    expect((await (await TestDevice.create()).register({ challenge: c })).status).toBe(200);
    const res = await (await TestDevice.create()).register({ challenge: c });
    expect(res.body.code).toBe("INVALID_CHALLENGE");
  });

  it("rejects an expired challenge", async () => {
    await env.DB.prepare("INSERT INTO attest_challenges (challenge, expires_at) VALUES ('stale', ?)")
      .bind(Date.now() - 1)
      .run();
    const res = await (await TestDevice.create()).register({ challenge: "stale" });
    expect(res.body.code).toBe("INVALID_CHALLENGE");
  });

  it("burns the challenge even when the attestation fails", async () => {
    const c = await challenge();
    const device = await TestDevice.create();
    expect((await device.register({ challenge: c, appId: "TEAM.com.example.other" })).body.code).toBe(
      "INVALID_ATTESTATION",
    );
    expect((await device.register({ challenge: c })).body.code).toBe("INVALID_CHALLENGE");
  });

  it.each([
    ["another app's id", { appId: "ABCDE12345.com.example.other" }],
    ["a nonce for another challenge", { nonceChallenge: "something-else" }],
    ["a non-zero counter", { counter: 1 }],
    ["an unknown aaguid", { aaguid: "notappattest" }],
    ["a credentialId that isn't the key", { credentialId: new Uint8Array(32).fill(7) }],
  ])("rejects %s", async (_, opts) => {
    const res = await (await TestDevice.create()).register(opts);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_ATTESTATION");
  });

  it("rejects a chain that isn't rooted in the trusted root", async () => {
    const rogue = await createTestCA("Rogue");
    const res = await (await TestDevice.create()).register({ ca: rogue });
    expect(res.body.code).toBe("INVALID_ATTESTATION");
  });

  it("rejects a keyId that isn't the certified key", async () => {
    const device = await TestDevice.create();
    const other = await TestDevice.create();
    const res = await device.register({ keyId: other.keyId });
    expect(res.body.code).toBe("INVALID_ATTESTATION");
  });

  it("rejects garbage", async () => {
    const c = await challenge();
    const device = await TestDevice.create();
    const res = await call("POST", "/attest/apple", {
      body: { keyId: device.keyId, attestation: "bm90IGNib3I=", challenge: c },
    });
    expect(res.body.code).toBe("INVALID_ATTESTATION");
  });
});
