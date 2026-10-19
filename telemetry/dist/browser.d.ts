import { type AnyEvents, type EventName, type EventParams, type EventsFile } from "./events.ts";
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
    /**
     * Rewrites each `page_view` path before it's sent, e.g. `/cases/smith-pty-ltd` to
     * `/cases/:slug` when a path segment names a customer. Default: the path as it is.
     */
    pagePath?: (path: string) => string;
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
/** Stack lines from Chrome/Firefox/Safari as SDK frames, innermost first. */
export declare function parseStack(stack: string | undefined, origin: string | null): Record<string, unknown>[];
export declare function telemetry<E extends EventsFile = AnyEvents>(options: TelemetryOptions<E>): Telemetry<E>;
