import assert from "node:assert/strict";
import { test } from "node:test";

import { toRows } from "./rows.ts";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const batch = (over: Record<string, unknown> = {}) => ({
  context: { app_id: "glp3", env: "prod", platform: "ios", install_id: "abc", app_version: "2.0", sdk: "telemetry-sdk/0.1.0" },
  sent_at: NOW - 60_000, // phone clock one minute slow
  events: [
    { event_id: "e1", name: "dose_logged", ts: NOW - 120_000, session_id: "s1", user_id: "u1", params: { mg: 2.5 } },
    { event_id: "e2", name: "Bad Name", ts: NOW },
    "junk",
  ],
  ...over,
});

test("maps good events, skips bad ones, corrects clock skew", () => {
  const rows = toRows(batch(), "glp3", NOW, "AU");
  if (typeof rows === "string") throw new Error(rows);
  assert.equal(rows.length, 1);
  const [r] = rows;
  assert.equal(r.name, "dose_logged");
  assert.equal(r.client_ts, "2026-10-14T09:59:00.000Z");
  assert.equal(r.received_at, "2026-10-14T10:00:00.000Z");
  assert.deepEqual(r.params, { mg: 2.5 });
  assert.equal(r.country, "AU");
  assert.equal(r.app_version, "2.0");
  assert.equal(r.locale, null);
});

test("ignores a wildly wrong clock", () => {
  const rows = toRows(batch({ sent_at: 0 }), "glp3", NOW, null);
  if (typeof rows === "string") throw new Error(rows);
  assert.equal(rows[0].client_ts, "2026-10-14T10:00:00.000Z");
});

test("rejects batches that can never be valid", () => {
  assert.equal(typeof toRows({}, "glp3", NOW, null), "string");
  assert.equal(toRows(batch(), "other", NOW, null), "app_id does not match the app key");
  assert.equal(typeof toRows(batch({ events: Array(501).fill({}) }), "glp3", NOW, null), "string");
});
