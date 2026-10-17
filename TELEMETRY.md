# Telemetry

Product analytics for apps on Flare, with no Firebase or GA4. Events go
from the app to a Worker and land in an Iceberg table in R2 (Cloudflare
Basin), which you query with SQL.

```
app (telemetry-sdk, Rust) ──POST /v1/events──▶ Worker ──▶ Basin stream ──▶ telemetry.events (Iceberg, by day)
```

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
    endpoint: "https://flare-telemetry.your-subdomain.workers.dev/v1/events",
    appKey: "k_…", appId: "glp3", env: "prod", platform: "ios",
    appVersion: "2.0", appBuild: "42", osVersion: "26.0", deviceModel: "iPhone17,1",
    locale: "en_AU", storageDir: supportDir.path,
    flushIntervalSecs: 30, maxBatchSize: 50, maxQueueSize: 5000))
client.track(name: "dose_logged", params: ["mg": .double(value: 2.5)])
client.flush() // when the app goes to the background
```

Event names and param keys are lowercase snake case (1 to 64 chars); others
are dropped. Strings are cut at 500 chars, non-finite numbers dropped.
Which events and params an app sends is the app's own contract.

For a web page, post the same JSON from TypeScript; there is no WASM build.

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
build; symbolicate with `atos -o <dSYM> -l 0x0 <offset>` or `llvm-symbolizer`.
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

## The Worker (`telemetry/`)

`handleEvents(request, env)` checks the `x-app-key` header against
`APP_KEYS`, turns a batch into rows (`telemetry/schema.json`), corrects the
timestamps of a phone whose clock is off (by the gap between its `sent_at`
and the server's time), adds the country, and sends the rows to the stream
bound as `EVENTS`. A bad batch gets a 400 and the SDK drops it; a failed
write is a 5xx and the SDK retries.

The shared deployment is `flare-telemetry` (`telemetry/wrangler.jsonc`).
To add an app, add a key to `APP_KEYS` and deploy. App keys are not
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
npx wrangler basin sql query YOUR_ACCOUNT_ID_telemetry \
  "SELECT name, COUNT(*) FROM telemetry.events
   WHERE app_id = 'glp3' AND env = 'prod' AND __ingest_ts >= '2026-10-01'
   GROUP BY name ORDER BY 2 DESC LIMIT 50"
```

Filter on `__ingest_ts` (the day partition) so a query reads only the days
it needs.
