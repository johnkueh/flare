// The client for web pages, Node and command-line tools. Typed from the
// app's flags.json, no code generation:
//
//   import schema from "./flags.json";
//   const flags = createFlags({ server: "https://api.example.com", flags: schema });
//   flags.get("new-checkout"); // boolean
//
// Same rules as the Rust core the phone apps use (crates/flags): reads
// never wait and never fail; a flag read since the last activate() keeps
// its value until the next one (the page coming back into view), unless
// it's "live".
import { accepts, kinds, PATH } from "./schema.js";
const STORAGE_KEY = "flare.flags";
function memoryStorage() {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}
function defaultStorage() {
    try {
        const ls = globalThis.localStorage;
        if (ls) {
            ls.getItem(STORAGE_KEY);
            return ls;
        }
    }
    catch {
        // Private mode, or a sandboxed frame.
    }
    return memoryStorage();
}
function randomId() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
export function createFlags(options) {
    const schema = options.flags;
    const all = kinds(schema);
    const storage = options.storage === undefined ? defaultStorage() : (options.storage ?? memoryStorage());
    const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const url = `${options.server.replace(/\/+$/, "")}${options.prefix ?? ""}${PATH}`;
    let cache = { installId: "" };
    try {
        cache = { ...cache, ...JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") };
    }
    catch {
        // A corrupt entry: start again.
    }
    const installId = cache.installId || randomId();
    let user = options.user ?? null;
    const identity = () => user ?? installId;
    const valid = (k, v) => {
        const kind = all.get(k);
        return kind !== undefined && accepts(kind, v);
    };
    const pick = (values) => new Map(Object.entries(values ?? {}).filter(([k, v]) => valid(k, v)));
    let server = cache.identity === identity() ? pick(cache.values) : new Map();
    let active = new Map(server);
    let etag = cache.identity === identity() ? (cache.etag ?? null) : null;
    let fetchedAt = cache.identity === identity() ? (cache.fetchedAt ?? null) : null;
    let lastError = null;
    const read = new Set();
    // The user changed and no response has come for them yet: the next one
    // applies to every flag (a new user is a moment where change is expected).
    let switched = false;
    const listeners = new Set();
    const save = () => {
        try {
            storage.setItem(STORAGE_KEY, JSON.stringify({ installId, identity: identity(), etag, fetchedAt, values: Object.fromEntries(server) }));
        }
        catch {
            // Full or unavailable: the values still work for this session.
        }
    };
    save();
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const settle = (everything) => {
        const changed = [];
        for (const key of all.keys()) {
            const live = schema.flags[key].live === true;
            if (!(everything || live || !read.has(key)))
                continue;
            const next = server.get(key);
            if (!same(active.get(key), next)) {
                if (next === undefined)
                    active.delete(key);
                else
                    active.set(key, next);
                changed.push(key);
            }
        }
        return changed;
    };
    const notify = (changed) => {
        if (changed.length === 0)
            return;
        for (const l of listeners) {
            try {
                l(changed);
            }
            catch (e) {
                console.error(e);
            }
        }
    };
    const valueOf = (key) => (active.has(key) ? active.get(key) : schema.flags[key]?.default);
    let inflight = null;
    const refresh = () => {
        if (inflight)
            return inflight;
        inflight = (async () => {
            const asked = identity();
            try {
                const headers = new Headers(options.headers ? await options.headers() : undefined);
                headers.set("content-type", "application/json");
                if (etag)
                    headers.set("if-none-match", etag);
                const res = await doFetch(url, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ context: { ...options.context, targetingKey: asked } }),
                });
                if (asked !== identity())
                    return [];
                if (res.status === 304) {
                    fetchedAt = Date.now();
                    lastError = null;
                    save();
                    return [];
                }
                if (!res.ok)
                    throw new Error(`flags: the server answered ${res.status}`);
                const body = (await res.json());
                if (!Array.isArray(body?.flags))
                    throw new Error("flags: unexpected response");
                server = new Map(body.flags
                    .filter((f) => f && typeof f.key === "string" && f.value !== undefined && valid(f.key, f.value))
                    .map((f) => [f.key, f.value]));
                etag = res.headers.get("etag");
                fetchedAt = Date.now();
                lastError = null;
                save();
                const changed = settle(switched);
                switched = false;
                notify(changed);
                return changed;
            }
            catch (e) {
                lastError = e instanceof Error ? e : new Error(String(e));
                return [];
            }
            finally {
                inflight = null;
            }
        })();
        return inflight;
    };
    const activate = () => {
        const changed = settle(true);
        read.clear();
        notify(changed);
        return changed;
    };
    // Refresh on a timer, and when a page comes back into view.
    const interval = options.refreshInterval ?? 5 * 60_000;
    let timer;
    if (interval > 0) {
        timer = setInterval(() => void refresh(), interval);
        timer.unref?.(); // don't keep a CLI alive
    }
    const doc = globalThis.document;
    const onVisible = () => {
        if (doc?.visibilityState !== "visible")
            return;
        activate();
        void refresh();
    };
    doc?.addEventListener("visibilitychange", onVisible);
    const ready = options.refreshOnStart === false ? Promise.resolve() : refresh().then(() => undefined);
    return {
        get: (key) => {
            read.add(key);
            return valueOf(key);
        },
        all: () => Object.fromEntries([...all.keys()].map((k) => [k, valueOf(k)])),
        refresh,
        activate,
        async setUser(next) {
            if (next === user)
                return [];
            user = next;
            server = new Map();
            etag = null;
            fetchedAt = null;
            save();
            switched = true;
            const changed = settle(true);
            notify(changed);
            if (inflight)
                await inflight; // asked for the previous user
            const more = await refresh();
            return [...new Set([...changed, ...more])];
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        ready,
        get identity() {
            return identity();
        },
        get fetchedAt() {
            return fetchedAt === null ? null : new Date(fetchedAt);
        },
        get lastError() {
            return lastError;
        },
        close() {
            if (timer)
                clearInterval(timer);
            doc?.removeEventListener("visibilitychange", onVisible);
        },
    };
}
