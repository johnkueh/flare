# Push notifications

Push notifications for apps on Flare, with no third-party service. The app's
own Worker keeps each phone's token in its D1 and sends through a Queue
straight to Apple (APNs) and Google (FCM). Both are free.

```
phone (FlarePush) ──PUT /v1/push/device──▶ Worker ──▶ D1 push_tokens
Worker: notify() / notifySpace() ──▶ Queue ──▶ queue() ──▶ APNs / FCM
                                                    └──▶ token gone: row deleted
```

Tokens are keyed by the same device id sync uses, so apps without accounts
work too. With `@flare/auth`, a device also carries its user, and notifying
a user reaches all their phones.

## notifications.json

Every kind of notification the app sends, in one file next to `flags.json`:

```json
{
  "$schema": "node_modules/@flare/push/schema.json",
  "channels": {
    "list": { "name": "List changes", "description": "When someone else adds to a list you share" }
  },
  "notifications": {
    "item_added": {
      "title": "{{list}}",
      "body": "{{actor}} added {{item}}",
      "collapse": true,
      "channel": "list"
    }
  }
}
```

- `{{name}}` is filled from the data you pass to `notify()`.
- `collapse: true`: a newer one replaces the older one on the phone instead
  of stacking (APNs `apns-collapse-id`, Android `tag`), per scope. "Sam
  added eggs" replaces "Sam added milk".
- `interruption`: `passive`, `active` (default) or `time-sensitive` (iOS).
  `passive` also sends at low priority.
- `channels` are Android notification channels. People can switch each one
  off in Settings, and Flare then skips that device for that channel.

## The Worker

```sh
pnpm add "@flare/push@github:johnkueh/flare#<tag>&path:/push"
```

Then, next to the Worker's `wrangler.jsonc`:

```sh
op run --env-file push.env -- npx flare-push setup --ios com.me.app --android com.me.app --firebase my-firebase-project
```

It's safe to rerun, and `--dry-run` says what it would do. It:

- **Worker**: adds the `PUSH_QUEUE` producer and consumer, `vars.APNS_TOPICS`
  (the bundle ids; the first is the default) and the `push_tokens`
  migration next to your others, and creates the queue. Apply the migration
  as usual (`wrangler d1 migrations apply <db> --remote`).
- **Apple**: turns on Push Notifications for each bundle id, with an App
  Store Connect API key (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_FILEPATH`).
  You still add the capability to the target in Xcode.
- **Firebase**: registers the Android app in the project, writes
  `google-services.json` to `android/app/` (it isn't a secret: commit it),
  and, when `FCM_SERVICE_ACCOUNT` isn't set yet, creates a key for the
  project's `firebase-adminsdk` service account and saves it to 1Password as
  `<APP>_FCM_SERVICE_ACCOUNT`. It uses `gcloud`'s sign-in.
- **Secrets**: sets `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID` and
  `FCM_SERVICE_ACCOUNT` on the Worker from the environment.

The secrets live in your password manager, never in the repo or a `.env`.
The first run writes `push.env`, which holds only references (commit it):

```sh
APNS_KEY=op://Vault/APNS_KEY_P8/credential
APNS_KEY_ID=op://Vault/APNS_KEY_ID/credential
APNS_TEAM_ID=op://Vault/APNS_TEAM_ID/credential
FCM_SERVICE_ACCOUNT=op://Vault/MYAPP_FCM_SERVICE_ACCOUNT/credential
```

One APNs key (.p8) serves every app on your Apple team, for sandbox and
production: make it once (developer portal → Keys → Apple Push
Notifications service) and save its contents, id and your team id in those
three items. Each app has its own Firebase project and service account key.
Rotating either is: update the item, rerun `flare-push setup`.

By hand instead: add `push/migrations/push_tokens.sql` to your D1
migrations, the queue below, and the secrets.

```jsonc
// wrangler.jsonc
"queues": {
  "producers": [{ "binding": "PUSH_QUEUE", "queue": "myapp-push" }],
  "consumers": [{ "queue": "myapp-push", "max_batch_size": 100, "max_retries": 5 }]
},
"vars": { "APNS_TOPICS": "com.me.app,com.me.app.dev" }
```

```sh
wrangler queues create myapp-push
wrangler secret put APNS_KEY             # the .p8 file's contents
wrangler secret put APNS_KEY_ID          # the key's 10-character id
wrangler secret put APNS_TEAM_ID
wrangler secret put FCM_SERVICE_ACCOUNT  # the Firebase service account JSON
```

```ts
import { flarePush, relinkPushMember, type PushEnv, type PushMessage } from "@flare/push";
import { notifySpace } from "@flare/push/spaces";
import notifications from "../notifications.json";

export default {
  async fetch(request, env, ctx) {
    const push = flarePush(env, {
      notifications,
      // The same check you give spaceHttp. `member` is the user, or before
      // accounts the device itself.
      identify: async (r) => {
        const who = await whoIs(auth, r.headers);
        return who ? { device: who.deviceId, member: who.userId } : Response.json({ code: "ATTESTATION_REQUIRED" }, { status: 401 });
      },
    });
    const res = push.http(request); // PUT and DELETE /v1/push/device
    if (res) return res;

    // After a write you want to tell people about:
    ctx.waitUntil(notifySpace(env, push, spaceId, { from: who.userId, except: who.deviceId }, "item_added", {
      list: "Flat", actor: "Sam", item: "milk",
    }));
    // or anyone directly:
    await push.notify("item_added", { members: [userId] }, { item: "milk" }, { scope: listId });
  },

  async queue(batch, env) {
    await flarePush(env, { notifications }).queue(batch as MessageBatch<PushMessage>);
  },
} satisfies ExportedHandler<Env>;
```

- `notifySpace` reads the space's members, so someone removed from a
  household stops getting its notifications at once. It doesn't notify the
  sender, and the scope defaults to the space.
- Flare never notifies on writes by itself; you pick the writes that matter.
- With `@flare/auth`, call `relinkPushMember(env, anonymousUserId, userId)`
  next to `relinkMember` in `onLinkAccount`.
- Every send logs one JSON line: `push_sent`, `push_retry`, `push_gone`
  (the token was deleted) or `push_failed`.
- Without `PUSH_QUEUE` bound, `notify()` sends right away.

**APNs needs HTTP/2.** workerd itself doesn't speak it. Deployed Workers
reach Apple because Cloudflare's proxy upgrades the request
([workerd#4841](https://github.com/cloudflare/workerd/issues/4841)), but
`wrangler dev` can't reach APNs. FCM works from both.

### Sending yourself one: `flare-push test`

`flare-push test` sends from your machine with the same code, so it also
reaches APNs while you develop:

```sh
op run --env-file push.env -- npx flare-push test --member <your user id> --key item_added --data actor=Sam --data item=milk
op run --env-file push.env -- npx flare-push test --token <token> --platform ios --sandbox --app-id com.me.app
```

`--member` and `--device` read the tokens from the Worker's remote D1;
`--token` takes one straight from a log. Builds from Xcode have sandbox
tokens. It says why a send failed (a dead token, a sandbox token sent to
production, a key that doesn't match its id or team).

## Asking for permission

Both platforms give you few chances, and App Review now polices how you ask.

- **iOS asks once.** After a denial, only Settings turns notifications back
  on. App Review rejects a screen before the system prompt that has a "Not
  now" or "Cancel" exit (Guideline 5.1.1(iv)). A screen like that must lead
  straight to the prompt, with a button such as "Continue".
- **Android 13+** starts new installs with notifications off. After two
  denials the dialog stops appearing.

What works:

1. **Never ask at launch.** Ask where the value is obvious and the person
   just did something: "Get told when Mia adds to the list", after joining
   a household.
2. **Use an inline entry point**: a bell or a card in the screen where the
   feature lives, not a modal. Its button calls the system prompt directly.
   Ignoring the card is fine; it isn't a pre-prompt exit. If the person
   dismisses it, call `snooze()` and check `canAsk` before showing it again.
3. **On iOS, try quiet first** for low-stakes apps. `requestQuiet()`
   delivers to Notification Center with no prompt, and the full ask stays
   available.
4. **When blocked**, show a quiet "Notifications are off · Open Settings"
   row where the feature lives (`openSettings()`). Don't nag on launch.

The clients have no UI. The state is the same four values on both
platforms: `notAsked`, `quiet` (iOS provisional), `allowed` and `blocked`.
Android has no API that says "blocked", so Flare works it out. The server
skips blocked devices, and devices with that channel switched off.

## iOS

`FlarePush` is in `SyncClient`. Turn on the Push Notifications capability.

```swift
let push = FlarePush(baseURL: URL(string: "https://api.example.com/v1")!, tokens: auth,
                     onEvent: { name, params in telemetry.track(name: name, params: params) })

// AppDelegate
func application(_ app: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
    Task { await push.didRegister(deviceToken: token) }
}
func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    if let tap = await push.opened(response.notification.request.content.userInfo) { route(tap.key, tap.data) }
}

