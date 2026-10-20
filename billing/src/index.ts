// App Store and Google Play subscriptions for a Flare app's Worker (BILLING.md).
//
//   const bill = billing(env, { billing: billingJson, identify });
//   const res = bill.http(request);      // POST /v1/billing/apple, /google, the store notifications; GET /v1/billing/status
//   if (res) return res;
//   if (!(await bill.has(userId, "care", { space: spaceId }))) return Response.json({ code: "CARE_REQUIRED" }, { status: 402 });
//
//   export default { fetch, scheduled: (_e, env, ctx) => ctx.waitUntil(billing(env, { billing: billingJson }).reconcile()) };
//
// The stores are the source of truth. Every report from the app and every
// store notification re-reads the subscription's current status from the
// store (App Store Server API, Play Developer API) rather than trusting
// the order notifications arrive in, and a daily reconcile re-reads
// everything not finished. Rows live in the app's own D1
// (migrations/billing.sql); households come from space_members.

import {
  type AppleApiKey,
  AppleSignatureError,
  type AppleTransaction,
  accountToken,
  appleState,
  asTransaction,
  subscriptionStatus,
  verifyAppleJws,
} from "./apple.ts";
import {
  acknowledge,
  checkPushToken,
  decodeNotification,
  getSubscription,
  type GoogleServiceAccount,
  knownState,
  type SubscriptionPurchaseV2,
  summarize,
} from "./google.ts";
import { type BillingFile, checkBilling, type EntitlementKey, entitlementsOf } from "./schema.ts";
import { FINAL_STATES, grantsAccess, type State } from "./state.ts";

export { accountToken, APPLE_ROOT_CA_G3, AppleSignatureError, resetAppleToken, verifyAppleJws } from "./apple.ts";
export { checkPushToken, resetGoogleToken, summarize } from "./google.ts";
export { checkBilling, entitlementsOf, type BillingFile, type Entitlement, type EntitlementKey } from "./schema.ts";
export { grantsAccess, type State } from "./state.ts";

export interface BillingEnv {
  DB: D1Database;
  /** Comma-separated bundle ids whose App Store purchases count. */
  APPLE_BUNDLE_IDS?: string;
  /** The In-App Purchase key (.p8 contents), its key id and the issuer id,
   *  for the App Store Server API. */
  APPLE_IAP_KEY_P8?: string;
  APPLE_IAP_KEY_ID?: string;
  APPLE_ISSUER_ID?: string;
  /** Comma-separated package names whose Play purchases count. */
  GOOGLE_PLAY_PACKAGES?: string;
  /** The service account JSON invited in Play Console. */
  GOOGLE_PLAY_SERVICE_ACCOUNT?: string;
  /** The Pub/Sub push subscription's audience and the service account it
   *  signs as, for Real-Time Developer Notifications. */
  GOOGLE_RTDN_AUDIENCE?: string;
  GOOGLE_RTDN_SERVICE_ACCOUNT?: string;
}

/** How a household entitlement follows its payer. Defaults in brackets. */
export interface HouseholdRules {
  /** When the payer leaves a space: access stops ["stop"], or lasts to the
   *  end of the period already paid for ("period-end"). */
  payerLeaves?: "stop" | "period-end";
  /** A payer covers every space they're in ["every-space"], or only the
   *  one their app sent with the purchase ("one-space"). */
  payerCovers?: "every-space" | "one-space";
  /** The most members a covered space may have. [no cap] */
  maxMembers?: number;
}

/** Who a request is: the member (the user, or before accounts the device). */
export type Identity = { member: string };

export interface BillingOptions<F extends BillingFile> {
  /** The app's billing.json. */
  billing: F;
  /** For `http()`'s app routes: who the request is, or the response refusing it. */
  identify?: (request: Request) => Promise<Identity | Response>;
  household?: HouseholdRules;
  /** Refuse a purchase whose appAccountToken / obfuscated account id isn't
   *  accountToken(member). Default false: the member reporting it becomes
   *  its payer (a restore on a new account), and the mismatch is logged. */
  strictAccounts?: boolean;
  /** Where the routes are mounted. Default "/v1". */
  prefix?: string;
  /** Called after a payer's subscription changes, with the spaces they're
   *  in: write the new state into each space's data so it syncs. */
  onChange?: (change: { userId: string; spaces: string[] }) => unknown;
  /** For tests. */
  fetch?: typeof fetch;
  now?: () => number;
  appleRoots?: string[];
  /** One JSON line per event. Default console.log (console.error for level "error"). */
  log?: (event: Record<string, unknown>) => void;
}

