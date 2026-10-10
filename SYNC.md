# Sync, in depth

Sync for any app: phones share a **space** (a household, a team, a
project), every member writes offline, and everyone converges. No
sign-in: devices prove themselves with App Attest or Android key
attestation, and join with an invite code.

Everything here is generic; an app keeps only its schema, how documents map
onto its own models, how a device proves itself, and when to sync.

| Piece | What it is |
| --- | --- |
| [`PROTOCOL.md`](PROTOCOL.md) | The wire contract. Both halves follow it. |
| `crates/sync-core` | Rust: the phone's SQLite store, the merge rule, field types, and a sync engine that does no networking. |
| `crates/sync-ffi` | UniFFI bindings (`SyncStore`, `position_between`, invite helpers) for Swift and Kotlin. |
| `Package.swift`, `swift/` | Swift package. `SyncKit`: the bindings. `SyncClient`: `SpaceClient` (HTTP), `SyncPass` (push then pull), `SpaceFiles` (photo upload/download), `LiveSocket`. |
| `kotlin/` | Android library `:sync` (a Gradle build at the root). `com.johnkueh.sync.ffi`: the bindings. `com.johnkueh.sync.client`: the same four pieces as Swift. |
| `server/` | `@sync/server`: the space Durable Object (`SpaceObject`), `SyncGateway`, invite codes, files in R2, the `/spaces` calls (`spaces.ts`), the live socket and file routes (`http.ts`), the R2 sweep and a schema drift check. Cloudflare only, no npm dependencies. |

The Rust store comes prebuilt (`scripts/publish-binaries.sh` uploads it to a
public R2 bucket), so no app needs cargo. Apps pin one tag or commit of this
repo on every platform and bump it together.

### Using it from an app

- **Server.** `pnpm add "@sync/server@github:johnkueh/flare#<tag>&path:/server"`,
  export `SpaceObject` (and `SyncGateway` if a web page needs it) from your
  Worker, bind `SPACES` (a SQLite Durable Object), `DB` (D1 with
  `server/migrations/space_codes.sql` applied) and `SPACE_FILES` (R2). Call
  `spaceHttp(request, env, { prefix, authenticate })` before your router, and
  the `spaces.ts` functions from your JSON routes once you know the device.
  Never rename the exported class: Durable Objects are bound by its name.
  The package is TypeScript source; wrangler bundles it. Keep `server/` free
  of npm dependencies.
- **Schema.** One JSON file, `{ "collections": { "<c>": { "<field>": { "merge": "value", "type": "string" } } } }`
  (field types below). Apps bundle it and pass it
  to `SyncStore.open` as it is; the server checks pushes against its
  `collections` with `schemaMismatches`. Nothing is generated from it.
- **iOS.** Add the package `https://github.com/johnkueh/flare` (exact
  version or commit), link `SyncKit` and `SyncClient`, give `SpaceClient` a
  `SpaceTokens`, make your file store a `SpaceFileStore`, and run `SyncPass` /
  `LiveSocket` when it suits you.
- **Android.** Add two repositories and one dependency:

  ```kotlin
  // settings.gradle.kts, dependencyResolutionManagement.repositories
  maven("https://jitpack.io") { content { includeGroup("com.github.johnkueh") } }
  maven("https://pub-796846793f3e431ab3a92e0577c57dde.r2.dev/maven") { content { includeGroup("com.johnkueh.sync") } }
  // app/build.gradle.kts
  implementation("com.github.johnkueh:flare:<tag>")
  testRuntimeOnly("com.johnkueh.sync:sync-ffi-host:<ffiVersion in kotlin/build.gradle.kts>") // JVM tests on a Mac
  ```

  then the same as iOS.
- **Wire types.** `SpaceInfo`, `InvitePreview`, `NewSpace` and `JoinSpace` in
  Swift (`swift/Sources/SyncClient/Generated/WireTypes.swift`) and Kotlin
  (`WireTypes.kt`) are kept by hand next to the server code that builds them.

### Working on sync and an app together

Point the app at a checkout instead of a tag while you work, then tag and
bump: Xcode, drag the checkout into the project (a local package overrides
the remote one); Gradle, `includeBuild("../flare") { dependencySubstitution { substitute(module("com.github.johnkueh:flare")).using(project(":sync")) } }`;
pnpm, `"@sync/server": "link:../flare/server"`.

