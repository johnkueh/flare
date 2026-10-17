import { type AnyEvents, type EventName, type EventParams, type EventsFile } from "./events.ts";
export type { EventsFile } from "./events.ts";
/** A service binding (`env.TELEMETRY`) or the Worker's origin, e.g. "https://flare-telemetry.example.workers.dev". */
export type Target = {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
} | string;
/** The browser sender's install and session ids, from its cookie. */
export declare function browserIds(request: Request | undefined): {
    installId: string;
    sessionId: string;
} | null;
/**
 * Forwards a browser batch to the telemetry Worker, adding the visitor's
 * country (which the shared Worker can't see behind a service binding).
 * Mount it at the endpoint the browser sender posts to.
 */
export declare function mountEvents(request: Request, target: Target): Promise<Response>;
export interface ServerTelemetryOptions<E extends EventsFile> {
    target: Target;
    appId: string;
    appKey: string;
    events?: E;
    /** Default "prod". */
    env?: string;
    appVersion?: string;
}
export interface TrackOptions {
    /** The signed-in user, so this joins their web and phone events. */
    userId?: string | null;
    /** The request this happened in: its browser cookie gives the install and session, and its country. */
    request?: Request;
    /** `ctx.waitUntil`, so the response doesn't wait on telemetry. Without it the send runs on its own. */
    waitUntil?: (promise: Promise<unknown>) => void;
}
export interface ServerTelemetry<E extends EventsFile> {
    /** Send one event. Never throws; a bad name is dropped. Resolves when it's sent (or failed), or at once with `waitUntil`. */
    track<K extends EventName<E>>(name: K, params?: EventParams<E, K>, options?: TrackOptions): Promise<void>;
    /** An `error` event for a caught error. */
    reportError(error: unknown, options?: TrackOptions): Promise<void>;
}
export declare function serverTelemetry<E extends EventsFile = AnyEvents>(options: ServerTelemetryOptions<E>): ServerTelemetry<E>;
