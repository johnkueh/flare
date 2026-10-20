# Store billing

App Store and Google Play subscriptions for apps on Flare, with no
third-party service. The app keeps its own paywall and store code; the
app's Worker checks what the store signed, keeps the subscription's
current state in its D1, and answers "does this person have Pro?". With
`household: true`, one paying member unlocks an entitlement for everyone
in each space (family, household) they're in.

```
phone ──buy──▶ App Store / Play
phone ──POST /v1/billing/apple (signed transaction) | /google (purchase token)──▶ Worker ──re-read──▶ store API ──▶ D1
App Store Server Notifications ──▶ /v1/billing/apple/notifications ──┘
Play RTDN (Pub/Sub push) ──▶ /v1/billing/google/rtdn ──────────────────┘
daily cron: reconcile() re-reads everything not finished, retries Play acknowledgements
```

Every report and every notification re-reads the subscription's status
from the store (App Store Server API "Get All Subscription Statuses", Play
`purchases.subscriptionsv2.get`) instead of trusting what the message says
or the order messages arrive in. The Worker acknowledges Play purchases
itself: Play refunds a purchase nobody acknowledged within three days.

## billing.json

Which products unlock what, next to `flags.json`:

```json
{
  "entitlements": {
    "care": { "products": ["com.me.app.care.yearly", "com.me.app.care.monthly"], "household": true },
    "pro": { "products": ["com.me.app.pro"] }
  }
}
```

Product ids are the App Store product ids and the Play subscription ids
(use the same ids on both stores, or list both).

## The Worker

```sh
pnpm add "@flare/billing@github:johnkueh/flare#<tag>&path:/billing"
```

Add `node_modules/@flare/billing/migrations/billing.sql` next to your
migrations and apply it as usual. Household entitlements read
`space_members` from `@sync/server`'s migrations.

```ts
import { billing } from "@flare/billing";
import billingJson from "./billing.json";

const bill = billing(env, { billing: billingJson, identify });

// in fetch():
const res = bill.http(request); // POST /v1/billing/apple, /google, the two notification URLs; GET /v1/billing/status
if (res) return res;

// gate a paid route
if (!(await bill.has(userId, "care", { space: spaceId }))) return Response.json({ code: "CARE_REQUIRED" }, { status: 402 });

// daily
export default {
  fetch,
  scheduled: (_e, env, ctx) => ctx.waitUntil(billing(env, { billing: billingJson }).reconcile()),
};
```

`identify(request)` returns `{ member }` (the user id from `@flare/auth`,
or before accounts the device id) or a `Response` refusing the request.
The notification routes don't use it: Apple's are checked by signature,
Google's by the Pub/Sub token.

| Call | What it does |
| --- | --- |
| `has(user, key, { space? })` | Their own subscription, a grant, or (household) a paying member of `space` they're in |
| `status(user, key, { space? })` | The same, with `own`, `paidBy`, `granted` and `expiresAt`, for the paywall and Settings |
| `entitlement(spaceId)` | Each household entitlement of a space and who pays for it |
| `grant({ entitlement, user \| space, until, note })` / `revokeGrant(id)` | Access by hand: support comps, reviewers |
| `reconcile({ limit })` | Re-reads up to `limit` (200) unfinished subscriptions; returns `ackOverdue` |
| `onChange({ userId, spaces })` (option) | After a payer's subscription changes: write the new state into each space so caregivers' phones get it through sync |

`@flare/billing/spaces` adds `spaceBilling(env, bill, spaceId, member)`,
which checks the caller is in the space and returns the payers' names, for
"Included with Sam's subscription".

### Households

| Option | Default | Alternative |
| --- | --- | --- |
| `household.payerLeaves` | `"stop"`: the space loses access when the payer leaves | `"period-end"`: it keeps access to the end of the period already paid for |
| `household.payerCovers` | `"every-space"`: a payer covers every space they're in | `"one-space"`: only the space the app sent with the purchase (`space` in the POST body) |
| `household.maxMembers` | no cap | a space with more members than this isn't covered |

### States

`active`, `grace` (a renewal failed, the store is retrying; access stays
on) and `canceled` (auto-renew off; access to the end of the period) give
access. `hold`, `paused`, `pending`, `expired`, `revoked` (refunded) and
`superseded` (a Play upgrade or resubscribe replaced the token) don't. A
state Play adds later reads as `pending` and is logged as
`billing_google_unknown_state`, so it shows up before anyone complains.

### Who paid

The app passes `accountToken` (from `GET /v1/billing/status`, a UUID made
from the user id) as StoreKit's `appAccountToken` and Play's obfuscated
account id. Purchases the store tells the Worker about before the app does
are matched to the payer by it. A purchase reported by a different member
(a restore on a new account) moves to that member and logs
`billing_account_mismatch`; with `strictAccounts: true` it's refused.

## Setup, once per app

### App Store

