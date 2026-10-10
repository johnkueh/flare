<p align="center"><img src="docs/flare.png" alt="Flare" width="640"></p>

# Flare

**Your apps' backend, on Cloudflare.** Like Firebase, but it's your own
Worker: phones work offline, share data with each other, and catch up the
moment they're back online.

Sync is the first piece. Auth comes next.

## What you get

- **Offline first.** Every phone keeps a full local copy in SQLite and
  writes instantly. Sync happens in the background.
- **Shared spaces.** Phones join a space (a household, a team) with an
  8‑letter invite code. No accounts, no passwords.
- **Merges that make sense.** Two people edit at once and nothing gets lost:
  newest edit wins per field, lists keep their order, sets and counters
  merge.
- **iOS, Android and the web.** One Rust core, with Swift and Kotlin on top.
  Web pages read and write through your Worker.
- **Cheap to run.** One Durable Object per space, photos in R2. Nothing to
  babysit.

## Add it

**Worker**

```sh
pnpm add "@sync/server@github:johnkueh/flare#0.1.0&path:/server"
```

```ts
export { SpaceObject } from "@sync/server/space";
```

**iOS**: add the package `https://github.com/johnkueh/flare` and link
`SyncKit` and `SyncClient`.

**Android**

```kotlin
// settings.gradle.kts
maven("https://jitpack.io")
maven("https://pub-796846793f3e431ab3a92e0577c57dde.r2.dev/maven")

// app/build.gradle.kts
implementation("com.github.johnkueh:flare:0.1.0")
```

Then describe your data in one JSON file and open the store:

```swift
let store = try SyncStore.open(path: dbPath, schemaJson: schema)
try store.putDoc(collection: "groceries", doc: id, fieldsJson: #"{"name":"Milk"}"#)
```

## Learn more

- [SYNC.md](SYNC.md): setup in full, the data model, web pages, releasing
- [PROTOCOL.md](PROTOCOL.md): the wire format, for anyone writing a client
