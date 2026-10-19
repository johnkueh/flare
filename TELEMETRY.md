# Telemetry

Product analytics for apps on Flare, with no Firebase or GA4. Events go
from the app to a Worker and land in an Iceberg table in R2 (Cloudflare
Basin), which you query with SQL.

```
app (telemetry-sdk, Rust) ──POST /v1/events──▶ Worker ──▶ Basin stream ──▶ telemetry.events (Iceberg, by day)
web page (@flare/telemetry/browser) ─▶ your Worker (/api/events) ─┘
your Worker (@flare/telemetry/server) ─────────────────────────────┘
Search Console API ──daily──▶ Worker ─┘
```

One product (say `ledgersignal`) uses one `app_id` on every platform, told
apart by `platform` (`ios`, `android`, `web`, `server`, `search`), and one
`events.json`, so a funnel from a Google search to a web sign-up to the
phone app is one query.

At small-app volume this costs nothing beyond Workers Paid: ingest is free,
the first 50 GB a month of pipeline processing is included, and Basin SQL
scans 10 GB a month free.

## The SDK (`crates/telemetry`)

One Rust crate for iOS, Android, macOS, Linux and Windows. It:

- stamps every event with an event id, timestamp, session id (new after 30
  minutes idle) and the install id, and sends `first_open` and
  `session_start` itself;
- appends each event to `queue.jsonl` in a folder the app owns, so a crash
  or a day offline loses nothing (oldest dropped past `max_queue_size`);
- sends batches from a background thread every `flush_interval_secs`, as
  soon as `max_batch_size` events are waiting, or on `flush()`, retrying
  with backoff (5 s to 5 min) on network errors, 408, 429 and 5xx;
- never blocks the caller and never throws after `new`.

It has no bindings of its own. Link it into the app's UniFFI library and
the bindings come out as a separate `telemetry_sdk` module next to yours:

```toml
# your-core/Cargo.toml
[dependencies]
telemetry-sdk = { git = "https://github.com/johnkueh/flare", tag = "<tag>", features = ["uniffi"] }
```

```rust
// your-core/src/lib.rs
pub use telemetry_sdk; // links TelemetryClient into your library
```

Swift: copy `telemetry_sdk.swift` next to your bindings and add
`telemetry_sdkFFI.h` plus its module map to your xcframework headers (one
`module.modulemap` can hold both modules). Kotlin: the generated
`uniffi.telemetry_sdk` package loads your library automatically.

```swift
let client = try TelemetryClient(config: TelemetryConfig(
    endpoint: "https://<your telemetry Worker>/v1/events",
    appKey: "k_…", appId: "myapp", env: "prod", platform: "ios",
    appVersion: "2.0", appBuild: "42", osVersion: "26.0", deviceModel: "iPhone17,1",
    locale: "en_AU", storageDir: supportDir.path,
    flushIntervalSecs: 30, maxBatchSize: 50, maxQueueSize: 5000))
client.track(name: "dose_logged", params: ["mg": .double(value: 2.5)])
client.flush() // when the app goes to the background
```

Event names and param keys are lowercase snake case (1 to 64 chars); others
are dropped. Strings are cut at 500 chars, non-finite numbers dropped.
Which events and params an app sends is the app's own contract.

For web pages and Workers there are TS senders with the same ids and batch
format; see "Web projects" below.

## Crashes, hangs and errors

Problems are ordinary events, so they land in the same table and every app
decides its own reporting (a digest, an alert, a dashboard) in SQL.

| Event | When | Source |
|---|---|---|
| `crash` | the process died | iOS MetricKit; Android uncaught-exception handler, or ApplicationExitInfo for native crashes |
| `hang` | the main thread was stuck | iOS MetricKit hang diagnostics; Android ANRs from ApplicationExitInfo |
| `error` | caught, but worth counting | `client.report(...)`, `reportError`, Rust panics UniFFI turned into exceptions |