1. In App Store Connect, Users and Access → Integrations → In-App Purchase,
   create a key and download the `.p8`.
2. App Information → App Store Server Notifications: set the production
   and sandbox URLs to `https://<your worker>/v1/billing/apple/notifications`,
   version 2.
3. Secrets: `APPLE_IAP_KEY_P8` (the `.p8` file's contents), `APPLE_IAP_KEY_ID`,
   `APPLE_ISSUER_ID` (on the same page). Var: `APPLE_BUNDLE_IDS`
   (comma-separated, e.g. `com.me.app,com.me.app.dev`).

Without the key, reports and notifications still work from Apple's signed
data, but nothing re-reads the status and `reconcile()` skips App Store
rows.

### Google Play

1. A Google Cloud project with the Google Play Android Developer API on.
2. A service account in it with a JSON key. In Play Console → Users and
   permissions, invite its email with "View financial data" and "Manage
   orders and subscriptions".
3. A Pub/Sub topic. Grant `google-play-developer-notifications@system.gserviceaccount.com`
   the Pub/Sub Publisher role on it, and set it in Play Console →
   Monetization setup → Real-time developer notifications.
4. A push subscription on the topic to `https://<your worker>/v1/billing/google/rtdn`,
   with authentication on: pick a service account to sign as, and an
   audience (the URL itself is fine).
5. Secret: `GOOGLE_PLAY_SERVICE_ACCOUNT` (the JSON key). Vars:
   `GOOGLE_PLAY_PACKAGES` (comma-separated package names),
   `GOOGLE_RTDN_AUDIENCE` and `GOOGLE_RTDN_SERVICE_ACCOUNT` (the
   subscription's audience and signing account).

Send a test notification from Play Console's RTDN page: the Worker logs
`billing_rtdn_test`.

### Secrets

The Worker reads them as ordinary Worker secrets (`wrangler secret put`,
or `.dev.vars` under `wrangler dev`). Keep the `.p8` and the JSON key
wherever you keep secrets, and list them in `secrets.required`.

## iOS

StoreKit stays in the app. Buy with the account token, and send Apple's
signed transaction after a purchase, a restore and every update:

```swift
import StoreKit

let result = try await product.purchase(options: [.appAccountToken(UUID(uuidString: billing.accountToken)!)])
if case .success(let verification) = result, case .verified(let transaction) = verification {
    await report(verification.jwsRepresentation)
    await transaction.finish()
}

// at launch, for renewals and purchases made elsewhere
Task {
    for await update in Transaction.updates {
        await report(update.jwsRepresentation)
        if case .verified(let t) = update { await t.finish() }
    }
}

func report(_ jws: String) async {
    var request = URLRequest(url: api.appending(path: "v1/billing/apple"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["transaction": jws])
    _ = try? await session.data(for: request) // your authenticated session
}
```

Keep checking `Transaction.currentEntitlements` locally too, so the payer
never loses access while offline.

## Android

Play Billing Library 8 or later (Play requires 8 for app updates from
2026-08-31). Don't acknowledge on the phone: the Worker does it.

```kotlin
// app/build.gradle.kts
implementation("com.android.billingclient:billing-ktx:8.0.0")
```

```kotlin
val client = BillingClient.newBuilder(context)
    .setListener { result, purchases ->
        if (result.responseCode == BillingClient.BillingResponseCode.OK) purchases?.forEach { report(it) }
    }
    .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
    .build()

fun buy(activity: Activity, details: ProductDetails, offerToken: String, accountToken: String) {
    val params = BillingFlowParams.newBuilder()
        .setProductDetailsParamsList(listOf(
            BillingFlowParams.ProductDetailsParams.newBuilder()
                .setProductDetails(details)
                .setOfferToken(offerToken)
                .build()))
        .setObfuscatedAccountId(accountToken)
        .build()
    client.launchBillingFlow(activity, params)
}

// at launch: anything bought elsewhere, or not reported yet
suspend fun restore() {
    val owned = client.queryPurchasesAsync(
        QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build())
    owned.purchasesList.forEach { report(it) }
}

fun report(purchase: Purchase) {
    if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED) return
    // POST /v1/billing/google {"purchaseToken": purchase.purchaseToken, "productId": purchase.products.first()}
}
```

## Testing

`pnpm test` in `billing/` runs Apple transactions and notifications signed
by a fake Apple chain made in the test, Play against a fake Developer API,
and RTDNs signed by a fake Google key. For the real loop: a sandbox
purchase (iOS) or a license tester's purchase (Play) against a preview
Worker.

## Not included yet

- One-time purchases (non-consumables, consumables). Subscriptions only.
- Offer codes, promotional offers and win-back offers that need a signature
  from the server.
- A setup CLI (`flare-billing setup`, `status`, `grant`).
- Revenue numbers. Proceeds, MRR and churn stay in App Store Connect and
  Play Console.
