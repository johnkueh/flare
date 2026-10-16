import { type ContextValue, type FlagKey, type FlagsFile, type FlagValue, type FlagValues } from "./schema.ts";
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
export declare function createFlags<F extends FlagsFile>(options: FlagsOptions<F>): Flags<F>;