// On launch, and when the scene becomes active
await push.refresh()
```

The inline ask, in SwiftUI:

```swift
if push.canAsk {
    HStack {
        Label("Get told when Mia adds to the list", systemImage: "bell")
        Spacer()
        Button("Turn on") { Task { await push.request() } }
        Button { push.snooze() } label: { Image(systemName: "xmark") }
    }
} else if push.permission == .blocked {
    Button("Notifications are off · Open Settings") { push.openSettings() }
}
```

- `environment: .automatic` (the default) reads `aps-environment` from the
  provisioning profile. Builds from Xcode send sandbox tokens; TestFlight
  and the App Store send production ones.
- The notification's data is in `userInfo["data"]`, and its key in
  `userInfo["key"]`.

## Android

`FlarePush` is in `com.johnkueh.sync.client`. The app keeps Firebase
Messaging (`google-services.json`, `firebase-messaging`) and declares
`<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>`.

```kotlin
val push = FlarePush(context, "https://api.example.com/v1", auth, onEvent = { name, params -> telemetry.track(name, params) })
push.createChannels(context.assets.open("notifications.json").reader().readText())

// At launch, and in FirebaseMessagingService.onNewToken
push.setToken(FirebaseMessaging.getInstance().token.await())

// onResume
push.refresh(activity)
```

The inline ask, in Compose:

```kotlin
val state by push.permission.collectAsState()
val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    scope.launch { push.onPermissionResult(activity, granted) }
}
when {
    push.canAsk && push.needsRuntimePermission -> Row {
        Text("Get told when Mia adds to the list")
        TextButton(onClick = { push.willAsk(); launcher.launch(Manifest.permission.POST_NOTIFICATIONS) }) { Text("Turn on") }
        IconButton(onClick = { push.snooze() }) { Icon(Icons.Default.Close, "Not now") }
    }
    state == PushPermission.BLOCKED -> TextButton(onClick = { push.openSettings(context) }) {
        Text("Notifications are off · Open Settings")
    }
}
```

Below Android 13 notifications are on unless switched off, so there's
nothing to ask. `refresh()` still reports a switched-off app as `blocked`.

## Not included yet

These come when an app needs them:

- rollups ("Sam added 4 items")
- per-type preferences and quiet hours
- an email fallback
- Live Activities
- web push
