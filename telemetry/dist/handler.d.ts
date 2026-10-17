import type { Pipeline } from "cloudflare:pipelines";
import { type Row } from "./rows.ts";
export type { Row } from "./rows.ts";
export interface TelemetryEnv {
    /** The Basin stream binding (wrangler `pipelines`). */
    EVENTS: Pipeline<Row>;
    /** JSON map of public app key -> app id, e.g. {"k_…": "glp3"}. */
    APP_KEYS: string;
}
export declare function handleEvents(request: Request, env: TelemetryEnv): Promise<Response>;
