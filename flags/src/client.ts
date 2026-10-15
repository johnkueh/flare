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

import { type BulkResponse, type ContextValue, type FlagKey, type FlagsFile, type FlagValue, type FlagValues, type Kind, accepts, kinds, PATH } from "./schema.ts";

/** localStorage's shape, so `localStorage` itself works. */
export interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FlagsOptions<F extends FlagsFile> {
  /** The Worker's origin, such as "https://api.example.com"; "" for this page's. */
  server: string;
  /** Mounted under a prefix on the Worker, such as "/v1". */
  prefix?: string;
  /** The app's flags.json. */
  flags: F;
  /** The signed-in user's id. Without one, a random id for this browser or install. */
  user?: string | null;
  /** Where the last values and the install id live. Default: localStorage
   *  when there is one, else memory (use `fileStorage` from "@flare/flags/node"). */
  storage?: FlagStorage | null;
  /** Extra headers on each request, such as authorization. */
  headers?: () => HeadersInit | Promise<HeadersInit>;
  /** Extra attributes sent to the Worker (platform, appVersion…). */
  context?: Record<string, ContextValue>;
  /** How often to refresh, in ms (default 5 minutes; 0: only on demand). */
  refreshInterval?: number;
  /** Refresh as soon as it's created (default true). */
  refreshOnStart?: boolean;
  fetch?: typeof fetch;
}

export type Listener<F extends FlagsFile> = (changed: FlagKey<F>[]) => void;

export interface Flags<F extends FlagsFile> {
  /** A flag's value. Typed from flags.json. */
  get<K extends FlagKey<F>>(key: K): FlagValue<F, K>;
  /** Every flag's value, without holding any (for a debug view). */
  all(): FlagValues<F>;
  /** Asks the Worker for fresh values; resolves with the flags that changed.
   *  Never rejects: offline or a server error keeps the values you have. */
  refresh(): Promise<FlagKey<F>[]>;
  /** Lets flags that were read take their latest values. */
  activate(): FlagKey<F>[];
  /** Evaluate for a signed-in user (null: this install again). */
  setUser(user: string | null): Promise<FlagKey<F>[]>;
  /** Told the flags whose values changed. Returns the unsubscribe. */
  subscribe(listener: Listener<F>): () => void;
  /** Settles after the first refresh (or straight away with refreshOnStart: false). */
  readonly ready: Promise<void>;
  /** The id flags are evaluated for. */
  readonly identity: string;
  /** When the Worker last answered, or null. */
  readonly fetchedAt: Date | null;
  /** The last refresh's error, if it failed. */
  readonly lastError: Error | null;
  /** Stops the timer and the page-visibility listener. */
  close(): void;
}

interface Cache {
  installId: string;
  identity?: string;
  etag?: string | null;
  fetchedAt?: number | null;
  values?: Record<string, unknown>;
}

const STORAGE_KEY = "flare.flags";

function memoryStorage(): FlagStorage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

function defaultStorage(): FlagStorage {
  try {
    const ls = (globalThis as { localStorage?: FlagStorage }).localStorage;
    if (ls) {
      ls.getItem(STORAGE_KEY);
      return ls;
    }
  } catch {
    // Private mode, or a sandboxed frame.
  }
  return memoryStorage();
}

