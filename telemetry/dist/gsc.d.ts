import type { Pipeline } from "cloudflare:pipelines";
import type { Row } from "./rows.ts";
export interface GscEnv {
    EVENTS: Pipeline<Row>;
    /** The service account's JSON key (a secret). Unset: the pull is off. */
    GSC_SERVICE_ACCOUNT?: string;
    /** JSON map of Search Console property -> app id, e.g. {"sc-domain:ledgersignal.com": "ledgersignal"}. */
    GSC_SITES?: string;
    /** Bearer token for POST /v1/gsc/pull (a secret). Unset: the endpoint is off. */
    GSC_ADMIN_TOKEN?: string;
}
export interface GscApiRow {
    keys: string[];
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
}
export declare const FINAL_AFTER_DAYS = 3;
/** One API row as a table row. Pure, so it's tested without Google. */
export declare function gscRow(site: string, appId: string, date: string, r: GscApiRow, receivedAt: string): Row;
/** The UTC date `days` before `now`, as YYYY-MM-DD. */
export declare function daysAgo(now: number, days: number): string;
/** Pulls one day for every site in GSC_SITES. Returns rows written per site. */
export declare function pullDay(env: GscEnv, date: string, fetcher?: typeof fetch): Promise<Record<string, number>>;
/** POST /v1/gsc/pull {"date": "YYYY-MM-DD"} with `authorization: Bearer <GSC_ADMIN_TOKEN>`. */
export declare function handleGscPull(request: Request, env: GscEnv): Promise<Response>;
