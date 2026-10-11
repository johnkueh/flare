import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { flareAuth } from "../src/index";
import { registeredAndroidDevice } from "./android-helpers";
import { call, challenge, registeredDevice, TestDevice } from "./helpers";

// Signing in: anonymous sign-in needs an attested device, every sign-in a
// phone makes records which device it was, and an anonymous user who signs
// up is linked to the new account.

/** The bearer token a sign-in handed back. */
function tokenOf(res: { headers: Headers }): string {
  const token = res.headers.get("set-auth-token");
  expect(token).toBeTruthy();
  return token as string;
}

async function whoami(token?: string) {
  const res = await SELF.fetch("https://api.test/v1/whoami", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return res.json<{ userId: string; deviceId: string } | null>();
}

describe("anonymous sign-in", () => {
  it("needs an attested device", async () => {
    const res = await call("POST", "/sign-in/anonymous", { body: {} });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("ATTESTATION_REQUIRED");
  });

  it("signs in an iPhone and remembers its key as the device", async () => {
    const device = await registeredDevice();
    const res = await device.signIn();
    expect(res.status).toBe(200);
    expect(res.body.user.isAnonymous).toBe(true);
    const who = await whoami(tokenOf(res));
    expect(who).toEqual({ userId: res.body.user.id, deviceId: device.keyId });
  });

  it("signs in an Android phone the same way", async () => {
    const device = await registeredAndroidDevice();
    const res = await device.signIn();
    expect(res.status).toBe(200);
    expect(await whoami(tokenOf(res))).toEqual({ userId: res.body.user.id, deviceId: device.keyId });
  });

  it("refuses a key that never registered", async () => {
    const res = await (await TestDevice.create()).signIn();
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("ATTESTATION_REQUIRED");
  });

  it("uses each challenge once", async () => {
    const device = await registeredDevice();
    const c = await challenge();
    const headers = { "X-Attest-Challenge": c, ...(await device.sign(c)) };
    expect((await call("POST", "/sign-in/anonymous", { body: {}, headers })).status).toBe(200);
    const again = await call("POST", "/sign-in/anonymous", { body: {}, headers });
    expect(again.status).toBe(401);
    expect(again.body.code).toBe("INVALID_ASSERTION");
  });

  it("refuses a challenge it never issued", async () => {
    const device = await registeredDevice();
    const headers = { "X-Attest-Challenge": "made-up", ...(await device.sign("made-up")) };
    expect((await call("POST", "/sign-in/anonymous", { body: {}, headers })).body.code).toBe("INVALID_ASSERTION");
  });

  it("refuses a signature over another challenge", async () => {
    const device = await registeredDevice();
    const headers = { "X-Attest-Challenge": await challenge(), ...(await device.sign(await challenge())) };
    expect((await call("POST", "/sign-in/anonymous", { body: {}, headers })).body.code).toBe("INVALID_ASSERTION");
  });

  it("refuses a counter that didn't go up", async () => {
    const device = await registeredDevice();
    expect((await device.signIn({ counter: 5 })).status).toBe(200);
    expect((await device.signIn({ counter: 5 })).body.code).toBe("INVALID_ASSERTION");
  });

  it("lets simulators through when FLARE_AUTH_ALLOW_UNATTESTED is on", async () => {
    const auth = flareAuth({ ...env, FLARE_AUTH_ALLOW_UNATTESTED: "true" });
    const res = await auth.handler(
      new Request("https://api.test/v1/auth/sign-in/anonymous", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("devices", () => {
  it("can't be claimed by sending the internal header", async () => {
    const device = await registeredDevice();
    const res = await call("POST", "/sign-up/email", {
      body: { email: "web@example.com", password: "correct horse battery", name: "Web" },
      headers: { "X-Flare-Verified-Device": device.keyId },
    });
    expect(res.status).toBe(200);
    const who = await whoami(tokenOf(res));
    expect(who?.deviceId).toMatch(/^web:/);
  });
});

describe("linking", () => {
  it("moves an anonymous user to the account they sign up for, on the same device", async () => {
    const device = await registeredDevice();
    const anonymous = await device.signIn();
    const anonymousId = anonymous.body.user.id;

    const real = await device.signIn({
      path: "/sign-up/email",
      body: { email: "mia@example.com", password: "correct horse battery", name: "Mia" },
      headers: { Authorization: `Bearer ${tokenOf(anonymous)}` },
    });
    expect(real.status).toBe(200);
    const who = await whoami(tokenOf(real));
    expect(who).toEqual({ userId: real.body.user.id, deviceId: device.keyId });
    expect(who?.userId).not.toBe(anonymousId);

    const link = await env.DB.prepare("SELECT anonymous_user_id, user_id FROM test_links WHERE user_id = ?")
      .bind(real.body.user.id)
      .first();
    expect(link).toEqual({ anonymous_user_id: anonymousId, user_id: real.body.user.id });
    // The anonymous user is gone, and so is its session.
    expect(await whoami(tokenOf(anonymous))).toBeNull();
  });
});

describe("authenticate (for spaceHttp)", () => {
  it("answers the user id, or a 401 the apps already retry on", async () => {
    const out = await SELF.fetch("https://api.test/v1/space-check");
    expect(out.status).toBe(401);
    expect(await out.json()).toMatchObject({ code: "ATTESTATION_REQUIRED" });

    const res = await (await registeredDevice()).signIn();
    const ok = await SELF.fetch("https://api.test/v1/space-check", {
      headers: { Authorization: `Bearer ${tokenOf(res)}` },
    });
    expect(await ok.json()).toEqual({ user: res.body.user.id });
  });
});
