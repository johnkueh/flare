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
  `server/migrations/space_codes.sql` and `space_members.sql` applied) and `SPACE_FILES` (R2). Call
  `spaceHttp(request, env, { prefix, authenticate })` before your router, and
  the `spaces.ts` functions from your JSON routes once you know the device.
  Never rename the exported class: Durable Objects are bound by its name.
  The package is TypeScript source; wrangler bundles it. Keep `server/` free
  of npm dependencies.
- **Schema.** One JSON file, `{ "collections": { "<c>": { "<field>": { "merge": "value", "type": "string" } } } }`
  (field types below). Apps bundle it and pass it
  to `SyncStore.open` as it is; the server checks pushes against its
  `collections` with `schemaMismatches`. Nothing is generated from it.
  An app whose records live in Rust keeps them in step with a test:
  add `sync-core` as a dev-dependency and assert that
  `Schema::from_json(file).check_sample("<collection>", &serde_json::to_value(sample))`
  is empty for a sample record with every field filled in.
- **Saving records.** `putDoc` skips fields whose value is already stored,
  so pass the whole record on every save. Only changed fields get a new
  timestamp, and another phone's edit to a different field of the same
  record still survives. Null clears a field (and empties a set).
- **iOS.** Add the package `https://github.com/johnkueh/flare` (exact
  version or commit), link `SyncKit` and `SyncClient`, give `SpaceClient` a
  `SpaceTokens` (`FlareAuth`, with `@flare/auth`: AUTH.md), make your file store a `SpaceFileStore`, and run `SyncPass` /
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

### Why not Yjs

Yjs and Automerge are built for text two people type into at once, and
they keep a history of every character to do it. App data is mostly
records: a grocery item, an issue, a shape. For records, the simpler rule
above is what the big multiplayer apps use:

- **Figma** merges each property with last-writer-wins, orders children
  with fractional indexing, and keeps parent links from forming loops
  ([How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)).
  Flare's `value`, `position` and `parent` types are those three ideas.
- **Linear** syncs issues the same way: last-writer-wins per field, with
  manual ordering that its CTO describes as CRDT-like, and a server as the
  one authority ([Tuomas Artman](https://x.com/artman/status/1330496043650310151)).
  It uses a CRDT only for issue descriptions.

The one difference: Figma and Linear order writes by when the server sees
them. Flare orders them by a hybrid logical clock stamped on the phone, so
an edit made offline keeps its place when it syncs a day later.

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

## Reacting to changes on the server

Triggers run your Worker's code after documents change, whoever changed
them: a phone's push, a web page through SyncGateway, or the server itself.
Use them for work a phone can't or shouldn't do: start a job, fill in
derived fields, send a push notification.

Each space reports what it committed to a queue you bind, and keeps trying
until the queue takes it. Your queue handler passes the batch to
`syncTriggers`, which reads each changed document as it is now and calls
that collection's trigger (`server/src/triggers.ts`).

```jsonc
// wrangler.jsonc
"queues": {
  "producers": [{ "binding": "SYNC_TRIGGERS", "queue": "my-app-sync-triggers" }],
  "consumers": [{ "queue": "my-app-sync-triggers", "max_batch_timeout": 1, "dead_letter_queue": "my-app-sync-triggers-failed" }]
}
```

```ts
import { syncTriggers, type SyncTriggers } from "@sync/server/triggers";

// A song a phone queued gets analysed, and the result syncs back.
const triggers: SyncTriggers<Env> = {
  songs: {
    fields: ["link", "status"], // the job's own fields (step, sheet) don't call it
    async changed({ env, space, id, doc }) {
      if (doc?.status !== "queued") return;
      // At least once: the same change can arrive twice, so the job's id
      // is the change's, and a second delivery finds it already started.
      const job = `${space.id}-${id}-${doc._t}`;
      if (!(await env.ANALYSE.get(job).catch(() => null))) {
        await env.ANALYSE.create({ id: job, params: { spaceId: space.id, songId: id, link: doc.link } });
      }
      await space.write([{ c: "songs", d: id, f: "status", v: "analysing" }]);
    },
  },
};

export default {
  fetch,
  queue: (batch, env) => syncTriggers(env, triggers).queue(batch),
};
```

The job writes its result back with `serverWrite`, and every member's
phone pulls it like any other change:

```ts
import { serverWrite } from "@sync/server/spaces";

await serverWrite(env, spaceId, [
  { c: "songs", d: songId, f: "sheet", v: sheet },
  { c: "songs", d: songId, f: "status", v: "ready" },
]);
```

What to rely on:

- **Every change, at least once.** Reports survive a failed send, so there's
  no sweep to write. A trigger can still see a change twice (a retried
  batch), so make it safe to repeat: act on a state (`queued`), and key any
  job by the document and its `_t`.
- **The document as it is now.** A trigger gets the merged document, not
  each edit along the way; quick edits may arrive as one call. `doc` is
  null once the document has been deleted. It runs about a second after
  the change (the batch timeout).
- **The server's writes count too.** That's how "ready" can go on to send a
  push. `fields` and the state check keep a trigger from re-running on its
  own writes.
- **Failures retry.** A trigger that throws retries its batch (then goes to
  the dead-letter queue); the space's other changes aren't held up.
- **`serverWrite` lands last.** Each document's writes are stamped after the
  newest timestamp already in it, so a phone whose clock runs ahead can't
  quietly win over the server's result.

Security:

- `serverWrite` writes as the server and skips the membership check. Take
  the space id from a trigger or your own records, never from a request.
- Fields the server writes are yours by convention only: a member can set
  `status: "ready"` in their own space. Keep anything that costs money or
  grants access (credits, entitlements) in D1, not in the space.
- Triggers spend money on what users typed. Cap work per space before
  starting a job, and check a URL's host before fetching it.
- Queue messages carry only the space id and a version range, never
  document data.

Leave `SYNC_TRIGGERS` unbound and spaces report nothing. A space starts
reporting from its first change after the binding appears, never its
history. The example Worker (`example/`) files grocery items under an aisle
this way.

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
