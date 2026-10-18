import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatFrames,
  frameAddress,
  javaFrame,
  machOSlices,
  normalizeUuid,
  parseAtosLine,
  parseMapping,
  parseSymbolizerJson,
  retraceFrame,
} from "./symbols.ts";

/** A minimal 64-bit Mach-O: header, LC_SEGMENT_64 __TEXT, LC_UUID. */
function thinMachO(cputype: number, uuidHex: string, vmaddr: bigint): Uint8Array {
  const bytes = new Uint8Array(32 + 72 + 24);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, 0xfeedfacf, true);
  v.setUint32(4, cputype, true);
  v.setUint32(16, 2, true); // ncmds
  let at = 32;
  v.setUint32(at, 0x19, true);
  v.setUint32(at + 4, 72, true);
  bytes.set(new TextEncoder().encode("__TEXT"), at + 8);
  v.setBigUint64(at + 24, vmaddr, true);
  at += 72;
  v.setUint32(at, 0x1b, true);
  v.setUint32(at + 4, 24, true);
  for (let i = 0; i < 16; i++) bytes[at + 8 + i] = Number.parseInt(uuidHex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function fat(slices: { cputype: number; bytes: Uint8Array }[]): Uint8Array {
  const header = 8 + slices.length * 20;
  const offsets: number[] = [];
  let size = 4096;
  for (const s of slices) {
    offsets.push(size);
    size += Math.ceil(s.bytes.length / 4096) * 4096;
  }
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0xcafebabe, false);
  v.setUint32(4, slices.length, false);
  slices.forEach((s, i) => {
    const e = 8 + i * 20;
    v.setUint32(e, s.cputype, false);
    v.setUint32(e + 8, offsets[i], false);
    v.setUint32(e + 12, s.bytes.length, false);
    out.set(s.bytes, offsets[i]);
  });
  assert.ok(header < 4096);
  return out;
}

const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;

test("reads the UUID and __TEXT address of a thin Mach-O", () => {
  const slices = machOSlices(thinMachO(ARM64, "4c4c444a55553144a196e1f1421c5e16", 0x100000000n));
  assert.deepEqual(slices, [{ arch: "arm64", uuid: "4C4C444A-5555-3144-A196-E1F1421C5E16", textVmaddr: 0x100000000n }]);
});

test("reads every slice of a fat file", () => {
  const file = fat([
    { cputype: X86_64, bytes: thinMachO(X86_64, "4c4c448355553144a1c6819e4e6eee0d", 0x100000000n) },
    { cputype: ARM64, bytes: thinMachO(ARM64, "4c4c444a55553144a196e1f1421c5e16", 0n) },
  ]);
  assert.deepEqual(
    machOSlices(file).map((s) => `${s.arch} ${s.uuid} ${s.textVmaddr}`),
    ["x86_64 4C4C4483-5555-3144-A1C6-819E4E6EEE0D 4294967296", "arm64 4C4C444A-5555-3144-A196-E1F1421C5E16 0"],
  );
});

test("anything else is not a Mach-O", () => {
  assert.deepEqual(machOSlices(new TextEncoder().encode("com.example.Foo -> a.a:\n".repeat(4))), []);
  assert.deepEqual(machOSlices(new Uint8Array(4)), []);
});

test("UUIDs compare in one shape", () => {
  assert.equal(normalizeUuid("4c4c444a55553144a196e1f1421c5e16"), "4C4C444A-5555-3144-A196-E1F1421C5E16");
  assert.equal(normalizeUuid("4C4C444A-5555-3144-A196-E1F1421C5E16"), "4C4C444A-5555-3144-A196-E1F1421C5E16");
  assert.equal(normalizeUuid("nope"), null);
});

test("frame addresses step back into the call for return addresses", () => {
  const slice = { arch: "arm64", uuid: "x", textVmaddr: 0x100000000n };
  assert.equal(frameAddress(slice, 0x2f0, false), "0x1000002f0");
  assert.equal(frameAddress(slice, 0x2f0, true), "0x1000002ef");
});

const MAPPING = `# compiler: R8
# compiler_version: 8.5.35
# pg_map_id: 3f2a1b9
com.example.recipes.RecipeStore -> a.b:
# {"id":"sourceFile","fileName":"RecipeStore.kt"}
    java.util.List items -> a
    1:3:void save(com.example.recipes.Recipe):40:42 -> c
    4:4:void com.example.recipes.Validate.check(java.lang.String):12:12 -> c
    4:4:void save(com.example.recipes.Recipe):43 -> c
    5:9:void load():60:64 -> d
    void clear() -> e
    void reset() -> e
com.example.recipes.MainActivity -> com.example.recipes.MainActivity:
    1:1:void onCreate(android.os.Bundle):20:20 -> onCreate
`;

test("retraces a renamed method and maps its line", () => {
  const m = parseMapping(MAPPING);
  assert.deepEqual(retraceFrame(m, { className: "a.b", method: "c", file: "SourceFile", line: 2 }), [
    { className: "com.example.recipes.RecipeStore", method: "save", file: "RecipeStore.kt", line: 41 },
  ]);
  assert.deepEqual(retraceFrame(m, { className: "a.b", method: "d", file: "SourceFile", line: 9 }), [
    { className: "com.example.recipes.RecipeStore", method: "load", file: "RecipeStore.kt", line: 64 },
  ]);
});

