// Crash, hang and error events get a `fingerprint` and a `title` here, so
// `GROUP BY params.fingerprint` gives one row per distinct problem. Done in
// the Worker rather than the SDK so the grouping rule can change without an
// app release; whatever the phone sent in those two fields is replaced.
export const PROBLEM_EVENTS = new Set(["crash", "hang", "error"]);
const MAX_FRAMES = 30;
const MAX_BREADCRUMBS = 30;
const GROUPING_FRAMES = 3;
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v) => (typeof v === "string" && v.length > 0 ? v : null);
// The most stable thing a frame has: a symbol, else file:line (a Rust panic
// site), else binary + offset (MetricKit, stable within one build).
function frameKey(f) {
    const fn = text(f.function) ?? text(f.file_line);
    if (fn)
        return fn;
    const module = text(f.module);
    if (module && typeof f.offset === "number")
        return `${module}+0x${f.offset.toString(16)}`;
    return module;
}
// FNV-1a, 64-bit: deterministic and cheap; this is a group key, not security.
function fnv1a64(s) {
    let h = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(s)) {
        h ^= BigInt(byte);
        h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return h.toString(16).padStart(16, "0");
}
export function problemParams(name, params) {
    const frames = (Array.isArray(params.frames) ? params.frames : []).filter(isObject).slice(0, MAX_FRAMES);
    const inApp = frames.filter((f) => f.in_app === true);
    const keys = (inApp.length > 0 ? inApp : frames)
        .map(frameKey)
        .filter((k) => k !== null)
        .slice(0, GROUPING_FRAMES);
    const type = text(params.type) ?? "unknown";
    const out = {
        ...params,
        type,
        frames,
        fingerprint: fnv1a64([name, type, ...keys].join("\n")),
        title: keys.length > 0 ? `${type} at ${keys[0]}` : type,
    };
    if (Array.isArray(params.breadcrumbs))
        out.breadcrumbs = params.breadcrumbs.slice(-MAX_BREADCRUMBS);
    return out;
}