## The model

Data is collections of JSON documents. Each field is stored as one or more
**entries**, and one rule merges everything: at each entry path, the write
with the larger hybrid-logical-clock timestamp wins. Field types are how the
phone reads entries back:

| Type | Use it for |
| --- | --- |
| `value` | names, checkboxes, amounts: the newest write wins |
| `position` | order in a list (`position_between(before, after)`); moving writes one field |
| `parent` | folders and nesting; the server refuses loops |
| `set` | tags, members: adds and removes from different phones all survive |
| `counter` | counts every phone adds to; no increment is lost |
| `blob` | a reference to a file kept elsewhere (e.g. a content hash in R2) |

Files themselves (photos) live in R2 under `spaces/{spaceId}/{sha256}`
(`server/src/files.ts`, routes in `server/src/http.ts`): `PUT`/`GET /v1/spaces/{id}/blobs/{sha256}` checks
membership with the space and R2 checks the hash. Files kept by the space
object before R2 are moved over by an hourly sweep (and on a read that misses),
then dropped from the object.

Deleting writes a tombstone; any later edit brings the document back.
Long shared text (a document edited by two people at once) is the
one thing this doesn't merge well; that is the planned Loro spike.

## Using it from an app

```swift
let store = try SyncStore.open(path: dbPath, schemaJson: """
  {"groceries": {"name": "value", "done": "value", "position": "position"}}
""")
try store.putDoc(collection: "groceries", doc: id, fieldsJson: #"{"name":"Milk","done":false}"#)
let rows = try store.list(collection: "groceries", orderBy: "position") // JSON array

// Sync loop (the app owns networking):
while let body = try store.takePush() {          // POST /v1/spaces/{id}/push
  do { _ = try store.ackPush(responseJson: try await post(body)) }
  catch { store.failPush(); break }
}
var more = true
while more {                                       // GET /v1/spaces/{id}/changes?since=
  more = try store.applyPull(responseJson: try await get(since: store.cursor())).more
}
```

Pull whenever the live WebSocket (`/v1/spaces/{id}/live`) reports a
version past `cursor()`, on launch, and on foreground.

## Web pages: SyncGateway

A web page doesn't run the Rust store. Its own Worker is the member: it
decides who the browser is (a cookie, say) and calls `SyncGateway`
(`server/src/gateway.ts`) over a service binding. The gateway joins, reads
a collection as plain documents, and writes with the server's clock
(`server/src/docs.ts`, which follows sync-core's rules and positions).

```jsonc
// the API Worker: export { SpaceObject } from "@sync/server/space"; export { SyncGateway } from "@sync/server/gateway"
// a web Worker's wrangler.jsonc:
"services": [{ "binding": "SYNC", "service": "my-api", "entrypoint": "SyncGateway" }]
```

Service bindings never leave the account, so the gateway needs no auth of
its own.

## Commands

```sh
cargo test                       # unit, scenario and convergence property tests
cargo clippy --all-targets
# Bindings. Apps download the store prebuilt; after a Rust change run
# scripts/publish-binaries.sh (macOS) and commit what it rewrites. To try a
# change unpublished, scripts/build-xcframework.sh or
# `./gradlew :sync:buildRustLibs` build it locally, and a local build wins.
cargo build -p sync-ffi --features bindgen
cargo run -p sync-ffi --features bindgen --bin uniffi-bindgen -- generate \
  --library target/debug/libsync_ffi.so --language swift --out-dir out/swift
```

Swift: `swift test` (needs `swift/SyncFFI.xcframework` with its macOS slice,
from `scripts/build-xcframework.sh`). Kotlin: `./gradlew :sync:assembleRelease`.

The server's end-to-end tests live, for now, with the first app's Worker
that hosts it, since its routes sit behind that app's attestation.

## Releasing

1. After a Rust change, `scripts/publish-binaries.sh` on a Mac and commit
   what it rewrites.
2. Tag (`git tag 0.2.0 && git push --tags`). SwiftPM and pnpm read the tag
   straight from GitHub; JitPack builds the Kotlin library on first request.
3. Bump the tag in each app.
