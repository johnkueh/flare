/** One event in events.json. */
export interface EventDef {
    readonly description?: string;
    /** Param name -> an example value, which sets its type. */
    readonly params?: {
        readonly [param: string]: string | number | boolean;
    };
}
/** The parsed events.json: `import events from "./events.json"`. */
export interface EventsFile {
    readonly events: {
        readonly [name: string]: EventDef;
    };
}
/** Events every sender may send without declaring them. */
export type BuiltInEvent = "first_open" | "session_start" | "page_view" | "error";
export declare const BUILT_IN_EVENTS: readonly BuiltInEvent[];
type Widen<V> = V extends number ? number : V extends boolean ? boolean : string;
export type EventName<E extends EventsFile> = Extract<keyof E["events"], string> | BuiltInEvent;
export type EventParams<E extends EventsFile, K extends string> = string extends keyof E["events"] ? Params : K extends keyof E["events"] ? E["events"][K]["params"] extends infer P ? P extends Record<string, string | number | boolean> ? {
    [Q in keyof P]?: Widen<P[Q]>;
} : Record<string, never> : never : Params;
/** An event's params on the wire: JSON values (undefined ones are dropped). */
export type Params = {
    [key: string]: unknown;
};
/** Without an events.json, any snake_case name and params. */
export type AnyEvents = {
    readonly events: {
        readonly [name: string]: EventDef;
    };
};
/** Event names and param keys, the same rule as the Worker and the Rust SDK. */
export declare const NAME: RegExp;
/** The problems in an events.json, as readable lines (empty: it's fine). */
export declare function checkEvents(file: unknown): string[];
/** Event ids in the same shape as the Rust SDK's: base-36 millis, "_", 10 random base-36 chars. */
export declare function eventId(now?: number): string;
/** A random 128-bit id as 32 hex chars, like the SDK's install and session ids. */
export declare function randomId(): string;
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
export declare function cleanParams(params: Params | undefined): Params;
/** The cookie the browser sender keeps its ids in, so server events join the same session. */
export declare const IDS_COOKIE = "flare_ids";
export {};