Each one's params hold `type`, `message`, `frames` (innermost first: `module`,
`function`, `file_line`, `offset`, `image_id`, `in_app`), `breadcrumbs` (the
last 30 events before it), `from_previous_run`, and `crashed_version` /
`crashed_build` when the OS says which build crashed. The Worker adds
`fingerprint` (kind + type + the top three in-app frames, not the message)
and a readable `title`, and trims to 30 frames.

A crash found on the next launch is filed under the session it happened in
and the time the OS gives, with the previous run's breadcrumbs. iOS frames
are binary + offset (MetricKit has no symbols), so the same bug groups per
build; `flare-telemetry crash` turns them back into names (below).
MetricKit only reports for users who share analytics with app developers.

There is no extra dependency. The platform code is two files to copy next to
the generated bindings:

- **Swift** `crates/telemetry/platform/swift/FlareCrashes.swift`, in the same
  module as `telemetry_sdk.swift`: `FlareCrashes.start(client)` at launch,
  `client.reportError(error)` for caught errors.
- **Kotlin** `crates/telemetry/platform/kotlin/FlareCrashes.kt`:
  `FlareCrashes.start(context, client)` in `Application.onCreate`,
  `FlareCrashes.reportError(client, e)` for caught errors.

Both install the Rust panic hook (`client.installPanicHook()`); other
platforms can call it directly.

```sql
-- Problems by group, last 7 days
SELECT name, json_get_str(params, 'fingerprint') AS fp, json_get_str(params, 'title') AS title,
       COUNT(*) AS n, COUNT(DISTINCT install_id) AS installs, MAX(app_version) AS latest
FROM telemetry.events
WHERE app_id = 'glp3' AND env = 'prod' AND name IN ('crash', 'hang', 'error')
  AND __ingest_ts >= '2026-10-10'
GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 50

-- Crash-free sessions by version
SELECT app_version,
       1 - COUNT(DISTINCT CASE WHEN name = 'crash' THEN session_id END) * 1.0
         / COUNT(DISTINCT CASE WHEN name = 'session_start' THEN session_id END) AS crash_free
FROM telemetry.events
WHERE app_id = 'glp3' AND env = 'prod' AND __ingest_ts >= '2026-10-10'
GROUP BY 1 ORDER BY 1 DESC LIMIT 20
```

### Readable stacks

Phones send what they have: iOS frames are binary + offset + the binary's
UUID, and Android release builds carry R8's renamed classes
(`a.b.c(SourceFile:2)`). The names come back when you read a crash, from the
symbol files each release build leaves behind. Nothing changes in the Worker
or the table.

Once per account: `npx wrangler r2 bucket create flare-symbols`.

After each release build, upload its symbols (with the `CLOUDFLARE_API_TOKEN`
you use for any wrangler command):

```sh
npx flare-telemetry symbols build/Cooked.xcarchive        # or a .dSYM, or a folder of them
npx flare-telemetry symbols app/build/outputs/mapping/release/mapping.txt --app cooked --build 42
```

Apple dSYMs are stored by UUID, so any build of any app finds its own. An
R8 mapping is stored by app and build number (`versionCode`, the `app_build`
column). For line numbers on Android, keep them in `proguard-rules.pro`:

```
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
```

Then read crashes (with `WRANGLER_BASIN_SQL_AUTH_TOKEN`, or the same
`CLOUDFLARE_API_TOKEN`, and `FLARE_TELEMETRY_WAREHOUSE` set to your Basin
warehouse, `<account id>_telemetry`; see "Querying"):

```sh
npx flare-telemetry crash --app cooked                    # groups, last 7 days (--days, --env)
npx flare-telemetry crash 3fa2c1d09e8b7f61 --app cooked   # the newest one, readable
```

```
crash  EXC_BAD_ACCESS SIGSEGV
KERN_INVALID_ADDRESS at 0x0
1.4 (42), ios, 26.1, iPhone17,1, 2026-10-17T10:22

   * Cooked  (inlined) RecipeStore.validate()  RecipeStore.swift:31
 0 * Cooked  RecipeStore.save(_:)  RecipeStore.swift:88
 1 * Cooked  closure #1 in ImportView.body.getter  ImportView.swift:54
 2   UIKitCore  +0x2a1f0c
```

