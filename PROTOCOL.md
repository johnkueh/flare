# Sync protocol

The wire contract between `sync-core` (on each phone) and the space
Durable Object (`server/`). Both halves implement exactly this; the
convergence tests in `crates/sync-core/tests` model the server from it.

A **space** is what an app calls a household: a shared set of documents and
the devices allowed to read and write it. The protocol knows nothing about
any app's data. It moves **entries**, and every merge is one rule:

> At each entry path, the write with the larger timestamp wins.

Field types (value, set, counter, position, parent, blob) are a reading of
entries on the phone; the server only ever compares timestamps.

## Entries and ops

An entry path is `(collection, doc, field, sub)`. An op writes one entry:

```json
{ "c": "groceries", "d": "01J9…", "f": "done", "s": "", "v": true, "t": "001760000000000-0000-0123456789abcdef" }
```

| Key | Meaning | Rules |
| --- | --- | --- |
| `c` | collection | 1–64 chars of `A-Z a-z 0-9 _ . : -` |
| `d` | document id | 1–128 chars, same alphabet |
| `f` | field | 1–64 chars, same alphabet. Names starting `_` are reserved; only `_del` exists |
| `s` | sub-key | 0–256 chars, any text. `""` for plain fields; the member of a set; the device of a counter |
| `v` | value | any JSON, at most 64 KiB serialised. `null` is a value, not a delete |
| `t` | timestamp | hybrid logical clock string, below |
| `k` | kind (optional) | only `"parent"`; asks the server to refuse loops (below) |

How the phone reads entries back:

| Field type | Entries | Read as |
| --- | --- | --- |
| value, position, blob | one, `s = ""` | its `v` |
| parent | one, `s = ""`, `k = "parent"` | its `v` (a doc id in the same collection, or `null`) |
| set | one per member, `s = member`, `v = true/false` | members whose `v` is `true` |
| counter | one per device, `s = device`, `v = that device's running total` | sum of all `v` |
| (deletion) | `f = "_del"`, `s = ""`, `v = true/false` | deleted while `_del` is `true` **and** its `t` is larger than every other entry's `t` in the doc |

So an edit made after a delete brings the document back.

## Timestamps

`t` is a hybrid logical clock, fixed width so plain string comparison orders
it:

```
MMMMMMMMMMMMMMM-CCCC-NNNNNNNNNNNNNNNN
```

* `M`: 15 decimal digits, wall-clock milliseconds since the Unix epoch.
* `C`: 4 lowercase hex digits, a counter for writes in the same millisecond.
* `N`: 16 lowercase hex digits, the writing device's node id (random, per
  install). It makes every timestamp unique.

A phone never issues a timestamp at or below one it has seen. Its wall clock
is corrected by the server's (`time` in every response), so a phone whose
clock is wrong still orders edits by when they were made.

The zero timestamp `000000000000000-0000-0000000000000000` is smaller than
any real one.

## Requests

All under `/v1`, every request signed (App Attest, Android key attestation,
or the attestation bearer token). The signing key's id is the **device id**.
`time` in every response is the server's clock in milliseconds.

### `POST /spaces` — create

`{ "name": "John's household", "deviceName": "John", "platform": "ios" }` →
`Info` (below). The caller becomes the owner. `platform` is `ios`,
`android` or `other`; names are 1–60 chars.

### `GET /invites/{code}` — preview

→ `{ "spaceId", "name", "devices": 2, "collections": { "notes": 52 }, "time" }`
where `collections` counts documents that aren't deleted. Unknown or reset
code: `404 NOT_FOUND`. Joins nothing.

### `POST /spaces/{spaceId}/join`

`{ "code": "7KQ2M9XD", "deviceName": "Mia", "platform": "android" }` → `Info`.
The code must be the space's current one (`404 NOT_FOUND` otherwise). Already
a member: same `Info`, nothing changes. 12 active devices already:
`409 FULL`. Devices not seen for 180 days are dropped before counting.

### `GET /spaces/{spaceId}` — info

→ `Info`:

```json
{ "spaceId": "…", "name": "John's household", "code": "7KQ2M9XD", "owner": "<device id>",
  "you": "<device id>", "version": 214, "time": 1760000000000,
  "devices": [{ "id": "…", "name": "John", "platform": "ios", "joinedAt": 0, "lastSeen": 0 }] }
```

Not a member (never joined, left, or removed): `403 NOT_MEMBER`. Every
member request updates `lastSeen`.

### `POST /spaces/{spaceId}/leave`

→ `{ "time" }`. If the owner leaves, the device that joined earliest becomes
owner. When the last device leaves, the space's data is deleted 30 days
later unless someone joins with the code before then.

### `POST /spaces/{spaceId}/devices/{deviceId}/remove`

Owner only (`403 NOT_OWNER`). → `{ "time" }`. The removed device gets
`403 NOT_MEMBER` from then on; it can rejoin only with a current code.

### `POST /spaces/{spaceId}/code/reset`

Owner only. → `{ "code", "time" }`. The old code stops working at once.

### `POST /spaces/{spaceId}/push`

`{ "ops": [Op, …] }`, at most 500 → `{ "version", "time", "corrections": [Op] }`.

The server applies each op with the merge rule. An op it refuses is not an
error: it answers with a **correction**, the server's current entry at that
path (an op with the zero timestamp and `v: null` if there is none). The
phone overwrites its own entry with each correction regardless of
timestamps. Refused ops:

* `k: "parent"` where following `v`'s parents (same `c` and `f`, `s = ""`)
  reaches `d` itself: a loop.
* `t` more than 10 minutes ahead of the server's clock.

A malformed op fails the whole request with `400 INVALID_OPS` and applies
nothing.

### `GET /spaces/{spaceId}/changes?since=N&limit=L`

→ `{ "ops": [Op], "version", "more", "reset", "time" }`.

Every entry the server stores carries the version at which it last changed;
each accepted write takes the next version. This returns entries with
version > `since`, oldest first, at most `L` (default and maximum 1000).
`version` is the version of the last op returned, or the current version when
there are none; the phone stores it as its next `since`. `more` says another
page is waiting. If `since` is ahead of the server (the space was rebuilt),
the server answers from 0 with `reset: true`, and the phone replaces its copy.

### `GET /spaces/{spaceId}/live` — WebSocket

Authorised with the bearer token. The server sends `{"version": N}` after
every push that changed something. Clients pull when it is ahead of their
cursor. Nothing else is sent either way.

### `PUT /spaces/{spaceId}/blobs/{sha256}` and `GET` — files

A file (a photo) is stored under the lowercase hex SHA-256 of its
bytes, which is what a `blob` field holds. The body is the raw bytes, at
most 1,900,000, with their `Content-Type`; the server checks the hash.
Uploading a file it already has is fine. `GET` returns the bytes to any
member. Files stay until the space is deleted.

Upload the file before (or soon after) pushing the op that names it; a
member that reads the hash first gets `404` and tries again later.

## Invite codes

8 characters from Crockford's base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`
(no I, L, O, U), shown as `7KQ2-M9XD`, shared as a link to the app's own join page (`https://example.com/j/7KQ2-M9XD`).
Reading one: take the last path segment of a URL or the whole text, drop
spaces and dashes, uppercase, read `O` as `0` and `I`/`L` as `1`; it must then
be 8 alphabet characters.

## Errors

oRPC error codes: `NOT_FOUND` (404), `NOT_MEMBER` (403), `NOT_OWNER` (403),
`FULL` (409), `INVALID_OPS` (400), plus the attestation errors the import API
already uses.
