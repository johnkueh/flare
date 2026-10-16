// flags.json and the wire format, shared by the Worker and the client.
// The Rust core (crates/flags) follows the same rules; keep them in step.

/** One flag in flags.json. Its type comes from `default`. */
export interface FlagDef {
  /** The value until the server says otherwise, and whenever it can't. */
  readonly default: unknown;
  /** Change at once, even on screen (kill switches). Default: false. */
  readonly live?: boolean;
  readonly description?: string;
  /** Only to say "number" for a whole-number default that may get a fraction. */
  readonly type?: "boolean" | "integer" | "number" | "string" | "object" | string;
}

/** The parsed flags.json: `import flags from "./flags.json"`. */
export interface FlagsFile {
  readonly flags: { readonly [key: string]: FlagDef };
}

export type FlagKey<F extends FlagsFile> = Extract<keyof F["flags"], string>;
export type FlagValue<F extends FlagsFile, K extends FlagKey<F>> = F["flags"][K]["default"];
export type FlagValues<F extends FlagsFile> = { [K in FlagKey<F>]: FlagValue<F, K> };

export type Kind = "boolean" | "integer" | "number" | "string" | "object";

/** Flagship's limit on keys, and what the generated Swift/Kotlin can name. */
export const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function kindOf(key: string, def: FlagDef): Kind {
  if (!KEY.test(key)) {
    throw new Error(`flags.json: ${JSON.stringify(key)}: keys start with a letter and use letters, digits, - and _ (64 at most)`);
  }
  if (!def || !("default" in def)) throw new Error(`flags.json: ${key}: needs a "default"`);
  const d = def.default;
  let kind: Kind;
  if (def.type !== undefined) {
    if (!["boolean", "integer", "number", "string", "object"].includes(def.type)) {
      throw new Error(`flags.json: ${key}: unknown type ${JSON.stringify(def.type)}`);
    }
    kind = def.type as Kind;
  } else if (typeof d === "boolean") kind = "boolean";
  else if (typeof d === "number") kind = Number.isInteger(d) ? "integer" : "number";
  else if (typeof d === "string") kind = "string";
  else if (d !== null && typeof d === "object") kind = "object";
  else throw new Error(`flags.json: ${key}: the default can't be ${d === null ? "null" : typeof d}`);
  if (!accepts(kind, d)) throw new Error(`flags.json: ${key}: the default doesn't match its type`);
  return kind;
}

export function accepts(kind: Kind, v: unknown): boolean {
  switch (kind) {
    case "boolean":
      return typeof v === "boolean";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "string":
      return typeof v === "string";
    case "object":
      return v !== null && typeof v === "object";
    default:
      return false;
  }
}

/** Every flag's kind, checking flags.json on the way. */
export function kinds(file: FlagsFile): Map<string, Kind> {
  if (!file || typeof file.flags !== "object" || file.flags === null) {
    throw new Error('flags.json: expected {"flags": {...}}');
  }
  return new Map(Object.entries(file.flags).map(([k, def]) => [k, kindOf(k, def)]));
}

// The wire: OpenFeature Remote Evaluation Protocol (OFREP), bulk form.
//   POST {prefix}/ofrep/v1/evaluate/flags   {"context": {"targetingKey": "...", ...}}
//   200 {"flags": [{key, value, reason, variant} | {key, errorCode, errorDetails}]}, ETag
//   304 when If-None-Match matches

export const PATH = "/ofrep/v1/evaluate/flags";

export type ContextValue = string | number | boolean;
export type EvaluationContext = { targetingKey?: string } & Record<string, ContextValue | undefined>;

export interface FlagResult {
  key: string;
  value?: unknown;
  reason?: string;
  variant?: string;
  errorCode?: string;
  errorDetails?: string;
}

export interface BulkResponse {
  flags: FlagResult[];
}
