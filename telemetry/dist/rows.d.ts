export type Row = {
    received_at: string;
    client_ts: string;
    app_id: string;
    env: string;
    platform: string;
    install_id: string;
    session_id: string | null;
    user_id: string | null;
    event_id: string;
    name: string;
    params: Record<string, unknown>;
    app_version: string | null;
    app_build: string | null;
    os_version: string | null;
    device_model: string | null;
    locale: string | null;
    country: string | null;
    sdk: string | null;
};
export declare const MAX_EVENTS_PER_BATCH = 500;
/**
 * Returns the rows to store, or an error string for a batch that can never
 * be valid (the SDK drops those instead of retrying). Individual bad events
 * inside a good batch are skipped, not fatal.
 */
export declare function toRows(body: unknown, appId: string, receivedAtMs: number, country: string | null): Row[] | string;
