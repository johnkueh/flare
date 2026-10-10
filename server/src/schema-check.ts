// Checks pushed ops against an app's schema (the `collections` of its
// schema file, see SYNC.md) and reports what
// doesn't fit. Nothing is refused: an old app writing an unexpected shape
// keeps syncing, and the log shows which app drifted from the shared list.

/** Collections → fields → how each merges and its value's JSON type. */
export type SyncSchema = Record<string, Record<string, FieldSpec>>;
type FieldSpec = { merge: string; type: string };
export type Mismatch = { c: string; f: string; why: string };

/** Ops the space would reject as malformed are skipped; it reports those
 *  itself. */
export function schemaMismatches(schema: SyncSchema, ops: unknown[]): Mismatch[] {
  const out: Mismatch[] = [];
  for (const raw of ops) {
    const op = raw as { c?: unknown; f?: unknown; v?: unknown };
    if (typeof op?.c !== "string" || typeof op.f !== "string" || op.f.startsWith("_")) continue;
    const fields = schema[op.c];
    const field = fields?.[op.f];
    const why = !fields ? "unknown collection" : !field ? "unknown field" : wrongValue(field, op.v);
    if (why) out.push({ c: op.c, f: op.f, why });
  }
  return out;
}

function wrongValue(field: FieldSpec, v: unknown): string | null {
  if (v === null) return null;
  // A set's entry says whether its member (the op's `s`) is in.
  const expected = field.merge === "set" ? "boolean" : field.merge === "counter" ? "number" : field.type;
  const actual = Array.isArray(v) ? "array" : typeof v;
  return actual === expected ? null : `${actual}, not ${expected}`;
}
