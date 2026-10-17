import assert from "node:assert/strict";
import { test } from "node:test";

import { problemParams } from "./problems.ts";

const ios = (offset: number) => ({
  type: "EXC_BAD_ACCESS SIGSEGV",
  message: "",
  frames: [
    { module: "libsystem_kernel.dylib", offset: 4660, in_app: false },
    { module: "GLP3", offset, image_id: "A1B2", in_app: true },
    { module: "GLP3", offset: 512, in_app: true },
  ],
  fingerprint: "from-the-phone",
});

test("groups on the top in-app frames, ignoring the message", () => {
  const a = problemParams("crash", { ...ios(256), message: "a" });
  const b = problemParams("crash", { ...ios(256), message: "b" });
  const c = problemParams("crash", ios(1024));
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
  assert.notEqual(a.fingerprint, "from-the-phone");
  assert.notEqual(problemParams("hang", ios(256)).fingerprint, a.fingerprint);
  assert.equal(a.title, "EXC_BAD_ACCESS SIGSEGV at GLP3+0x100");
});

test("prefers symbols, then a panic site; trims frames and breadcrumbs", () => {
  const jvm = problemParams("crash", {
    type: "java.lang.IllegalStateException",
    frames: [{ module: "com.glp3", function: "com.glp3.DoseStore.save", file_line: "DoseStore.kt:42", in_app: true }],
  });
  assert.equal(jvm.title, "java.lang.IllegalStateException at com.glp3.DoseStore.save");
  const panic = problemParams("error", { type: "rust_panic", frames: [{ module: "rust", file_line: "src/sync.rs:10", in_app: true }] });
  assert.equal(panic.title, "rust_panic at src/sync.rs:10");
  const big = problemParams("crash", { frames: Array(80).fill({ module: "X", in_app: false }), breadcrumbs: Array(50).fill({}) });
  assert.equal((big.frames as unknown[]).length, 30);
  assert.equal((big.breadcrumbs as unknown[]).length, 30);
  assert.equal(big.type, "unknown");
  assert.equal(problemParams("crash", {}).title, "unknown");
});