`*` marks the app's own frames. System libraries stay as offsets: crash
groups are decided by the app's frames anyway. On a Mac, a dSYM still in an
Xcode archive on that Mac is found by Spotlight without uploading. Lookups
use `atos` on a Mac (it demangles Swift) and `llvm-symbolizer` elsewhere;
symbol files are cached in `~/.cache/flare-symbols`. `crash --file
event.json` reads one exported row instead of querying.

Native Android crashes (C/C++/Rust in a `.so`) still arrive without frames.

## Web projects

```sh
pnpm add "@flare/telemetry@github:johnkueh/flare#<tag>&path:/telemetry"
npx flare-telemetry init --app ledgersignal
```

`init` writes `events.json`, binds your ingest Worker in `wrangler.jsonc` as
`TELEMETRY` (a service binding, so no public hop), and prints an app key
and the code below. Add the key to `APP_KEYS` in your telemetry Worker's
`wrangler.jsonc` and deploy it. `--service <name>` binds a Worker not named
`flare-telemetry`. `npx flare-telemetry check` in CI keeps `events.json` to
the naming rules.

### events.json

```json
{
  "events": {
    "statement_extracted": { "description": "A statement's rows are in.", "params": { "pages": 0, "bank": "" } }
  }
}
```

A param's type comes from its example value: a number, `true`/`false` or
text. `track` is typed from the imported file (no code generation), so a
misspelt event or a wrong param type doesn't compile. `first_open`,
`session_start`, `page_view` and `error` are always allowed.

### In the browser

```ts
import { telemetry } from "@flare/telemetry/browser";
import events from "../events.json";

export const t = telemetry({ appId: "ledgersignal", appKey: "k_…", events, env: import.meta.env.PROD ? "prod" : "dev" });
t.identify(user.id);                   // after sign-in; null after sign-out
t.track("csv_exported", { rows: 120 });
```

It does what the Rust SDK does: an install id and a session id (new after
30 idle minutes) in localStorage, `first_open` and `session_start`, a queue
that survives a reload, batches every 10 s or at 50 events, a `keepalive`
flush when the tab is hidden, and retry on network errors, 408, 429 and
5xx. It also sends a `page_view {path, referrer}` on load and on every
History API navigation (any router), without the query string, and an
`error` for uncaught errors and rejections, in the crash shape above.
When a path segment names a customer (a case or client slug), pass
`pagePath: (p) => p.replace(/^\/cases\/[^/]+/, "/cases/:slug")` so the
table holds the route, not the name.

It posts to `/api/events` on the page's own origin, so ad blockers and
CORS stay out of it, and keeps its ids in a first-party `flare_ids` cookie
so the Worker can file its own events under the same session.

### In the Worker

```ts
import { mountEvents, serverTelemetry } from "@flare/telemetry/server";
import events from "../events.json";

const telemetry = serverTelemetry({ target: env.TELEMETRY, appId: "ledgersignal", appKey: "k_…", events });

// the browser's batches (adds the visitor's country, then forwards)
if (url.pathname === "/api/events") return mountEvents(request, env.TELEMETRY);

// product events, sent where they happen
telemetry.track("statement_extracted", { pages: 12 }, { userId, request, waitUntil: (p) => ctx.waitUntil(p) });
```

Server events have `platform = "server"`. With `request`, they take the
browser's install and session ids from its cookie and the visitor's
country; with `waitUntil`, the response never waits on them. Sending never
throws. Off Cloudflare, `target` is the Worker's URL instead of a binding.

What matters for the product (an upload finished, an extraction failed) is
best sent from the server: ad blockers can't drop it and nobody can fake
it. Keep customer content out of params; send ids and counts.

## Search Console