test("expands an inlined call, innermost first", () => {
  const m = parseMapping(MAPPING);
  assert.deepEqual(retraceFrame(m, { className: "a.b", method: "c", file: "SourceFile", line: 4 }), [
    { className: "com.example.recipes.Validate", method: "check", file: "Validate.java", line: 12 },
    { className: "com.example.recipes.RecipeStore", method: "save", file: "RecipeStore.kt", line: 43 },
  ]);
});

// Real R8 8.5.35 output: normalize() inlined into save(); the official
// Retrace tool turns `a.a.a(SourceFile:2)` into normalize:13 then save:8.
const R8_OUTPUT = `# compiler: R8
# compiler_version: 8.5.35
# common_typos_disable
# {"id":"com.android.tools.r8.mapping","version":"2.2"}
# pg_map_id: facf833
# pg_map_hash: SHA-256 facf833cc210b22f5bddb5b7c1fd1dfb595c45cd04b4585d3ef6b7a0bfbfbaa9
com.example.recipes.Main -> com.example.recipes.Main:
# {"id":"sourceFile","fileName":"Main.java"}
    1:1:void main(java.lang.String[]):5:5 -> main
com.example.recipes.RecipeStore -> a.a:
# {"id":"sourceFile","fileName":"RecipeStore.java"}
    int count -> a
    1:1:void <init>():0:0 -> <init>
    1:1:void save(java.lang.String):7:7 -> a
    2:3:java.lang.String normalize(java.lang.String):13:14 -> a
    2:3:void save(java.lang.String):8 -> a
    4:4:void save(java.lang.String):9:9 -> a
`;

test("matches R8's own Retrace on its output", () => {
  const m = parseMapping(R8_OUTPUT);
  assert.deepEqual(retraceFrame(m, { className: "a.a", method: "a", file: "SourceFile", line: 2 }), [
    { className: "com.example.recipes.RecipeStore", method: "normalize", file: "RecipeStore.java", line: 13 },
    { className: "com.example.recipes.RecipeStore", method: "save", file: "RecipeStore.java", line: 8 },
  ]);
  assert.deepEqual(retraceFrame(m, { className: "com.example.recipes.Main", method: "main", file: "SourceFile", line: 1 }), [
    { className: "com.example.recipes.Main", method: "main", file: "Main.java", line: 5 },
  ]);
});

test("without a line, says which methods it could be", () => {
  const m = parseMapping(MAPPING);
  assert.deepEqual(retraceFrame(m, { className: "a.b", method: "e", file: null, line: null }), [
    { className: "com.example.recipes.RecipeStore", method: "clear | reset", file: "RecipeStore.kt", line: null },
  ]);
});

test("leaves classes the mapping doesn't know alone", () => {
  const m = parseMapping(MAPPING);
  const frame = { className: "android.os.Handler", method: "dispatchMessage", file: "Handler.java", line: 106 };
  assert.deepEqual(retraceFrame(m, frame), [frame]);
});

test("splits the Kotlin layer's frames", () => {
  assert.deepEqual(javaFrame({ function: "a.b.c", file_line: "SourceFile:4" }), {
    className: "a.b",
    method: "c",
    file: "SourceFile",
    line: 4,
  });
  assert.deepEqual(javaFrame({ function: "a.b.c", file_line: "Unknown Source" }), {
    className: "a.b",
    method: "c",
    file: "Unknown Source",
    line: null,
  });
  assert.equal(javaFrame({ module: "Cooked", offset: 12 }), null);
});

test("reads atos output", () => {
  assert.deepEqual(parseAtosLine("RecipeStore.save(_:) (in Cooked) (RecipeStore.swift:88)"), {
    function: "RecipeStore.save(_:)",
    fileLine: "RecipeStore.swift:88",
  });
  assert.deepEqual(parseAtosLine("closure #1 in Foo.bar() (in Cooked) + 52"), { function: "closure #1 in Foo.bar()", fileLine: null });
  assert.deepEqual(parseAtosLine("specialized Array.subscript.getter (in Recipes) (<compiler-generated>:0)"), {
    function: "specialized Array.subscript.getter",
    fileLine: null,
  });
  assert.equal(parseAtosLine("0x1000002ef"), null);
  assert.equal(parseAtosLine("0x1000002ef (in Cooked)"), null);
  assert.equal(parseAtosLine(""), null);
});

test("reads llvm-symbolizer JSON, one list per address", () => {
  const out = JSON.stringify([
    {
      Address: "0x1000002f0",
      Symbol: [
        { FunctionName: "inner", FileName: "/src/demo.c", Line: 1 },
        { FunctionName: "save_recipe", FileName: "/src/demo.c", Line: 3 },
      ],
    },
    { Address: "0x100009999", Symbol: [{ FunctionName: "", FileName: "", Line: 0 }] },
  ]);
  assert.deepEqual(parseSymbolizerJson(out), [
    [
      { function: "inner", fileLine: "demo.c:1" },
      { function: "save_recipe", fileLine: "demo.c:3" },
    ],
    [],
  ]);
});

test("formats frames with inlined ones unnumbered", () => {
  const lines = formatFrames([
    { module: "Cooked", function: "inner", fileLine: "demo.c:1", inApp: true, inlined: true },
    { module: "Cooked", function: "save", fileLine: "demo.c:3", inApp: true },
    { module: "libsystem_c.dylib", function: null, fileLine: null, inApp: false, missing: "+0x10 (no dSYM for X)" },
  ]);
  assert.deepEqual(lines, [
    "   * Cooked             (inlined) inner  demo.c:1",
    " 0 * Cooked             save  demo.c:3",
    " 1   libsystem_c.dylib  +0x10 (no dSYM for X)",
  ]);
});
