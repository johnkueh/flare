// Reading and writing a space as plain documents, for members that keep no
// store of their own (a web page behind SyncGateway). Phones use sync-core,
// which is the reference for these rules (PROTOCOL.md, "Entries").

import type { Json, Op } from "./space";

/** A live document: its id, its single-entry fields (value, position,
 *  parent, blob), and `_t`, the newest timestamp in it. Writes that pass
 *  `_t` back as `after` land after everything the reader saw. Set and
 *  counter fields (entries with a non-empty `s`) are left out. */
export type Doc = { id: string; _t: string; [field: string]: Json };

/** One change from a web member: set a field, or delete the document. */
export type Write =
  | { c: string; d: string; f: string; v: Json; after?: string }
  | { c: string; d: string; delete: true; after?: string };

/** The live documents of one collection, sorted by `orderBy` and then id. */
export function foldDocs(ops: Op[], collection: string, orderBy?: string): Doc[] {
  const docs = new Map<string, { fields: Record<string, Json>; t: string; del: { v: boolean; t: string } | null }>();
  for (const op of ops) {
    if (op.c !== collection) continue;
    let doc = docs.get(op.d);
    if (!doc) docs.set(op.d, (doc = { fields: {}, t: "", del: null }));
    if (op.f === "_del") {
      doc.del = { v: op.v === true, t: op.t };
    } else {
      if (op.t > doc.t) doc.t = op.t;
      if (op.s === "" && op.v !== null) doc.fields[op.f] = op.v;
    }
  }
  const live: Doc[] = [];
  for (const [id, doc] of docs) {
    // Deleted while `_del` is true and newer than every other entry.
    if (doc.del?.v && doc.del.t > doc.t) continue;
    const t = doc.del && doc.del.t > doc.t ? doc.del.t : doc.t;
    live.push({ ...doc.fields, id, _t: t });
  }
  return live.sort((a, b) => {
    if (orderBy) {
      const x = a[orderBy] ?? null;
      const y = b[orderBy] ?? null;
      if (x !== y) {
        if (x === null) return -1;
        if (y === null) return 1;
        if (x < y) return -1;
        if (x > y) return 1;
      }
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** `MS-COUNTER-NODE` (PROTOCOL.md, "Timestamps"). */
export function timestamp(ms: number, counter: number, node: string): string {
  return `${String(ms).padStart(15, "0")}-${counter.toString(16).padStart(4, "0")}-${node}`;
}

/** Turns writes into ops stamped by this member's node. Each lands at
 *  `now`, or just after its `after` when that is later (a phone's clock
 *  ahead of ours), so a write always beats what the writer was looking at. */
export function stampWrites(writes: Write[], node: string, now: number): Op[] {
  let floor = now;
  for (const w of writes) {
    const ms = w.after ? Number(w.after.slice(0, 15)) : 0;
    if (Number.isFinite(ms) && ms + 1 > floor) floor = ms + 1;
  }
  return writes.map((w, i) => {
    const t = timestamp(floor, i, node);
    return "delete" in w
      ? { c: w.c, d: w.d, f: "_del", s: "", v: true, t }
      : { c: w.c, d: w.d, f: w.f, s: "", v: w.v, t };
  });
}

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function isKey(s: string): boolean {
  return s.length > 0 && [...s].every((ch) => DIGITS.includes(ch)) && !s.endsWith("0");
}

/** A position that sorts between `before` and `after` (either may be
 *  missing). Port of sync-core's `position_between`: same keys, same
 *  results. */
export function positionBetween(before?: string | null, after?: string | null): string {
  const a = before && isKey(before) ? before : "";
  const b = after && isKey(after) && after > a ? after : null;
  return midpoint(a, b);
}

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while (n < b.length && (a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(n < a.length ? a.slice(n) : "", b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.ceil((da + db) / 2)];
  if (b !== null && b.length > 1) return b[0];
  return DIGITS[da] + midpoint(a.length > 1 ? a.slice(1) : "", null);
}
