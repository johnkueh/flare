import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { flareAuth, purgeAccount, purgeDeletedAccounts } from "../src/index";
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

describe("deleting an account", () => {
  const deleteAccount = (token?: string) =>
    call("POST", "/delete-account", { body: {}, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const DAY = 24 * 3600 * 1000;

  async function rowCount(userId: string) {
    const row = await env.DB.prepare(
      `SELECT (SELECT count(*) FROM "user" WHERE id = ?1) + (SELECT count(*) FROM session WHERE userId = ?1)
         + (SELECT count(*) FROM account WHERE userId = ?1) AS n`,
    )
      .bind(userId)
      .first<{ n: number }>();
    return row?.n;
  }
  const deletedAt = async (userId: string) =>
    (await env.DB.prepare("SELECT deleted_at FROM deleted_accounts WHERE user_id = ?").bind(userId).first<{ deleted_at: number }>())?.deleted_at ?? null;
  const seenByHook = (userId: string) => env.DB.prepare("SELECT email, anonymous FROM test_deletes WHERE user_id = ?").bind(userId).first();
  const options = { onDeleteAccount: async () => {}, betterAuth: { emailAndPassword: { enabled: true } } };

  async function signUp(email: string) {
    const res = await call("POST", "/sign-up/email", { body: { email, password: "correct horse battery", name: "Leo" } });
    expect(res.status).toBe(200);
    return res;
  }
  const signInAgain = (email: string) => call("POST", "/sign-in/email", { body: { email, password: "correct horse battery" } });

  it("needs a session", async () => {
    expect((await deleteAccount()).status).toBe(401);
  });

  it("marks an account deleted and signs out every phone, keeping its data for 30 days", async () => {
    const real = await signUp("leo@example.com");
    const userId = real.body.user.id;
    const otherPhone = await signInAgain("leo@example.com");

    const res = await deleteAccount(tokenOf(real));
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    const until = Date.parse(res.body.restorableUntil);
    expect(until - Date.now()).toBeGreaterThan(29 * DAY);
    expect(await deletedAt(userId)).toBeTruthy();
    expect(await whoami(tokenOf(real))).toBeNull();
    expect(await whoami(tokenOf(otherPhone))).toBeNull();
    expect(await seenByHook(userId)).toBeNull(); // the app's data stays for now
  });

  it("restores the account when they sign back in within the grace period", async () => {
    const real = await signUp("mae@example.com");
    const userId = real.body.user.id;
    await deleteAccount(tokenOf(real));

    const back = await signInAgain("mae@example.com");
    expect(back.status).toBe(200);
    expect(back.body.user.id).toBe(userId);
    expect(await deletedAt(userId)).toBeNull();
    expect(await whoami(tokenOf(back))).toMatchObject({ userId });
  });

  it("purges accounts past the grace period, the app's part first", async () => {
    const old = await signUp("old@example.com");
    const recent = await signUp("recent@example.com");
    await deleteAccount(tokenOf(old));
    await deleteAccount(tokenOf(recent));

    const result = await purgeDeletedAccounts(env, { ...options, onDeleteAccount: hookToTable }, Date.now() + 31 * DAY - 1000 * 60);
    expect(result.failed).toBe(0);
    expect(await rowCount(old.body.user.id)).toBe(0);
    expect(await rowCount(recent.body.user.id)).toBe(0);
    expect(await seenByHook(old.body.user.id)).toEqual({ email: "old@example.com", anonymous: 0 });

    // Not yet due: kept.
    const fresh = await signUp("fresh@example.com");
    await deleteAccount(tokenOf(fresh));
    await purgeDeletedAccounts(env, { ...options, onDeleteAccount: hookToTable });
    expect(await deletedAt(fresh.body.user.id)).toBeTruthy();

    // Once purged, the email is free again.
    expect((await signUp("old@example.com")).body.user.id).not.toBe(old.body.user.id);
  });

  it("purges one account now when they ask, without waiting", async () => {
    const res = await signUp("asks@example.com");
    await deleteAccount(tokenOf(res));
    expect(await purgeAccount(env, res.body.user.id, { ...options, onDeleteAccount: hookToTable })).toBe(true);
    expect(await rowCount(res.body.user.id)).toBe(0);
    expect(await seenByHook(res.body.user.id)).toEqual({ email: "asks@example.com", anonymous: 0 });
    expect(await purgeAccount(env, res.body.user.id, options)).toBe(false);
  });

  it("keeps an account whose purge fails in the app's part, for the next run", async () => {
    const res = await signUp("keep-me@example.com");
    await deleteAccount(tokenOf(res));
    const result = await purgeDeletedAccounts(env, { ...options, onDeleteAccount: hookToTable }, Date.now() + 40 * DAY);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await deletedAt(res.body.user.id)).toBeTruthy();
  });

  it("deletes an anonymous user at once, since they could never sign back in", async () => {
    const res = await (await registeredDevice()).signIn();
    const userId = res.body.user.id;
    const out = await deleteAccount(tokenOf(res));
    expect(out.status).toBe(200);
    expect(out.body.restorableUntil).toBeNull();
    expect(await rowCount(userId)).toBe(0);
    expect(await seenByHook(userId)).toEqual({ email: expect.any(String), anonymous: 1 });
  });

  it("keeps the user when an immediate delete fails in the app's part, so the phone can try again", async () => {
    const res = await signUp("keep-me-now@example.com");
    const auth = flareAuth(env, { ...options, deleteAfterDays: 0, onDeleteAccount: async () => { throw new Error("no"); } });
    const out = await auth.handler(
      new Request("https://api.test/v1/auth/delete-account", {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenOf(res)}`, "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(out.status).toBe(500);
    expect(await out.json()).toMatchObject({ code: "DELETE_FAILED" });
    expect(await whoami(tokenOf(res))).toMatchObject({ userId: res.body.user.id });
  });
});

/** The test Worker's onDeleteAccount, for purges run from the test. */
async function hookToTable({ userId, email, isAnonymous }: { userId: string; email: string; isAnonymous: boolean }) {
  if (email === "keep-me@example.com") throw new Error("the app's part failed");
  await env.DB.prepare("INSERT INTO test_deletes (user_id, email, anonymous) VALUES (?, ?, ?)")
    .bind(userId, email, isAnonymous ? 1 : 0)
    .run();
}
