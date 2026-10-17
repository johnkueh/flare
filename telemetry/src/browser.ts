// The sender for web pages: the same events, ids and batch format as the
// Rust SDK the phone apps use, in a few KB with no dependencies.
//
//   import events from "./events.json";
//   const t = telemetry({ appId: "ledgersignal", appKey: "k_…", events });
//   t.identify(user.id);
//   t.track("csv_exported", { rows: 120 });
//
// It keeps an install id and a session id (new after 30 minutes idle) in
// localStorage, sends `first_open`, `session_start`, a `page_view` on every
// route change and an `error` for uncaught errors, and posts batches to the
// app's own origin (default `/api/events`, which `mountEvents` from
// "@flare/telemetry/server" forwards), so ad blockers leave it alone.
// It also keeps the ids in a first-party cookie, so events the Worker sends
// for a request land in the same session.

import {
  type AnyEvents,
  cleanParams,
  type EventName,
  type EventParams,
  type EventsFile,
  eventId,
  IDS_COOKIE,
  NAME,
  type Params,
  randomId,
  type WireBatch,
  type WireEvent,
} from "./events.ts";

export type { EventsFile } from "./events.ts";

/** localStorage's shape, so `localStorage` itself works. */
export interface TelemetryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TelemetryOptions<E extends EventsFile> {
  /** The product's id, the same one its phone apps send (e.g. "ledgersignal"). */
  appId: string;
  /** The product's public key from the telemetry Worker's APP_KEYS. */
  appKey: string;
  /** The events.json, for typed `track` calls. */
  events?: E;
  /** Where batches go. Default "/api/events" on this origin. */
  endpoint?: string;
  /** "prod", "dev"… Default "prod". */
  env?: string;
  appVersion?: string;
  appBuild?: string;
  /** Send a `page_view` on load and on every History API navigation. Default true. */
  pageViews?: boolean;
  /** Send an `error` for uncaught errors and unhandled rejections. Default true. */
  errors?: boolean;
  /** Keep the ids in a first-party cookie for the Worker. Default true. */
  cookie?: boolean;
  /** Default 10 s. */
  flushIntervalMs?: number;
  /** Send as soon as this many are waiting. Default 50. */
  maxBatchSize?: number;
  /** Oldest dropped past this. Default 500. */
  maxQueueSize?: number;
  /** Default: localStorage when there is one, else memory. */
  storage?: TelemetryStorage | null;
  fetch?: typeof fetch;
}

export interface Telemetry<E extends EventsFile> {
  /** Queue an event. Never throws; a bad name is dropped. */
  track<K extends EventName<E>>(name: K, params?: EventParams<E, K>): void;
  /** After sign-in, so web, server and phone events join on the user; null after sign-out. */
  identify(userId: string | null): void;
  /** A `page_view` for the current path (sent for you unless `pageViews: false`). */
  pageView(path?: string): void;
  /** An `error` for a caught error. */
  reportError(error: unknown): void;
  /** Send what's waiting now. */
  flush(): Promise<void>;
  readonly installId: string;
  readonly sessionId: string;
  /** Stops the timer and the listeners. */
  close(): void;
}

interface State {
  installId: string;
  sessionId: string;
  lastActivity: number;
  userId: string | null;
}

const STATE_KEY = "flare.telemetry";
const QUEUE_KEY = "flare.telemetry.queue";
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BREADCRUMBS = 30;
// Browsers cap keepalive bodies at 64 KB.
const KEEPALIVE_BYTES = 60_000;
const SDK = "flare-telemetry-web/0.6.0";

function memoryStorage(): TelemetryStorage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

function defaultStorage(): TelemetryStorage {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Storage blocked (private mode, sandboxed frame).
  }
  return memoryStorage();
}

function read<T>(storage: TelemetryStorage, key: string): T | null {
  try {
    const v = storage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function write(storage: TelemetryStorage, key: string, value: unknown) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Full or blocked: the queue stays in memory.
  }
}

/** Stack lines from Chrome/Firefox/Safari as SDK frames, innermost first. */
export function parseStack(stack: string | undefined, origin: string | null): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  for (const line of (stack ?? "").split("\n")) {
    // "    at fn (https://x/a.js:1:2)" | "    at https://x/a.js:1:2" | "fn@https://x/a.js:1:2"
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line) ?? /^(.*?)@(.+?):(\d+):(\d+)$/.exec(line);
    if (!m) continue;
    const [, fn, file, ln, col] = m;
    let path = file;
    let inApp = false;
    try {
      const u = new URL(file);
      inApp = origin !== null && u.origin === origin;
      path = u.pathname;
    } catch {
      // Not a URL (eval, native code).
    }
    frames.push({ function: fn || null, file_line: `${path}:${ln}:${col}`, module: path, in_app: inApp });
    if (frames.length >= 30) break;
  }
  return frames;
}