function randomId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function createFlags<F extends FlagsFile>(options: FlagsOptions<F>): Flags<F> {
  const schema = options.flags;
  const all: Map<string, Kind> = kinds(schema);
  const storage = options.storage === undefined ? defaultStorage() : (options.storage ?? memoryStorage());
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const url = `${options.server.replace(/\/+$/, "")}${options.prefix ?? ""}${PATH}`;

  let cache: Cache = { installId: "" };
  try {
    cache = { ...cache, ...JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    // A corrupt entry: start again.
  }
  const installId = cache.installId || randomId();
  let user = options.user ?? null;
  const identity = () => user ?? installId;

  const valid = (k: string, v: unknown) => {
    const kind = all.get(k);
    return kind !== undefined && accepts(kind, v);
  };
  const pick = (values: Record<string, unknown> | undefined) =>
    new Map(Object.entries(values ?? {}).filter(([k, v]) => valid(k, v)));

  let server = cache.identity === identity() ? pick(cache.values) : new Map<string, unknown>();
  let active = new Map(server);
  let etag = cache.identity === identity() ? (cache.etag ?? null) : null;
  let fetchedAt = cache.identity === identity() ? (cache.fetchedAt ?? null) : null;
  let lastError: Error | null = null;
  const read = new Set<string>();
  // The user changed and no response has come for them yet: the next one
  // applies to every flag (a new user is a moment where change is expected).
  let switched = false;
  const listeners = new Set<Listener<F>>();

  const save = () => {
    try {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ installId, identity: identity(), etag, fetchedAt, values: Object.fromEntries(server) } satisfies Cache),
      );
    } catch {
      // Full or unavailable: the values still work for this session.
    }
  };
  save();

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  const settle = (everything: boolean): FlagKey<F>[] => {
    const changed: FlagKey<F>[] = [];
    for (const key of all.keys()) {
      const live = schema.flags[key].live === true;
      if (!(everything || live || !read.has(key))) continue;
      const next = server.get(key);
      if (!same(active.get(key), next)) {
        if (next === undefined) active.delete(key);
        else active.set(key, next);
        changed.push(key as FlagKey<F>);
      }
    }
    return changed;
  };

  const notify = (changed: FlagKey<F>[]) => {
    if (changed.length === 0) return;
    for (const l of listeners) {
      try {
        l(changed);
      } catch (e) {
        console.error(e);
      }
    }
  };

  const valueOf = (key: string) => (active.has(key) ? active.get(key) : schema.flags[key]?.default);

  let inflight: Promise<FlagKey<F>[]> | null = null;
  const refresh = (): Promise<FlagKey<F>[]> => {
    if (inflight) return inflight;
    inflight = (async () => {
      const asked = identity();
      try {
        const headers = new Headers(options.headers ? await options.headers() : undefined);
        headers.set("content-type", "application/json");
        if (etag) headers.set("if-none-match", etag);
        const res = await doFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ context: { ...options.context, targetingKey: asked } }),
        });
        if (asked !== identity()) return [];
        if (res.status === 304) {
          fetchedAt = Date.now();
          lastError = null;
          save();
          return [];
        }
        if (!res.ok) throw new Error(`flags: the server answered ${res.status}`);
        const body = (await res.json()) as BulkResponse;
        if (!Array.isArray(body?.flags)) throw new Error("flags: unexpected response");
        server = new Map(
          body.flags
            .filter((f) => f && typeof f.key === "string" && f.value !== undefined && valid(f.key, f.value))
            .map((f) => [f.key, f.value]),
        );
        etag = res.headers.get("etag");
        fetchedAt = Date.now();
        lastError = null;
        save();
        const changed = settle(switched);
        switched = false;
        notify(changed);
        return changed;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        return [];
      } finally {
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
  let timer: ReturnType<typeof setInterval> | undefined;
  if (interval > 0) {
    timer = setInterval(() => void refresh(), interval);
    (timer as { unref?: () => void }).unref?.(); // don't keep a CLI alive
  }
  const doc = (globalThis as { document?: { visibilityState: string; addEventListener: Function; removeEventListener: Function } }).document;
  const onVisible = () => {
    if (doc?.visibilityState !== "visible") return;
    activate();
    void refresh();
  };
  doc?.addEventListener("visibilitychange", onVisible);

  const ready = options.refreshOnStart === false ? Promise.resolve() : refresh().then(() => undefined);

  return {
    get: (key) => {
      read.add(key);
      return valueOf(key) as never;
    },
    all: () => Object.fromEntries([...all.keys()].map((k) => [k, valueOf(k)])) as FlagValues<F>,
    refresh,
    activate,
    async setUser(next) {
      if (next === user) return [];
      user = next;
      server = new Map();
      etag = null;
      fetchedAt = null;
      save();
      switched = true;
      const changed = settle(true);
      notify(changed);
      if (inflight) await inflight; // asked for the previous user
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
      if (timer) clearInterval(timer);
      doc?.removeEventListener("visibilitychange", onVisible);
    },
  };
}
