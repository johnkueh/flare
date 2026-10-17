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
export const BUILT_IN_EVENTS = ["first_open", "session_start", "page_view", "error"];
/** Event names and param keys, the same rule as the Worker and the Rust SDK. */
export const NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** The problems in an events.json, as readable lines (empty: it's fine). */
export function checkEvents(file) {
    const problems = [];
    if (typeof file !== "object" || file === null || typeof file.events !== "object") {
        return ['events.json needs an "events" object'];
    }
    for (const [name, def] of Object.entries(file.events)) {
        if (!NAME.test(name))
            problems.push(`${name}: event names are snake_case, 1 to 64 chars`);
        if (BUILT_IN_EVENTS.includes(name))
            problems.push(`${name}: sent for you, don't declare it`);
        if (typeof def !== "object" || def === null) {
            problems.push(`${name}: needs an object`);
            continue;
        }
        for (const [param, example] of Object.entries(def.params ?? {})) {
            if (!NAME.test(param))
                problems.push(`${name}.${param}: param names are snake_case, 1 to 64 chars`);
            if (!["string", "number", "boolean"].includes(typeof example)) {
                problems.push(`${name}.${param}: the example value is a number, true/false or text`);
            }
        }
    }
    return problems;
}
/** Event ids in the same shape as the Rust SDK's: base-36 millis, "_", 10 random base-36 chars. */
export function eventId(now = Date.now()) {
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    let suffix = "";
    for (const b of bytes)
        suffix += (b % 36).toString(36);
    return `${now.toString(36)}_${suffix}`;
}
/** A random 128-bit id as 32 hex chars, like the SDK's install and session ids. */
export function randomId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
/** Drops undefined params, so JSON stays small and the Worker sees only real values. */
export function cleanParams(params) {
    const out = {};
    for (const [k, v] of Object.entries(params ?? {}))
        if (v !== undefined)
            out[k] = v;
    return out;
}
/** The cookie the browser sender keeps its ids in, so server events join the same session. */
export const IDS_COOKIE = "flare_ids";
