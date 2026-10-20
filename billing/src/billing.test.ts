// Apple's signed data against a fake Apple chain made here, Google against
// a fake Play Developer API and a fake Pub/Sub signing key, and access in
// D1 (node:sqlite) with the package's own migration.
//
//   pnpm test   (node --test, no Worker needed)

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { AppleSignatureError, accountToken, verifyAppleJws } from "./apple.ts";
import { fakeApple, fakeD1, type FakeApple, pkcs8Pem, rsaKeys, signRs256 } from "./fixtures.ts";
import { resetGoogleToken } from "./google.ts";
import { ACK_OVERDUE_MS, billing, type BillingEnv, type BillingOptions } from "./index.ts";
import { resetAppleToken } from "./apple.ts";
import { checkBilling } from "./schema.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-20T00:00:00Z");
const SPACE = "a".repeat(64);

const billingFile = {
  entitlements: {
    care: { products: ["com.example.care.yearly", "com.example.care.monthly"], household: true },
    pro: { products: ["com.example.pro"] },
  },
};

type Call = { url: string; init: RequestInit };
type Responder = (call: Call) => Response | undefined | Promise<Response | undefined>;

function fakeFetch() {
  const calls: Call[] = [];
  const routes: Responder[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    for (const r of routes) {
      const res = await r(call);
      if (res) return res;
    }
    return new Response("not faked", { status: 599 });
  }) as typeof fetch;
  return { fn, calls, on: (r: Responder) => routes.push(r) };
}

function members(db: ReturnType<typeof fakeD1>, space: string, ...ids: string[]) {
  for (const id of ids) db.sqlite.prepare("INSERT OR IGNORE INTO space_members (member_id, space_id) VALUES (?, ?)").run(id, space);
}
function leave(db: ReturnType<typeof fakeD1>, space: string, id: string) {
  db.sqlite.prepare("DELETE FROM space_members WHERE member_id = ? AND space_id = ?").run(id, space);
}

