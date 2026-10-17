import assert from "node:assert/strict";
import { test } from "node:test";

import { checkEvents, eventId, randomId } from "./events.ts";

test("checkEvents passes a good file and names each problem in a bad one", () => {
  assert.deepEqual(checkEvents({ events: { csv_exported: { params: { rows: 0, view: "", filtered: false } } } }), []);
  assert.deepEqual(checkEvents({}), ['events.json needs an "events" object']);
  const problems = checkEvents({
    events: { "CSV Exported": {}, page_view: {}, ok: { params: { BadKey: 1, list: [1] } } },
  });
  assert.equal(problems.length, 4);
  assert.match(problems[0], /CSV Exported: event names are snake_case/);
  assert.match(problems[1], /page_view: sent for you/);
  assert.match(problems[2], /ok.BadKey: param names/);
  assert.match(problems[3], /ok.list: the example value/);
});

test("ids look like the Rust SDK's", () => {
  assert.match(eventId(1_760_000_000_000), /^[0-9a-z]+_[0-9a-z]{10}$/);
  assert.equal(eventId(1_760_000_000_000).split("_")[0], (1_760_000_000_000).toString(36));
  assert.match(randomId(), /^[0-9a-f]{32}$/);
  assert.notEqual(randomId(), randomId());
});
