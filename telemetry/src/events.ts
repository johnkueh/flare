// events.json: the event list one product shares across its web pages, its
// Worker and its phone apps, so every platform sends the same names.
//
//   {
//     "events": {
//       "statement_extracted": { "description": "…", "params": { "pages": 0, "bank": "" } }
//     }
//   }
//
// A param's type comes from its example value, like a flag's from its
// default: a number, `true`/`false`, or text. The TS senders are typed from
// the imported file, with no code generation.

/** One event in events.json. */
export interface EventDef {
  readonly description?: string;
  /** Param name -> an example value, which sets its type. */
  readonly params?: { readonly [param: string]: string | number | boolean };
}

/** The parsed events.json: `import events from "./events.json"`. */
export interface EventsFile {
  readonly events: { readonly [name: string]: EventDef };
}

/** Events every sender may send without declaring them. */
export type BuiltInEvent = "first_open" | "session_start" | "page_view" | "error";
export const BUILT_IN_EVENTS: readonly BuiltInEvent[] = ["first_open", "session_start", "page_view", "error"];

type Widen<V> = V extends number ? number : V extends boolean ? boolean : string;

export type EventName<E extends EventsFile> = Extract<keyof E["events"], string> | BuiltInEvent;
export type EventParams<E extends EventsFile, K extends string> = string extends keyof E["events"]
  ? Params
  : K extends keyof E["events"]
  ? E["events"][K]["params"] extends infer P
    ? P extends Record<string, string | number | boolean>
      ? { [Q in keyof P]?: Widen<P[Q]> }
      : Record<string, never>
    : never
  : Params;

/** An event's params on the wire: JSON values (undefined ones are dropped). */
export type Params = { [key: string]: unknown };

/** Without an events.json, any snake_case name and params. */
export type AnyEvents = { readonly events: { readonly [name: string]: EventDef } };

/** Event names and param keys, the same rule as the Worker and the Rust SDK. */
export const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** The problems in an events.json, as readable lines (empty: it's fine). */
export function checkEvents(file: unknown): string[] {
  const problems: string[] = [];
  if (typeof file !== "object" || file === null || typeof (file as EventsFile).events !== "object") {
    return ['events.json needs an "events" object'];
  }
  for (const [name, def] of Object.entries((file as EventsFile).events)) {
    if (!NAME.test(name)) problems.push(`${name}: event names are snake_case, 1 to 64 chars`);
    if ((BUILT_IN_EVENTS as readonly string[]).includes(name)) problems.push(`${name}: sent for you, don't declare it`);
    if (typeof def !== "object" || def === null) {
      problems.push(`${name}: needs an object`);
      continue;
    }
    for (const [param, example] of Object.entries(def.params ?? {})) {
      if (!NAME.test(param)) problems.push(`${name}.${param}: param names are snake_case, 1 to 64 chars`);
      if (!["string", "number", "boolean"].includes(typeof example)) {
        problems.push(`${name}.${param}: the example value is a number, true/false or text`);
      }
    }
  }
  return problems;
}

/** Event ids in the same shape as the Rust SDK's: base-36 millis, "_", 10 random base-36 chars. */
export function eventId(now = Date.now()): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const b of bytes) suffix += (b % 36).toString(36);
  return `${now.toString(36)}_${suffix}`;
}

/** A random 128-bit id as 32 hex chars, like the SDK's install and session ids. */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** One event as the Worker reads it. */
export interface WireEvent {
  name: string;
  event_id: string;
  ts: number;
  session_id?: string | null;
  user_id?: string | null;
  params?: Params;
}

/** The batch every sender posts to /v1/events. */
export interface WireBatch {
  context: {
    app_id: string;
    env: string;
    platform: string;
    install_id: string;
    app_version?: string | null;
    app_build?: string | null;
    os_version?: string | null;
    device_model?: string | null;
    locale?: string | null;
    country?: string | null;
    sdk?: string | null;
  };
  sent_at: number;
  events: WireEvent[];
}

/** Drops undefined params, so JSON stays small and the Worker sees only real values. */
export function cleanParams(params: Params | undefined): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

/** The cookie the browser sender keeps its ids in, so server events join the same session. */
export const IDS_COOKIE = "flare_ids";
