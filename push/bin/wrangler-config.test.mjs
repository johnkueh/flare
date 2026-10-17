import assert from "node:assert/strict";
import { test } from "node:test";
import { addTopLevel, addVar, maskComments, parseDevVars, parseJsonc } from "./wrangler-config.mjs";

const CONFIG = `{
  "name": "myapp", // the Worker
  /* bindings */
  "vars": {
    "A": "1", // trailing comment
  },
  "d1_databases": [{ "binding": "DB", "database_name": "myapp" }] // last
}
`;

test("masking keeps positions and strings", () => {
  const masked = maskComments(`{"url": "http://x//y", // c\n"b": 1 /* d */}`);
  assert.equal(masked.length, `{"url": "http://x//y", // c\n"b": 1 /* d */}`.length);
  assert.deepEqual(JSON.parse(masked), { url: "http://x//y", b: 1 });
});

test("adds a top-level key after the last member's comment, keeping the rest", () => {
  const out = addTopLevel(CONFIG, "queues", { producers: [{ binding: "PUSH_QUEUE", queue: "myapp-push" }] });
  assert.deepEqual(parseJsonc(out).queues, { producers: [{ binding: "PUSH_QUEUE", queue: "myapp-push" }] });
  assert.equal(parseJsonc(out).name, "myapp");
  assert.match(out, /\}\], \/\/ last\n  "queues": \{/);
  assert.ok(out.startsWith(CONFIG.slice(0, CONFIG.indexOf("\"d1_databases\""))));
  assert.throws(() => addTopLevel(out, "queues", {}), /already there/);
});

test("doesn't double a trailing comma", () => {
  const out = addTopLevel(`{\n  "name": "x",\n}\n`, "vars", { B: "2" });
  assert.deepEqual(parseJsonc(out), { name: "x", vars: { B: "2" } });
  assert.doesNotMatch(out, /,,/);
});

test("adds to vars, or adds vars", () => {
  const out = addVar(CONFIG, "APNS_TOPICS", "com.me.app");
  assert.deepEqual(parseJsonc(out).vars, { A: "1", APNS_TOPICS: "com.me.app" });
  assert.match(out, /"A": "1", \/\/ trailing comment\n    "APNS_TOPICS": "com.me.app"/);
  assert.throws(() => addVar(out, "APNS_TOPICS", "x"), /already set/);

  const fresh = addVar(`{ "name": "x" }`, "APNS_TOPICS", "com.me.app");
  assert.deepEqual(parseJsonc(fresh), { name: "x", vars: { APNS_TOPICS: "com.me.app" } });
});

test("ignores keys nested deeper than the top level", () => {
  const text = `{\n  "env": { "staging": { "vars": { "X": "1" } } }\n}`;
  const out = addVar(text, "APNS_TOPICS", "a");
  assert.deepEqual(parseJsonc(out).vars, { APNS_TOPICS: "a" });
  assert.deepEqual(parseJsonc(out).env.staging.vars, { X: "1" });
});

test(".dev.vars: plain, quoted, multi-line and escaped values", () => {
  const vars = parseDevVars(`A=plain # note
B="one\\ntwo"
C="-----BEGIN PRIVATE KEY-----
abc
-----END PRIVATE KEY-----"
D='{"x":"y"}'
`);
  assert.equal(vars.A, "plain");
  assert.equal(vars.B, "one\ntwo");
  assert.equal(vars.C, "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
  assert.equal(vars.D, '{"x":"y"}');
});
