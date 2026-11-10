# Flare

An app backend on Cloudflare: offline-first sync (a Rust core with Swift and
Kotlin on top, and a Durable Object server), plus auth, flags, push, links,
telemetry and support packages. README.md maps each folder to its doc.

Checks: `cargo test` and `cargo clippy --all-targets` for Rust; `pnpm test`
and `pnpm typecheck` in each TypeScript package you change. `swift test` and
`./gradlew :sync:assembleRelease` need a Mac.

Rules:

- This repo is public. Keep it general: no private infrastructure, account
  ids, secret-store names, or names of the apps that use it.
- `server/` has no npm dependencies. Keep it that way.
- Apps download the Rust store prebuilt. After a Rust change, run
  `scripts/publish-binaries.sh` on a Mac and commit what it rewrites, or apps
  keep the old store.
- Apps pin a tag, and phones in the field keep running older ones. A change
  to the wire format (PROTOCOL.md) has to keep them working.
- Releasing is a git tag (SYNC.md, "Releasing"). Move the version pins in
  README.md, PROTOCOL.md and LINKS.md to the new tag.