export function telemetry<E extends EventsFile = AnyEvents>(options: TelemetryOptions<E>): Telemetry<E> {
  const storage = options.storage ?? defaultStorage();
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const endpoint = options.endpoint ?? "/api/events";
  const maxBatch = options.maxBatchSize ?? 50;
  const maxQueue = options.maxQueueSize ?? 500;
  const hasWindow = typeof window !== "undefined";
  const origin = hasWindow ? window.location.origin : null;

  const saved = read<State>(storage, STATE_KEY);
  const fresh = !saved?.installId;
  const state: State = saved?.installId
    ? saved
    : { installId: randomId(), sessionId: "", lastActivity: 0, userId: null };
  let queue: WireEvent[] = read<WireEvent[]>(storage, QUEUE_KEY) ?? [];
  const crumbs: { name: string; ts: number }[] = [];
  let sending = false;
  let lastPath: string | null = null;
  let firstPageView = true;

  const context: WireBatch["context"] = {
    app_id: options.appId,
    env: options.env ?? "prod",
    platform: "web",
    install_id: state.installId,
    app_version: options.appVersion ?? null,
    app_build: options.appBuild ?? null,
    os_version: null,
    device_model: null,
    locale: typeof navigator !== "undefined" ? (navigator.language ?? null) : null,
    sdk: SDK,
  };

  const save = () => {
    write(storage, STATE_KEY, state);
    if (options.cookie !== false && typeof document !== "undefined") {
      try {
        document.cookie = `${IDS_COOKIE}=${state.installId}.${state.sessionId}; path=/; max-age=31536000; samesite=lax`;
      } catch {
        // No cookie access (sandboxed frame).
      }
    }
  };

  const push = (name: string, params: Params, ts: number) => {
    queue.push({ name, event_id: eventId(ts), ts, session_id: state.sessionId, user_id: state.userId, params });
    if (queue.length > maxQueue) queue = queue.slice(queue.length - maxQueue);
    crumbs.push({ name, ts });
    if (crumbs.length > MAX_BREADCRUMBS) crumbs.shift();
  };

  // A new session after 30 idle minutes, with its session_start first.
  const touch = (now: number) => {
    if (!state.sessionId || now - state.lastActivity > SESSION_TIMEOUT_MS || now < state.lastActivity) {
      state.sessionId = randomId();
      push("session_start", {}, now);
    }
    state.lastActivity = now;
  };

  const enqueue = (name: string, params: Params) => {
    if (!NAME.test(name)) return;
    const now = Date.now();
    touch(now);
    push(name, cleanParams(params), now);
    save();
    write(storage, QUEUE_KEY, queue);
    if (queue.length >= maxBatch) void flush();
  };

  async function flush(keepalive = false): Promise<void> {
    // The page going away doesn't wait for a send in flight: its answer won't be read either.
    if ((sending && !keepalive) || queue.length === 0) return;
    sending = true;
    const batch = queue.slice(0, maxBatch);
    const body = JSON.stringify({ context, sent_at: Date.now(), events: batch } satisfies WireBatch);
    const sent = new Set(batch.map((e) => e.event_id));
    const drop = () => {
      queue = queue.filter((e) => !sent.has(e.event_id));
      write(storage, QUEUE_KEY, queue);
    };
    // The page is going away: its answer may never be read, and a stored queue would send these
    // again on the next page. A keepalive request is delivered anyway, so drop them now.
    const unloading = keepalive && body.length < KEEPALIVE_BYTES;
    if (unloading) drop();
    let done = false;
    try {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-key": options.appKey },
        body,
        keepalive: unloading,
        credentials: "same-origin",
      });
      // A batch the Worker can never take is dropped; anything else is retried later.
      done = res.ok || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
    } catch {
      done = false;
    }
    if (done && !unloading) drop();
    sending = false;
    if ((done || unloading) && queue.length > 0 && (unloading || queue.length >= maxBatch)) await flush(keepalive);
  }

  const errorParams = (error: unknown): Params => {
    const e = error instanceof Error ? error : null;
    return {
      type: e?.name ?? typeof error,
      message: (e?.message ?? String(error)).slice(0, 500),
      frames: parseStack(e?.stack, origin),
      breadcrumbs: crumbs.slice(-MAX_BREADCRUMBS),
      from_previous_run: false,
    };
  };

  const pageView = (path?: string) => {
    const p = path ?? (hasWindow ? window.location.pathname : "/");
    if (p === lastPath) return;
    lastPath = p;
    const params: Params = { path: p };
    if (firstPageView && typeof document !== "undefined" && document.referrer) {
      try {
        const r = new URL(document.referrer);
        if (r.origin !== origin) params.referrer = `${r.origin}${r.pathname}`;
      } catch {
        // Not a URL.
      }
    }
    firstPageView = false;
    enqueue("page_view", params);
  };

  const cleanups: (() => void)[] = [];
  const timer = setInterval(() => void flush(), options.flushIntervalMs ?? 10_000);
  cleanups.push(() => clearInterval(timer));

  if (fresh) enqueue("first_open", {});
  else {
    touch(Date.now());
    save();
  }

  if (hasWindow) {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush(true);
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    cleanups.push(() => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    });

    if (options.errors !== false) {
      const onError = (e: ErrorEvent) => enqueue("error", errorParams(e.error ?? e.message));
      const onRejection = (e: PromiseRejectionEvent) => enqueue("error", errorParams(e.reason));
      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onRejection);
      cleanups.push(() => {
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
      });
    }

    if (options.pageViews !== false) {
      // Any router ends in pushState/replaceState or a popstate.
      const onNav = () => queueMicrotask(() => pageView());
      const { pushState, replaceState } = history;
      history.pushState = function (...args) {
        pushState.apply(this, args);
        onNav();
      };
      history.replaceState = function (...args) {
        replaceState.apply(this, args);
        onNav();
      };
      window.addEventListener("popstate", onNav);
      cleanups.push(() => {
        history.pushState = pushState;
        history.replaceState = replaceState;
        window.removeEventListener("popstate", onNav);
      });
      pageView();
    }
  }

  return {
    track(name, params) {
      enqueue(name, (params ?? {}) as Params);
    },
    identify(userId) {
      state.userId = userId;
      save();
    },
    pageView,
    reportError(error) {
      enqueue("error", errorParams(error));
    },
    flush: () => flush(),
    get installId() {
      return state.installId;
    },
    get sessionId() {
      return state.sessionId;
    },
    close() {
      for (const c of cleanups) c();
    },
  };
}