type Row = {
  store: "apple" | "google";
  id: string;
  user_id: string | null;
  account_token: string | null;
  app_id: string;
  product_id: string;
  state: State;
  expires_at: number | null;
  started_at: number | null;
  acknowledged: number;
  environment: string | null;
  space_id: string | null;
  updated_at: number;
};

export type EntitlementStatus = {
  active: boolean;
  /** The member's own subscription gives it. */
  own: boolean;
  /** Members whose subscriptions give it to the space. */
  paidBy: string[];
  /** Given by hand (grant()). */
  granted: boolean;
  /** When the latest giving subscription's period ends, if known. */
  expiresAt: number | null;
};

type Problem = { code: string; status: number };
const problem = (p: Problem) => Response.json({ code: p.code }, { status: p.status });

const DAY = 24 * 60 * 60 * 1000;
/** Play refunds a purchase not acknowledged within three days; the
 *  reconcile shouts about any still unacknowledged after two. */
export const ACK_OVERDUE_MS = 2 * DAY;

export function billing<F extends BillingFile>(env: BillingEnv, options: BillingOptions<F>) {
  const problems = checkBilling(options.billing);
  if (problems.length) throw new Error(`billing.json: ${problems.join("; ")}`);
  const prefix = `${options.prefix ?? "/v1"}/billing`;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const rules: Required<Omit<HouseholdRules, "maxMembers">> & Pick<HouseholdRules, "maxMembers"> = {
    payerLeaves: options.household?.payerLeaves ?? "stop",
    payerCovers: options.household?.payerCovers ?? "every-space",
    maxMembers: options.household?.maxMembers,
  };
  const log =
    options.log ?? ((event) => (event.level === "error" ? console.error(JSON.stringify(event)) : console.log(JSON.stringify(event))));
  const list = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const bundles = list(env.APPLE_BUNDLE_IDS);
  const packages = list(env.GOOGLE_PLAY_PACKAGES);
  const appleKey: AppleApiKey | null =
    env.APPLE_IAP_KEY_P8 && env.APPLE_IAP_KEY_ID && env.APPLE_ISSUER_ID
      ? { keyP8: env.APPLE_IAP_KEY_P8, keyId: env.APPLE_IAP_KEY_ID, issuerId: env.APPLE_ISSUER_ID }
      : null;
  let googleAccount: GoogleServiceAccount | null | undefined;
  const google = () => {
    if (googleAccount === undefined) googleAccount = env.GOOGLE_PLAY_SERVICE_ACCOUNT ? JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT) : null;
    return googleAccount;
  };

  // ---- Rows ----

  async function find(store: Row["store"], id: string): Promise<Row | null> {
    return env.DB.prepare("SELECT * FROM billing_subscriptions WHERE store = ? AND id = ?").bind(store, id).first<Row>();
  }

  async function userForToken(token: string | null): Promise<string | null> {
    if (!token) return null;
    const row = await env.DB.prepare("SELECT user_id FROM billing_subscriptions WHERE account_token = ? AND user_id IS NOT NULL LIMIT 1")
      .bind(token)
      .first<{ user_id: string }>();
    return row?.user_id ?? null;
  }

  async function spacesOf(userId: string): Promise<string[]> {
    const { results } = await env.DB.prepare("SELECT space_id FROM space_members WHERE member_id = ?").bind(userId).all<{ space_id: string }>();
    return results.map((r) => r.space_id);
  }

  async function save(row: Row) {
    const before = await find(row.store, row.id);
    await env.DB.prepare(
      `INSERT INTO billing_subscriptions (store, id, user_id, account_token, app_id, product_id, state, expires_at, started_at, acknowledged, environment, space_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (store, id) DO UPDATE SET user_id = COALESCE(excluded.user_id, user_id),
         account_token = COALESCE(excluded.account_token, account_token), app_id = excluded.app_id, product_id = excluded.product_id,
         state = excluded.state, expires_at = excluded.expires_at, started_at = COALESCE(excluded.started_at, started_at),
         acknowledged = excluded.acknowledged, environment = excluded.environment,
         space_id = COALESCE(excluded.space_id, space_id), updated_at = excluded.updated_at`,
    )
      .bind(
        row.store,
        row.id,
        row.user_id,
        row.account_token,
        row.app_id,
        row.product_id,
        row.state,
        row.expires_at,
        row.started_at,
        row.acknowledged,
        row.environment,
        row.space_id,
        row.updated_at,
      )
      .run();
    const changed = !before || before.state !== row.state || before.expires_at !== row.expires_at || (row.user_id && before.user_id !== row.user_id);
    if (before?.user_id && row.user_id && before.user_id !== row.user_id) {
      log({ event: "billing_payer_changed", store: row.store, key: row.id.slice(0, 12), from: before.user_id.slice(0, 8), to: row.user_id.slice(0, 8) });
    }
    const userId = row.user_id ?? before?.user_id ?? null;
    if (userId && rules.payerLeaves === "period-end" && grantsAccess(row.state, row.expires_at, now()) && row.expires_at) {
      for (const space of await spacesOf(userId)) {
        await env.DB.prepare(
          `INSERT INTO billing_payer_spaces (user_id, space_id, until) VALUES (?, ?, ?)
           ON CONFLICT (user_id, space_id) DO UPDATE SET until = MAX(until, excluded.until)`,
        )
          .bind(userId, space, row.expires_at)
          .run();
      }
    }
    if (changed && userId) {
      log({ event: "billing_changed", store: row.store, key: row.id.slice(0, 12), state: row.state, product: row.product_id });
      if (options.onChange) await options.onChange({ userId, spaces: await spacesOf(userId) });
    }
    return Boolean(changed);
  }

  function knownProduct(productId: string) {
    return entitlementsOf(options.billing, productId).length > 0;
  }

  async function checkAccount(userId: string | null, token: string | null | undefined, store: string): Promise<Problem | null> {
    if (!userId || !token) return null;
    if (token.toLowerCase() === (await accountToken(userId))) return null;
    log({ event: "billing_account_mismatch", store, user: userId.slice(0, 8) });
    return options.strictAccounts ? { code: "ACCOUNT_MISMATCH", status: 403 } : null;
  }

  // ---- App Store ----

  /** Re-reads an Apple subscription and saves it. `t` is a transaction
   *  already verified. */
  async function refreshApple(t: AppleTransaction, userId: string | null, spaceId: string | null, fallbackStatus?: number, renewalJws?: string) {
    const at = now();
    let latest = t;
    let status = fallbackStatus;
    let renewal = renewalJws;
    if (appleKey) {
      const found = await subscriptionStatus(appleKey, t, doFetch, at);
      if (found) {
        latest = asTransaction(await verifyAppleJws(found.signedTransactionInfo, options.appleRoots, at));
        status = found.status;
        renewal = found.signedRenewalInfo;
      }
    }
    const autoRenew = renewal ? (await verifyAppleJws(renewal, options.appleRoots, at)).autoRenewStatus === 1 : undefined;
    const before = await find("apple", t.originalTransactionId);
    const token = latest.appAccountToken ?? t.appAccountToken ?? null;
    return save({
      store: "apple",
      id: t.originalTransactionId,
      user_id: userId ?? before?.user_id ?? (await userForToken(token)),
      account_token: token,
      app_id: latest.bundleId,
      product_id: latest.productId,
      state: appleState(status, autoRenew, latest, at),
      expires_at: latest.expiresDate ?? null,
      started_at: latest.purchaseDate ?? null,
      acknowledged: 1,
      environment: latest.environment,
      space_id: spaceId,
      updated_at: at,
    });
  }

  async function reportApple(userId: string, jws: string, spaceId: string | null = null): Promise<Problem | null> {
    let t: AppleTransaction;
    try {
      t = asTransaction(await verifyAppleJws(jws, options.appleRoots, now()));
    } catch (e) {
      if (e instanceof AppleSignatureError) {
        log({ event: "billing_apple_rejected", reason: e.message });
        return { code: "INVALID_TRANSACTION", status: 400 };
      }
      throw e;
    }
    if (!bundles.includes(t.bundleId)) return { code: "WRONG_APP", status: 400 };
    if (!knownProduct(t.productId)) return { code: "UNKNOWN_PRODUCT", status: 400 };
    const mismatch = await checkAccount(userId, t.appAccountToken, "apple");
    if (mismatch) return mismatch;
    await refreshApple(t, userId, spaceId);
    return null;
  }

  async function appleNotification(request: Request): Promise<Response> {
    const body = await request.json<{ signedPayload?: string }>().catch(() => null);
    let n: Record<string, unknown>;
    try {
      n = await verifyAppleJws(String(body?.signedPayload ?? ""), options.appleRoots, now());
    } catch (e) {
      if (!(e instanceof AppleSignatureError)) throw e;
      log({ event: "billing_apple_notification_rejected", reason: e.message, level: "error" });
      return problem({ code: "INVALID_NOTIFICATION", status: 400 });
    }
    const data = (n.data ?? {}) as { bundleId?: string; signedTransactionInfo?: string; signedRenewalInfo?: string; status?: number };
    log({ event: "billing_apple_notification", type: n.notificationType, subtype: n.subtype ?? null });
    if (!data.signedTransactionInfo) return Response.json({ ok: true }); // TEST, or not about a subscription
    if (data.bundleId && !bundles.includes(data.bundleId)) return Response.json({ ok: true, ignored: "bundle" });
    const t = asTransaction(await verifyAppleJws(data.signedTransactionInfo, options.appleRoots, now()));
    await refreshApple(t, null, null, data.status, data.signedRenewalInfo);
    return Response.json({ ok: true });
  }

  // ---- Google Play ----

  /** Re-reads a Play subscription, acknowledges it when it needs it, and saves it. */
  async function refreshGoogle(
    packageName: string,
    token: string,
    userId: string | null,
    spaceId: string | null,
    productHint?: string,
    fetched?: SubscriptionPurchaseV2,
  ) {
    const account = google();
    if (!account) throw new Error("billing: GOOGLE_PLAY_SERVICE_ACCOUNT isn't set");
    const at = now();
    const before = await find("google", token);
    const purchase = fetched ?? (await getSubscription(account, packageName, token, doFetch, at));
    if (!purchase) {
      if (before) await save({ ...before, state: "expired", updated_at: at });
      return { found: false as const };
    }
    if (!knownState(purchase)) log({ event: "billing_google_unknown_state", state: purchase.subscriptionState ?? null, level: "error" });
    const s = summarize(purchase);
    const productId = s.productId ?? productHint ?? before?.product_id ?? "";
    let acknowledged = s.acknowledged;
    if (!acknowledged && (s.state === "active" || s.state === "grace" || s.state === "canceled")) {
      acknowledged = await acknowledge(account, packageName, productId, token, doFetch, at);
      log({ event: acknowledged ? "billing_google_acknowledged" : "billing_ack_failed", key: token.slice(0, 12), ...(acknowledged ? {} : { level: "error" }) });
    }
    let owner = userId ?? before?.user_id ?? null;
    let space = spaceId;
    if (s.linkedPurchaseToken) {
      // An upgrade, downgrade or resubscribe: the new token replaces the old one.
      const old = await find("google", s.linkedPurchaseToken);
      if (old) {
        owner ??= old.user_id;
        space ??= old.space_id;
        if (old.state !== "superseded") await save({ ...old, state: "superseded", updated_at: at });
      }
    }
    owner ??= await userForToken(s.accountToken);
    const changed = await save({
      store: "google",
      id: token,
      user_id: owner,
      account_token: s.accountToken,
      app_id: packageName,
      product_id: productId,
      state: s.state,
      expires_at: s.expiresAt,
      started_at: s.startedAt,
      acknowledged: acknowledged ? 1 : 0,
      environment: s.test ? "test" : "Production",
      space_id: space,
      updated_at: at,
    });
    return { found: true as const, changed, summary: s, acknowledged };
  }

  async function reportGoogle(
    userId: string,
    purchase: { purchaseToken: string; productId?: string; packageName?: string },
    spaceId: string | null = null,
  ): Promise<Problem | null> {
    const packageName = purchase.packageName ?? (packages.length === 1 ? packages[0] : "");
    if (!packages.includes(packageName)) return { code: "WRONG_APP", status: 400 };
    if (purchase.productId && !knownProduct(purchase.productId)) return { code: "UNKNOWN_PRODUCT", status: 400 };
    const account = google();
    if (!account) throw new Error("billing: GOOGLE_PLAY_SERVICE_ACCOUNT isn't set");
    // Check the account before binding the purchase to this member.
    const peek = await getSubscription(account, packageName, purchase.purchaseToken, doFetch, now());
    if (!peek) return { code: "INVALID_PURCHASE", status: 400 };
    const mismatch = await checkAccount(userId, summarize(peek).accountToken, "google");
    if (mismatch) return mismatch;
    await refreshGoogle(packageName, purchase.purchaseToken, userId, spaceId, purchase.productId, peek);
    return null;
  }

  async function googleNotification(request: Request): Promise<Response> {
    if (!env.GOOGLE_RTDN_AUDIENCE || !env.GOOGLE_RTDN_SERVICE_ACCOUNT) {
      log({ event: "billing_rtdn_not_configured", level: "error" });
      return problem({ code: "NOT_CONFIGURED", status: 503 });
    }
    const reason = await checkPushToken(
      request.headers.get("authorization"),
      { audience: env.GOOGLE_RTDN_AUDIENCE, email: env.GOOGLE_RTDN_SERVICE_ACCOUNT },
      doFetch,
      now(),
    );
    if (reason) {
      log({ event: "billing_rtdn_rejected", reason, level: "error" });
      return problem({ code: "UNAUTHORIZED", status: 401 });
    }
    const n = decodeNotification(await request.json().catch(() => null));
    // A 2xx tells Pub/Sub it's handled; anything unreadable won't get better on retry.
    if (!n) return Response.json({ ok: true, ignored: "unreadable" });
    if (n.testNotification) {
      log({ event: "billing_rtdn_test", package: n.packageName });
      return Response.json({ ok: true });
    }
    if (!packages.includes(n.packageName)) return Response.json({ ok: true, ignored: "package" });
    const voided = n.voidedPurchaseNotification?.productType === 1 ? n.voidedPurchaseNotification : null;
    const token = n.subscriptionNotification?.purchaseToken ?? voided?.purchaseToken;
    if (!token) return Response.json({ ok: true, ignored: "not a subscription" });
    log({ event: "billing_rtdn", type: n.subscriptionNotification?.notificationType ?? "voided" });
    const result = await refreshGoogle(n.packageName, token, null, null);
    if (voided && result.found && grantsAccess(result.summary.state, result.summary.expiresAt, now())) {
      // Refunded and revoked, even if Play's status hasn't caught up.
      const row = await find("google", token);
      if (row) await save({ ...row, state: "revoked", updated_at: now() });
    }
    return Response.json({ ok: true });
  }

  // ---- Access ----

  function products(key: string): string[] {
    return options.billing.entitlements[key]?.products ?? [];
  }

  async function rowsFor(column: "user_id", values: string[], productIds: string[]): Promise<Row[]> {
    if (values.length === 0 || productIds.length === 0) return [];
    const { results } = await env.DB.prepare(
      `SELECT * FROM billing_subscriptions WHERE ${column} IN (${values.map(() => "?").join(",")}) AND product_id IN (${productIds.map(() => "?").join(",")})`,
    )
      .bind(...values, ...productIds)
      .all<Row>();
    return results;
  }

  async function grantFor(key: string, userId: string | null, spaceId: string | null) {
    const row = await env.DB.prepare(
      "SELECT MAX(expires_at) AS until FROM billing_grants WHERE entitlement = ? AND expires_at > ? AND (user_id = ? OR space_id = ?)",
    )
      .bind(key, now(), userId, spaceId)
      .first<{ until: number | null }>();
    return row?.until ?? null;
  }

  /** Who gives `key` to the space, and until when. */
  async function spaceStatus(spaceId: string, key: string): Promise<{ paidBy: string[]; expiresAt: number | null; granted: boolean }> {
    const at = now();
    const { results } = await env.DB.prepare("SELECT member_id FROM space_members WHERE space_id = ?").bind(spaceId).all<{ member_id: string }>();
    const members = results.map((r) => r.member_id);
    const granted = (await grantFor(key, null, spaceId)) !== null;
    if (rules.maxMembers !== undefined && members.length > rules.maxMembers) return { paidBy: [], expiresAt: null, granted };
    // Former members still covering the space to the end of their period.
    const keptUntil = new Map<string, number>();
    if (rules.payerLeaves === "period-end") {
      const kept = await env.DB.prepare("SELECT user_id, until FROM billing_payer_spaces WHERE space_id = ? AND until > ?")
        .bind(spaceId, at)
        .all<{ user_id: string; until: number }>();
      for (const k of kept.results) if (!members.includes(k.user_id)) keptUntil.set(k.user_id, k.until);
    }
    const rows = await rowsFor("user_id", [...members, ...keptUntil.keys()], products(key));
    const paidBy = new Set<string>();
    let expiresAt: number | null = null;
    for (const row of rows) {
      if (!row.user_id || !grantsAccess(row.state, row.expires_at, at)) continue;
      if (rules.payerCovers === "one-space" && row.space_id !== spaceId) continue;
      const until = keptUntil.get(row.user_id);
      if (until !== undefined && until <= at) continue;
      paidBy.add(row.user_id);
      if (row.expires_at && (expiresAt === null || row.expires_at > expiresAt)) expiresAt = row.expires_at;
    }
    return { paidBy: [...paidBy], expiresAt, granted };
  }

  async function isMember(userId: string, spaceId: string) {
    return Boolean(
      await env.DB.prepare("SELECT 1 AS yes FROM space_members WHERE member_id = ? AND space_id = ?").bind(userId, spaceId).first(),
    );
  }

  /** Whether `userId` has `key`: their own subscription, a grant, or (for
   *  a household entitlement) a paying member of `space`. */
  async function status(userId: string, key: EntitlementKey<F>, opts: { space?: string } = {}): Promise<EntitlementStatus> {
    const at = now();
    const own = (await rowsFor("user_id", [userId], products(key))).filter((r) => grantsAccess(r.state, r.expires_at, at));
    const space = opts.space && options.billing.entitlements[key].household && (await isMember(userId, opts.space)) ? opts.space : null;
    const granted = (await grantFor(key, userId, space)) !== null;
    const household = space ? await spaceStatus(space, key) : { paidBy: [], expiresAt: null, granted: false };
    const expiries = own.map((r) => r.expires_at ?? 0).concat(household.expiresAt ?? 0);
    const expiresAt = Math.max(...expiries) || null;
    return {
      active: own.length > 0 || granted || household.paidBy.length > 0,
      own: own.length > 0,
      paidBy: household.paidBy,
      granted,
      expiresAt,
    };
  }

  async function has(userId: string, key: EntitlementKey<F>, opts: { space?: string } = {}): Promise<boolean> {
    return (await status(userId, key, opts)).active;
  }

  /** Every household entitlement's state for a space. */
  async function entitlement(spaceId: string): Promise<Record<string, { active: boolean; paidBy: string[]; expiresAt: number | null }>> {
    const out: Record<string, { active: boolean; paidBy: string[]; expiresAt: number | null }> = {};
    for (const [key, e] of Object.entries(options.billing.entitlements)) {
      if (!e.household) continue;
      const s = await spaceStatus(spaceId, key);
      out[key] = { active: s.granted || s.paidBy.length > 0, paidBy: s.paidBy, expiresAt: s.expiresAt };
    }
    return out;
  }

  /** Gives `key` by hand (a support comp, a reviewer) to a user or a space. */
  async function grant(g: { entitlement: EntitlementKey<F>; user?: string; space?: string; until: number; note?: string }) {
    if (!g.user === !g.space) throw new Error("grant: pass user or space");
    const res = await env.DB.prepare(
      "INSERT INTO billing_grants (entitlement, user_id, space_id, expires_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
      .bind(g.entitlement, g.user ?? null, g.space ?? null, g.until, g.note ?? null, now())
      .first<{ id: number }>();
    log({ event: "billing_grant", entitlement: g.entitlement, until: g.until });
    return res?.id ?? null;
  }

  async function revokeGrant(id: number) {
    await env.DB.prepare("UPDATE billing_grants SET expires_at = ? WHERE id = ?").bind(now(), id).run();
  }

  // ---- Daily ----

  /**
   * Re-reads every subscription not finished (oldest first, up to `limit`
   * so a run stays inside the Worker's subrequest budget), retries Play
   * acknowledgements, and logs an error for any Play purchase still
   * unacknowledged after two days: at three, Play refunds it.
   */
  async function reconcile(opts: { limit?: number } = {}) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM billing_subscriptions WHERE state NOT IN (${FINAL_STATES.map(() => "?").join(",")}) ORDER BY updated_at LIMIT ?`,
    )
      .bind(...FINAL_STATES, opts.limit ?? 200)
      .all<Row>();
    let checked = 0;
    let changed = 0;
    let failed = 0;
    const ackOverdue: string[] = [];
    for (const row of results) {
      try {
        if (row.store === "google") {
          const r = await refreshGoogle(row.app_id, row.id, null, null);
          if (r.found && r.changed) changed++;
        } else if (appleKey) {
          const t = { originalTransactionId: row.id, transactionId: row.id, bundleId: row.app_id, productId: row.product_id, environment: row.environment ?? "Production" };
          if (await refreshApple(t, null, null)) changed++;
        } else continue;
        checked++;
      } catch (e) {
        failed++;
        log({ event: "billing_reconcile_failed", store: row.store, key: row.id.slice(0, 12), error: String(e), level: "error" });
      }
    }
    const overdue = await env.DB.prepare(
      "SELECT id, started_at FROM billing_subscriptions WHERE store = 'google' AND acknowledged = 0 AND state IN ('active', 'grace', 'canceled') AND started_at < ?",
    )
      .bind(now() - ACK_OVERDUE_MS)
      .all<{ id: string; started_at: number }>();
    for (const row of overdue.results) {
      ackOverdue.push(row.id);
      log({ event: "billing_ack_overdue", key: row.id.slice(0, 12), hours: Math.floor((now() - row.started_at) / 3_600_000), level: "error" });
    }
    await env.DB.prepare("DELETE FROM billing_payer_spaces WHERE until < ?").bind(now()).run();
    log({ event: "billing_reconcile", checked, changed, failed, ack_overdue: ackOverdue.length });
    return { checked, changed, failed, ackOverdue };
  }

  // ---- HTTP ----

  /** The billing routes under `{prefix}/billing/`, or null for any other path. */
  function http(request: Request): Promise<Response> | null {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(`${prefix}/`)) return null;
    return route(request, path.slice(prefix.length)).catch((e) => {
      log({ event: "billing_error", path, error: String(e), level: "error" });
      return problem({ code: "BILLING_ERROR", status: 500 });
    });
  }

  async function route(request: Request, path: string): Promise<Response> {
    if (path === "/apple/notifications" && request.method === "POST") return appleNotification(request);
    if (path === "/google/rtdn" && request.method === "POST") return googleNotification(request);
    if (!["/apple", "/google", "/status"].includes(path)) return problem({ code: "NOT_FOUND", status: 404 });
    if (!options.identify) throw new Error("billing: pass identify to serve the app routes");
    const who = await options.identify(request);
    if (who instanceof Response) return who;
    if (path === "/status" && request.method === "GET") {
      const space = new URL(request.url).searchParams.get("space") ?? undefined;
      const out: Record<string, EntitlementStatus> = {};
      for (const key of Object.keys(options.billing.entitlements) as EntitlementKey<F>[]) out[key] = await status(who.member, key, { space });
      return Response.json({ entitlements: out, accountToken: await accountToken(who.member) });
    }
    if (request.method !== "POST") return problem({ code: "METHOD_NOT_ALLOWED", status: 405 });
    const body = await request.json<Record<string, unknown>>().catch(() => null);
    const space = typeof body?.space === "string" ? body.space : null;
    if (space && !(await isMember(who.member, space))) return problem({ code: "NOT_A_MEMBER", status: 403 });
    let refused: Problem | null;
    if (path === "/apple") {
      if (typeof body?.transaction !== "string") return problem({ code: "INVALID_REQUEST", status: 400 });
      refused = await reportApple(who.member, body.transaction, space);
    } else {
      if (typeof body?.purchaseToken !== "string") return problem({ code: "INVALID_REQUEST", status: 400 });
      refused = await reportGoogle(
        who.member,
        {
          purchaseToken: body.purchaseToken,
          productId: typeof body.productId === "string" ? body.productId : undefined,
          packageName: typeof body.packageName === "string" ? body.packageName : undefined,
        },
        space,
      );
    }
    if (refused) return problem(refused);
    const out: Record<string, EntitlementStatus> = {};
    for (const key of Object.keys(options.billing.entitlements) as EntitlementKey<F>[]) out[key] = await status(who.member, key, { space: space ?? undefined });
    return Response.json({ ok: true, entitlements: out });
  }

  return { http, has, status, entitlement, grant, revokeGrant, reconcile, reportApple, reportGoogle };
}

/** A space's household entitlements, for code that has no billing() at hand. */
export function entitlement<F extends BillingFile>(env: BillingEnv, spaceId: string, options: BillingOptions<F>) {
  return billing(env, options).entitlement(spaceId);
}