The Worker pulls Google Search Console's Search Analytics API every day at
06:00 UTC for the day three days back (when Google's numbers are final), one
`gsc_query` row per site, day, query, page, country and device:
`platform = "search"`, params `site, date, query, page, country, device,
clicks, impressions, position`. Search Console has no push, and its bulk
export only goes to BigQuery, which is why it's a pull.

Setup, once:

1. In Google Cloud, enable the Search Console API and make a service
   account with a JSON key: `npx wrangler secret put GSC_SERVICE_ACCOUNT`
   (paste the JSON).
2. In Search Console, add the service account's email to each property as a
   restricted user.
3. List the properties in `GSC_SITES` (`{"sc-domain:ledgersignal.com":
   "ledgersignal"}`) and deploy.

To backfill (the API keeps 16 months), set `GSC_ADMIN_TOKEN` and post a day
at a time:

```sh
curl -X POST https://<your telemetry Worker>/v1/gsc/pull \
  -H "authorization: Bearer $GSC_ADMIN_TOKEN" -d '{"date":"2026-06-01"}'
```

```sql
-- Top queries last 28 days
SELECT json_get_str(params, 'query') AS query,
       SUM(json_get_int(params, 'clicks')) AS clicks, SUM(json_get_int(params, 'impressions')) AS impressions
FROM telemetry.events
WHERE app_id = 'ledgersignal' AND name = 'gsc_query' AND client_ts >= '2026-09-19'
GROUP BY 1 ORDER BY clicks DESC LIMIT 50
```

The cron pulls each day once. A day pulled again by hand writes its rows
again, with the same `event_id`s, so count `DISTINCT event_id` (or pull
only days you haven't) when that matters.

Google leaves out rare queries for privacy, so the query rows add up to
less than the site's total clicks.

## Cloudflare Web Analytics

It's a separate, free product: a cookieless beacon (or one toggle on a
proxied zone) for page views, referrers and Core Web Vitals, kept in the
Cloudflare dashboard. It has no custom events or user ids and doesn't feed
this table or Search Console. With `page_view` sent for you, you don't need
it for numbers; turn it on for marketing sites if you want Web Vitals.

## The Worker (`telemetry/`)

`handleEvents(request, env)` checks the `x-app-key` header against
`APP_KEYS`, turns a batch into rows (`telemetry/schema.json`), corrects the
timestamps of a phone whose clock is off (by the gap between its `sent_at`
and the server's time), adds the country (or takes the one an app's Worker passed on), and sends the rows to the stream
bound as `EVENTS`. A bad batch gets a 400 and the SDK drops it; a failed
write is a 5xx and the SDK retries.

Deploy your own from `telemetry/wrangler.example.jsonc`: copy it to
`telemetry/wrangler.jsonc` (gitignored, so your ids stay out of the repo),
add your stream id, then `npx wrangler deploy`. One Worker can serve all
your apps. To add an app, add a key to `APP_KEYS` and deploy. App keys are not
secrets; they ship in the app, like a GA4 measurement id.

## Setting up Basin (once per account)

```sh
cd telemetry
npx wrangler r2 bucket create telemetry
npx wrangler basin catalog enable telemetry
npx wrangler basin pipelines streams create telemetry_events --schema-file schema.json --http-enabled false
npx wrangler basin pipelines sinks create telemetry_events_sink --type basin-catalog \
  --bucket telemetry --namespace telemetry --table events --roll-interval 60 \
  --catalog-token <R2 Admin Read & Write token>
npx wrangler basin pipelines create telemetry_events \
  --sql "INSERT INTO telemetry_events_sink SELECT * FROM telemetry_events"
```

A stream's schema can't change after it's created, which is why event
params are one `json` column. Rows reach the table about a minute after
they arrive (`--roll-interval 60`).

## Querying

```sh
npx wrangler basin sql query <account id>_telemetry \
  "SELECT name, COUNT(*) FROM telemetry.events
   WHERE app_id = 'glp3' AND env = 'prod' AND __ingest_ts >= '2026-10-01'
   GROUP BY name ORDER BY 2 DESC LIMIT 50"
```

Filter on `__ingest_ts` (the day partition) so a query reads only the days
it needs.