const req = (path: string, body?: object, headers: Record<string, string> = {}) =>
  new Request(`https://app.example${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

describe("billing.json", () => {
  it("accepts the example and names problems", () => {
    assert.deepEqual(checkBilling(billingFile), []);
    assert.deepEqual(checkBilling({}), ['needs an "entitlements" object']);
    assert.match(checkBilling({ entitlements: { Care: { products: [] } } }).join(";"), /snake_case.*needs products/);
  });
});

describe("Apple JWS", () => {
  let apple: FakeApple;
  beforeEach(async () => {
    apple = await fakeApple();
  });

  it("verifies a payload signed by a chain ending at the trusted root", async () => {
    const jws = await apple.sign({ hello: "world" });
    assert.deepEqual(await verifyAppleJws(jws, apple.roots), { hello: "world" });
  });

  it("refuses an untrusted root, a tampered payload, a leaf without Apple's marker and an expired leaf", async () => {
    const jws = await apple.sign({ productId: "a" });
    const other = await fakeApple();
    await assert.rejects(verifyAppleJws(jws, other.roots), AppleSignatureError);
    // The real Apple root doesn't trust the fake chain either.
    await assert.rejects(verifyAppleJws(jws), /trusted Apple root/);
    const [h, , s] = jws.split(".");
    const tampered = `${h}.${btoa(JSON.stringify({ productId: "b" })).replace(/=+$/, "")}.${s}`;
    await assert.rejects(verifyAppleJws(tampered, apple.roots), /bad signature/);
    const unmarked = await fakeApple({ leafMarkers: [] });
    await assert.rejects(verifyAppleJws(await unmarked.sign({}), unmarked.roots), /leaf/);
    const expired = await fakeApple({ leafNotAfter: Date.now() - 1000 });
    await assert.rejects(verifyAppleJws(await expired.sign({}), expired.roots), /validity/);
  });

  it("makes a stable UUID account token per user", async () => {
    const a = await accountToken("user-sam");
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(a, await accountToken("user-sam"));
    assert.notEqual(a, await accountToken("user-alex"));
  });
});

describe("App Store", () => {
  let apple: FakeApple;
  let db: ReturnType<typeof fakeD1>;
  let env: BillingEnv;
  let net: ReturnType<typeof fakeFetch>;
  let now: number;
  let appleStatus: { status: number; autoRenew: number; expires: number; productId?: string };
  let logs: Record<string, unknown>[];

  const transaction = async (extra: object = {}) => ({
    originalTransactionId: "1000000001",
    transactionId: "1000000009",
    bundleId: "com.example.app",
    productId: "com.example.care.yearly",
    environment: "Sandbox",
    type: "Auto-Renewable Subscription",
    purchaseDate: T0,
    expiresDate: T0 + 365 * DAY,
    appAccountToken: await accountToken("sam"),
    ...extra,
  });

  const make = (extra: Partial<BillingOptions<typeof billingFile>> = {}) =>
    billing(env, {
      billing: billingFile,
      identify: async (r) => {
        const user = r.headers.get("x-user");
        return user ? { member: user } : new Response("no", { status: 401 });
      },
      fetch: net.fn,
      now: () => now,
      appleRoots: apple.roots,
      log: (e) => logs.push(e),
      ...extra,
    });

  beforeEach(async () => {
    resetAppleToken();
    apple = await fakeApple();
    db = fakeD1();
    now = T0 + DAY;
    logs = [];
    const apiKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    env = {
      DB: db,
      APPLE_BUNDLE_IDS: "com.example.app",
      APPLE_IAP_KEY_P8: await pkcs8Pem(apiKey.privateKey),
      APPLE_IAP_KEY_ID: "KEY123",
      APPLE_ISSUER_ID: "issuer-uuid",
    };
    appleStatus = { status: 1, autoRenew: 1, expires: T0 + 365 * DAY };
    net = fakeFetch();
    net.on(async (call) => {
      if (!call.url.startsWith("https://api.storekit-sandbox.itunes.apple.com/inApps/v1/subscriptions/")) return;
      assert.match(String((call.init.headers as Record<string, string>).authorization), /^Bearer ey/);
      const id = decodeURIComponent(call.url.split("/").pop() ?? "");
      return Response.json({
        data: [
          {
            subscriptionGroupIdentifier: "g1",
            lastTransactions: [
              {
                originalTransactionId: id,
                status: appleStatus.status,
                signedTransactionInfo: await apple.sign(
                  await transaction({ expiresDate: appleStatus.expires, ...(appleStatus.productId && { productId: appleStatus.productId }) }),
                ),
                signedRenewalInfo: await apple.sign({ autoRenewStatus: appleStatus.autoRenew, originalTransactionId: id }),
              },
            ],
          },
        ],
      });
    });
    members(db, SPACE, "sam", "alex", "nana");
  });

  it("a payer's purchase unlocks the household, and leaving stops it at once", async () => {
    const bill = make();
    const res = await bill.http(req("/v1/billing/apple", { transaction: await apple.sign(await transaction()) }, { "x-user": "sam" }));
    assert.equal(res?.status, 200);
    const body = (await res?.json()) as { entitlements: { care: { active: boolean; own: boolean } } };
    assert.equal(body.entitlements.care.active, true);
    assert.equal(body.entitlements.care.own, true);

    assert.equal(await bill.has("nana", "care", { space: SPACE }), true);
    assert.deepEqual((await bill.status("alex", "care", { space: SPACE })).paidBy, ["sam"]);
    // Not a household entitlement, and not someone else's space.
    assert.equal(await bill.has("nana", "care"), false);
    assert.equal(await bill.has("stranger", "care", { space: SPACE }), false);
    assert.deepEqual(await bill.entitlement(SPACE), { care: { active: true, paidBy: ["sam"], expiresAt: T0 + 365 * DAY } });

    leave(db, SPACE, "sam");
    assert.equal(await bill.has("nana", "care", { space: SPACE }), false);
    assert.equal(await bill.has("sam", "care"), true, "the payer keeps their own access");
  });

  it("payerLeaves period-end keeps the space covered until the paid period ends", async () => {
    const bill = make({ household: { payerLeaves: "period-end" } });
    await bill.reportApple("sam", await apple.sign(await transaction()));
    leave(db, SPACE, "sam");
    assert.equal(await bill.has("nana", "care", { space: SPACE }), true);
    now = T0 + 366 * DAY;
    assert.equal(await bill.has("nana", "care", { space: SPACE }), false);
  });

  it("payerCovers one-space and maxMembers", async () => {
    const other = "b".repeat(64);
    members(db, other, "sam", "gran");
    const bill = make({ household: { payerCovers: "one-space", maxMembers: 3 } });
    await bill.http(req("/v1/billing/apple", { transaction: await apple.sign(await transaction()), space: SPACE }, { "x-user": "sam" }));
    assert.equal(await bill.has("nana", "care", { space: SPACE }), true);
    assert.equal(await bill.has("gran", "care", { space: other }), false);
    members(db, SPACE, "fourth");
    assert.equal(await bill.has("nana", "care", { space: SPACE }), false, "over the cap");
  });

  it("refuses another app, an unknown product, a bad signature and (strict) another account's purchase", async () => {
    const bill = make({ strictAccounts: true });
    assert.deepEqual(await bill.reportApple("sam", await apple.sign(await transaction({ bundleId: "com.other" }))), { code: "WRONG_APP", status: 400 });
    assert.deepEqual(await bill.reportApple("sam", await apple.sign(await transaction({ productId: "nope" }))), { code: "UNKNOWN_PRODUCT", status: 400 });
    const stranger = await fakeApple();
    assert.deepEqual(await bill.reportApple("sam", await stranger.sign(await transaction())), { code: "INVALID_TRANSACTION", status: 400 });
    assert.deepEqual(await bill.reportApple("alex", await apple.sign(await transaction())), { code: "ACCOUNT_MISMATCH", status: 403 });
    // Not strict: a restore on a new account moves the purchase to them.
    const lenient = make();
    assert.equal(await lenient.reportApple("alex", await apple.sign(await transaction())), null);
    assert.ok(logs.some((l) => l.event === "billing_account_mismatch"));
  });

  it("a notification re-reads the status from Apple instead of trusting its order", async () => {
    const bill = make();
    await bill.reportApple("sam", await apple.sign(await transaction()));
    // An old DID_RENEW arrives after Apple has already moved the sub to billing retry.
    appleStatus = { status: 3, autoRenew: 1, expires: T0 + 365 * DAY };
    const signedPayload = await apple.sign({
      notificationType: "DID_RENEW",
      data: { bundleId: "com.example.app", status: 1, signedTransactionInfo: await apple.sign(await transaction()) },
    });
    const res = await bill.http(req("/v1/billing/apple/notifications", { signedPayload }));
    assert.equal(res?.status, 200);
    assert.equal(await bill.has("sam", "care"), false, "hold: no access");
    assert.equal(await bill.has("nana", "care", { space: SPACE }), false);

    appleStatus = { status: 4, autoRenew: 1, expires: T0 + 365 * DAY };
    await bill.http(req("/v1/billing/apple/notifications", { signedPayload }));
    assert.equal(await bill.has("nana", "care", { space: SPACE }), true, "grace keeps access");

    appleStatus = { status: 1, autoRenew: 0, expires: T0 + 30 * DAY };
    await bill.http(req("/v1/billing/apple/notifications", { signedPayload }));
    assert.equal(await bill.has("sam", "care"), true, "canceled lasts to its expiry");
    now = T0 + 31 * DAY;
    assert.equal(await bill.has("sam", "care"), false);
  });

  it("refuses a forged notification and accepts Apple's TEST", async () => {
    const bill = make();
    const forged = await (await fakeApple()).sign({ notificationType: "DID_RENEW", data: {} });
    assert.equal((await bill.http(req("/v1/billing/apple/notifications", { signedPayload: forged })))?.status, 400);
    const test = await apple.sign({ notificationType: "TEST", data: { bundleId: "com.example.app" } });
    assert.equal((await bill.http(req("/v1/billing/apple/notifications", { signedPayload: test })))?.status, 200);
  });

  it("onChange gets the payer's spaces, and grants work for users and spaces", async () => {
    const changes: { userId: string; spaces: string[] }[] = [];
    const bill = make({ onChange: (c) => changes.push(c) });
    await bill.reportApple("sam", await apple.sign(await transaction()));
    assert.deepEqual(changes, [{ userId: "sam", spaces: [SPACE] }]);
    await bill.reportApple("sam", await apple.sign(await transaction()));
    assert.equal(changes.length, 1, "no change, no call");

    const id = await bill.grant({ entitlement: "pro", user: "nana", until: now + DAY, note: "reviewer" });
    assert.equal(await bill.has("nana", "pro"), true);
    await bill.revokeGrant(Number(id));
    assert.equal(await bill.has("nana", "pro"), false);
    leave(db, SPACE, "sam");
    await bill.grant({ entitlement: "care", space: SPACE, until: now + DAY });
    assert.equal(await bill.has("alex", "care", { space: SPACE }), true);
  });

  it("app routes need identify, and a space the caller is in", async () => {
    const bill = make();
    assert.equal((await bill.http(req("/v1/billing/status")))?.status, 401);
    assert.equal((await bill.http(req("/v1/billing/apple", { transaction: "x", space: "c".repeat(64) }, { "x-user": "sam" })))?.status, 403);
    const status = (await (await bill.http(req(`/v1/billing/status?space=${SPACE}`, undefined, { "x-user": "sam" })))?.json()) as {
      accountToken: string;
    };
    assert.equal(status.accountToken, await accountToken("sam"));
    assert.equal(bill.http(req("/elsewhere")), null);
  });
});

describe("Google Play", () => {
  let db: ReturnType<typeof fakeD1>;
  let env: BillingEnv;
  let net: ReturnType<typeof fakeFetch>;
  let now: number;
  let logs: Record<string, unknown>[];
  let purchases: Map<string, Record<string, unknown>>;
  let acks: string[];
  let ackWorks: boolean;
  let pubsub: CryptoKeyPair;

  const PKG = "com.example.app";
  const AUD = "https://app.example/v1/billing/google/rtdn";
  const PUSHER = "rtdn-push@example-project.iam.gserviceaccount.com";

  const make = (extra: Partial<BillingOptions<typeof billingFile>> = {}) =>
    billing(env, {
      billing: billingFile,
      identify: async (r) => ({ member: r.headers.get("x-user") ?? "anon" }),
      fetch: net.fn,
      now: () => now,
      log: (e) => logs.push(e),
      ...extra,
    });

  const purchase = async (token: string, extra: Record<string, unknown> = {}) => {
    purchases.set(token, {
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
      startTime: new Date(now).toISOString(),
      externalAccountIdentifiers: { obfuscatedExternalAccountId: await accountToken("sam") },
      lineItems: [{ productId: "com.example.care.monthly", expiryTime: new Date(now + 30 * DAY).toISOString() }],
      ...extra,
    });
  };

  const rtdn = async (data: object, claims: Record<string, unknown> = {}) => {
    const token = await signRs256(pubsub.privateKey, "kid-1", {
      iss: "https://accounts.google.com",
      aud: AUD,
      email: PUSHER,
      email_verified: true,
      exp: Math.floor(now / 1000) + 3600,
      ...claims,
    });
    const message = { data: btoa(JSON.stringify({ version: "1.0", packageName: PKG, ...data })), messageId: "m1" };
    return req("/v1/billing/google/rtdn", { message, subscription: "projects/p/subscriptions/s" }, { authorization: `Bearer ${token}` });
  };

  beforeEach(async () => {
    resetGoogleToken();
    db = fakeD1();
    now = T0;
    logs = [];
    purchases = new Map();
    acks = [];
    ackWorks = true;
    const account = await rsaKeys();
    pubsub = await rsaKeys();
    const jwk = { ...(await crypto.subtle.exportKey("jwk", pubsub.publicKey)), kid: "kid-1", use: "sig" };
    env = {
      DB: db,
      GOOGLE_PLAY_PACKAGES: PKG,
      GOOGLE_PLAY_SERVICE_ACCOUNT: JSON.stringify({ client_email: "billing@example-project.iam.gserviceaccount.com", private_key: await pkcs8Pem(account.privateKey) }),
      GOOGLE_RTDN_AUDIENCE: AUD,
      GOOGLE_RTDN_SERVICE_ACCOUNT: PUSHER,
    };
    net = fakeFetch();
    net.on((call) => (call.url === "https://oauth2.googleapis.com/token" ? Response.json({ access_token: "ya29.test", expires_in: 3600 }) : undefined));
    net.on((call) => (call.url === "https://www.googleapis.com/oauth2/v3/certs" ? Response.json({ keys: [jwk] }) : undefined));
    net.on((call) => {
      const m = /\/applications\/([^/]+)\/purchases\/subscriptionsv2\/tokens\/([^/]+)$/.exec(call.url);
      if (!m) return;
      const p = purchases.get(decodeURIComponent(m[2]));
      return p ? Response.json(p) : new Response("gone", { status: 410 });
    });
    net.on((call) => {
      const m = /\/purchases\/subscriptions\/([^/]+)\/tokens\/([^/]+):acknowledge$/.exec(call.url);
      if (!m) return;
      acks.push(decodeURIComponent(m[2]));
      if (!ackWorks) return new Response("boom", { status: 500 });
      const p = purchases.get(decodeURIComponent(m[2]));
      if (p) p.acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
      return new Response("{}");
    });
    members(db, SPACE, "sam", "alex");
  });

  it("verifies a purchase with Play, acknowledges it, and unlocks the household", async () => {
    await purchase("tok-1");
    const bill = make();
    const res = await bill.http(req("/v1/billing/google", { purchaseToken: "tok-1", productId: "com.example.care.monthly" }, { "x-user": "sam" }));
    assert.equal(res?.status, 200);
    assert.deepEqual(acks, ["tok-1"]);
    assert.equal(await bill.has("alex", "care", { space: SPACE }), true);
    const row = db.sqlite.prepare("SELECT acknowledged, state FROM billing_subscriptions WHERE id = 'tok-1'").get() as { acknowledged: number; state: string };
    assert.deepEqual({ ...row }, { acknowledged: 1, state: "active" });
  });

  it("refuses an unknown token and another app", async () => {
    const bill = make();
    assert.deepEqual(await bill.reportGoogle("sam", { purchaseToken: "nope" }), { code: "INVALID_PURCHASE", status: 400 });
    assert.deepEqual(await bill.reportGoogle("sam", { purchaseToken: "x", packageName: "com.other" }), { code: "WRONG_APP", status: 400 });
  });

  it("an RTDN is authenticated, then the status is re-read (the payload is never trusted)", async () => {
    await purchase("tok-2", { acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" });
    const bill = make();
    await bill.reportGoogle("sam", { purchaseToken: "tok-2" });
    // SUBSCRIPTION_RENEWED (2) arrives, but Play now says it's on hold.
    purchases.get("tok-2")!.subscriptionState = "SUBSCRIPTION_STATE_ON_HOLD";
    const res = await bill.http(await rtdn({ subscriptionNotification: { version: "1.0", notificationType: 2, purchaseToken: "tok-2" } }));
    assert.equal(res?.status, 200);
    assert.equal(await bill.has("sam", "care"), false);

    for (const bad of [{ aud: "https://elsewhere" }, { email: "someone@else.com" }, { exp: 1 }]) {
      assert.equal((await bill.http(await rtdn({ testNotification: {} }, bad)))?.status, 401);
    }
    assert.equal((await bill.http(req("/v1/billing/google/rtdn", { message: {} })))?.status, 401);
  });

  it("an RTDN for a purchase the app hasn't reported yet finds the payer by account token later", async () => {
    await purchase("tok-0", { acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" });
    const bill = make();
    await bill.reportGoogle("sam", { purchaseToken: "tok-0" });
    await purchase("tok-3");
    await bill.http(await rtdn({ subscriptionNotification: { version: "1.0", notificationType: 4, purchaseToken: "tok-3" } }));
    const row = db.sqlite.prepare("SELECT user_id, acknowledged FROM billing_subscriptions WHERE id = 'tok-3'").get() as { user_id: string; acknowledged: number };
    assert.deepEqual({ ...row }, { user_id: "sam", acknowledged: 1 });
  });

  it("a voided purchase is revoked, and a linked token supersedes the old one", async () => {
    await purchase("old", { acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" });
    const bill = make();
    await bill.reportGoogle("sam", { purchaseToken: "old" }, SPACE);
    await purchase("new", { linkedPurchaseToken: "old", externalAccountIdentifiers: {} });
    await bill.http(await rtdn({ subscriptionNotification: { version: "1.0", notificationType: 4, purchaseToken: "new" } }));
    const rows = db.sqlite.prepare("SELECT id, state, user_id FROM billing_subscriptions ORDER BY id").all() as Record<string, unknown>[];
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [
        { id: "new", state: "active", user_id: "sam" },
        { id: "old", state: "superseded", user_id: "sam" },
      ],
    );
    await bill.http(await rtdn({ voidedPurchaseNotification: { purchaseToken: "new", productType: 1, orderId: "GPA.1" } }));
    assert.equal(await bill.has("sam", "care"), false, "refunded");
  });

  it("guards the three-day refund: reconcile retries acknowledgements and shouts after two days", async () => {
    ackWorks = false;
    await purchase("tok-4");
    const bill = make();
    await bill.reportGoogle("sam", { purchaseToken: "tok-4" });
    assert.ok(logs.some((l) => l.event === "billing_ack_failed" && l.level === "error"));
    assert.equal(await bill.has("sam", "care"), true, "access while Play still has it");

    now += DAY;
    let r = await bill.reconcile();
    assert.deepEqual(r.ackOverdue, [], "one day: retried, not overdue yet");
    assert.equal(acks.length, 2);

    now = T0 + ACK_OVERDUE_MS + 60 * 60 * 1000;
    r = await bill.reconcile();
    assert.deepEqual(r.ackOverdue, ["tok-4"]);
    assert.ok(logs.some((l) => l.event === "billing_ack_overdue" && l.level === "error"));
    assert.equal(acks.length, 3, "and retried again");

    ackWorks = true;
    r = await bill.reconcile();
    assert.deepEqual(r.ackOverdue, []);
    assert.equal((db.sqlite.prepare("SELECT acknowledged FROM billing_subscriptions").get() as { acknowledged: number }).acknowledged, 1);
  });

  it("reconcile picks up expiry and a token Play forgot", async () => {
    await purchase("tok-5", { acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" });
    const bill = make();
    await bill.reportGoogle("sam", { purchaseToken: "tok-5" });
    purchases.get("tok-5")!.subscriptionState = "SUBSCRIPTION_STATE_EXPIRED";
    const r = await bill.reconcile();
    assert.equal(r.changed, 1);
    assert.equal(await bill.has("sam", "care"), false);
    assert.equal((await bill.reconcile()).checked, 0, "expired rows aren't re-read");
  });
});
