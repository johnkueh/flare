# Flags

Feature flags for apps on Flare, served by [Cloudflare Flagship](https://developers.cloudflare.com/flagship/).
You list your flags in one `flags.json`; every platform gets typed reads
from it with no codegen step to remember, and Flagship decides the values
(rollouts, targeting, kill switches) from its dashboard or CLI.

```
app (Swift · Kotlin · web · Node · Rust) ──POST /ofrep/v1/evaluate/flags──▶ your Worker ──▶ Flagship binding
```

| Platform | Package | Reads look like |
| --- | --- | --- |
| Worker (server) | `@flare/flags/server` | `await evaluateFlags(env.FLAGS, flags, ctx)` |
| Web page | `@flare/flags` | `flags.get("new-checkout")` (typed from the JSON) |
| Node, CLI tools | `@flare/flags` + `@flare/flags/node` | the same, cached in a file |
| iOS, macOS | `SyncClient` + the `FlareFlags` build plugin | `flags.newCheckout` |
| Android | `com.github.johnkueh:flare` + `flare-flags.gradle` | `flags.newCheckout` |
| Rust (CLIs, servers) | `flare-flags` crate | `flags.bool("new-checkout")` |

The wire format is [OFREP](https://openfeature.dev/specification/appendix-c/),
OpenFeature's remote evaluation protocol, so any OpenFeature OFREP provider
can read the same endpoint.

## How values behave

- **Reads never wait and never fail.** A read returns the last value the
  Worker sent (kept on disk), else the default in `flags.json`. A flag the
  server doesn't know, or answers with the wrong type, reads as its default.
- **Offline is fine.** The app starts with the values from its last run,
  even with no network. Cached values belong to one user: after a sign-in
  or sign-out they're not reused.
- **Screens don't change under the user.** A flag the app has already read
  keeps its value until the app next comes to the foreground (or the page
  becomes visible again); then new values apply. Flags not read yet take
  new values at once.
- **`"live": true` flags change at once**, read or not. Use it for kill
  switches.
- **It refreshes** on launch, on foreground, every 5 minutes while open,
  and when you call `refresh()`. Requests carry an ETag, so an unchanged
  answer is a 304. There's no socket: a kill switch reaches open apps
  within the refresh interval (lower it, or call `refresh()` from a push).
- **Per user.** Flagship sees `targetingKey` (the signed-in user, else a
  random id per install), plus `platform`, `appVersion`, `osVersion`,
  `locale` and `country`. Percentage rollouts stay stable per key. After
  `setUser`, values reset to defaults until that user's arrive.

## flags.json

One file, next to your Worker or app code (share it between them):

```json
{
  "$schema": "https://flare.jkyf.dev/flags.schema.json",
  "flags": {
    "new-checkout": { "default": false, "description": "The one-page checkout." },
    "max-items": { "default": 200 },
    "banner": { "default": "" },
    "paywall": { "default": { "plan": "yearly", "trial": 7 } },
    "read-only": { "default": false, "live": true, "description": "Kill switch." }
  }
}
```

- The type comes from the default: `true`/`false` is a boolean, a whole
  number an integer, `0.5` a number, text a string, `{}` or `[]` an object.
  Set `"type": "number"` when a whole-number default should still allow
  fractions.
- Keys start with a letter and use letters, digits, `-` and `_` (at most
  64). `new-checkout` becomes `newCheckout` in Swift and Kotlin.
- The default is what the app uses until the Worker answers, and whenever
  it can't. Make it the safe choice.

Adding a flag is: edit `flags.json`, run `flare-flags sync`, build. Swift
and Kotlin regenerate on every build, on any machine, so no one needs a
Mac to add a flag.

## Worker

```sh
pnpm add "@flare/flags@github:johnkueh/flare#0.4.0&path:/flags"
npx wrangler flagship apps create my-app   # once; note the app id
```

```jsonc
// wrangler.jsonc
"flagship": [{ "binding": "FLAGS", "app_id": "<app id>" }]
```

```ts
import { flagsHttp, type FlagshipBinding } from "@flare/flags/server";
import flags from "../flags.json" with { type: "json" };

export default {
  async fetch(request: Request, env: { FLAGS: FlagshipBinding }) {
    const res = await flagsHttp(request, {
      binding: env.FLAGS,
      flags,
      // Optional: target the real signed-in user instead of trusting the client.
      context: async ({ defaults }) => ({ ...defaults, targetingKey: (await currentUser(request))?.id ?? defaults.targetingKey }),
    });
    if (res) return res;
    // …the rest of your routes
  },
};
```

`flagsHttp` answers `POST /ofrep/v1/evaluate/flags` (all flags) and
`/ofrep/v1/evaluate/flags/<key>` (one), and returns `null` for anything
else. `prefix: "/v1"` mounts it elsewhere; `cors: "*"` (or a list of origins) adds
CORS headers for pages on other origins. Using static assets with
`run_worker_first`? Add `"/ofrep/*"` to it.

Inside the Worker, read flags directly:

```ts
import { evaluateFlags } from "@flare/flags/server";
const v = await evaluateFlags(env.FLAGS, flags, { targetingKey: userId, plan: "pro" });
if (v["new-checkout"]) …   // typed: boolean
```

### Keeping Flagship in step: `flare-flags`

The package ships a CLI that reads `flags.json` and the `flagship` binding
in your wrangler config:

```sh
npx flare-flags sync              # create flags Flagship doesn't have yet (remote)
npx flare-flags sync --local      # the same for `wrangler dev`'s local store
npx flare-flags check             # CI: fail if a flag is missing or has the wrong type
npx flare-flags list
npx flare-flags set read-only true --dev http://localhost:8787   # flip one in a running wrangler dev
```

`sync` only creates flags (off, serving the default) and never changes one
that exists, so rollouts you set in the dashboard stay put. Put
`flare-flags sync --local && wrangler dev` in your dev script, and
`flare-flags check` before `wrangler deploy`.

## Web pages

```ts
import { createFlags } from "@flare/flags";
import schema from "./flags.json" with { type: "json" };

export const flags = createFlags({ server: "", flags: schema, context: { platform: "web" } });

flags.get("new-checkout");             // boolean, typed from the JSON
flags.subscribe((changed) => render());
await flags.setUser(userId);           // after sign-in; null after sign-out
```

Values are kept in `localStorage`. `server: ""` means the page's own
origin. Options: `headers` (a function, for `Authorization`),
`refreshInterval` (ms, `0` to turn off), `prefix`, `storage`, `fetch`.

## Node and command-line tools

```ts
import { createFlags } from "@flare/flags";
import { fileStorage } from "@flare/flags/node";
import schema from "./flags.json" with { type: "json" };

const flags = createFlags({
  server: "https://api.example.com",
  flags: schema,
  storage: fileStorage(`${homedir()}/.my-tool/flags.json`),
  refreshInterval: 0,
});
await flags.ready;                     // one request; on failure the cache or defaults
if (flags.get("new-checkout")) …
```

`ready` settles after the first refresh, even offline. A long-running
server process can keep the default interval (the timer doesn't hold the
process open) and call `flags.activate()` between requests, or use
`evaluateFlags` against the binding when it is the Worker.

## iOS and macOS

Add the package `https://github.com/johnkueh/flare` (0.4.0 or later), link
`SyncKit` and `SyncClient`, and add the `FlareFlags` build tool plugin to
your app target:

- **Xcode project**: target → Build Phases → Run Build Tool Plug-ins → `+` → FlareFlags.
- **XcodeGen**: `buildToolPlugins: [{ plugin: FlareFlags, package: Flare }]`.
- **SwiftPM target**: `plugins: [.plugin(name: "FlareFlags", package: "flare")]`.

Xcode asks you to trust the plugin on its first build ("Trust & Enable").
On CI, pass `-skipPackagePluginValidation` to `xcodebuild`.

The plugin finds `flags.json` in the target's folder or up to five folders
above it, and writes a typed property per flag on every build:

```swift
import SyncClient

@MainActor let flags = Flags.start(server: URL(string: "https://api.example.com")!)

if flags.newCheckout { … }               // Bool
let limit = flags.maxItems               // Int
let paywall = flags.paywall.decode(Paywall.self)   // your Decodable, or nil
await flags.setUser(userID)              // after sign-in; nil after sign-out
```

`Flags` is `@Observable`: a SwiftUI view that reads a flag redraws when it
changes. `flags.changes()` is an `AsyncStream` of changed keys.
`Flags.Options` takes `refreshInterval`, `headers` (async, for
`Authorization`), extra targeting `context`, a `prefix` and a `URLSession`.
Values are cached in Application Support.

## Android

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("com.github.johnkueh:flare:0.4.0")
}
// after the android { } block:
apply(from = "https://raw.githubusercontent.com/johnkueh/flare/0.4.0/kotlin/flare-flags.gradle")
```

The script finds `flags.json` in the module or up to four folders above it
(or set `flareFlagsFile` in `gradle.properties`) and generates a typed
property per flag before every build, in your `android.namespace` package:

```kotlin
class App : Application() {
    lateinit var flags: Flags
    override fun onCreate() {
        super.onCreate()
        flags = Flags.start(this, "https://api.example.com")
    }
}

if (flags.newCheckout) …                          // Boolean
val paywall = flags.paywall.decode<Paywall>()     // your @Serializable, or null
scope.launch { flags.setUser(userId) }            // after sign-in; null after sign-out
```

In Compose, read `flags.revision.collectAsState()` in a composable and
it recomposes when a flag changes; `flags.flow { newCheckout }` is a `Flow`
of one flag. `Flags.Options` takes `refreshIntervalMs`, `headers`,
`context`, `prefix` and an `OkHttpClient`.

## Rust

For a CLI or server in Rust, the same core the phones use:

```toml
flare-flags = { git = "https://github.com/johnkueh/flare", tag = "0.4.0", features = ["http"] }
```

```rust
let mut flags = flare_flags::Flags::open(include_str!("../flags.json"), Some(cache_path), None)?;
let _ = flags.refresh("https://api.example.com", &[], &Default::default()); // offline: keeps the cache
if flags.bool("new-checkout") { … }
flags.save()?;
```

Without the `http` feature there's no network code: call
`request_body`, send it however you like, and hand the answer to
`apply(status, etag, body)`. See `crates/flags/examples/flags.rs`.

## The example

`example/` uses four flags end to end: `banner` (string), `show-counts`,
`max-items` and `read-only` (live). `pnpm dev` there syncs them into the
local store and starts the Worker; flip one while the web page, iOS app or
Android app is open:

```sh
cd example
npx flare-flags set banner '"Back at 5pm"' --dev http://localhost:8787
npx flare-flags set read-only true --dev http://localhost:8787
pnpm flags -- --watch      # the same flags from a Node CLI
```

## Releasing

`flags/dist` is checked in so Node can use the package straight from
GitHub: run `pnpm build` in `flags/` after changing `flags/src`.
