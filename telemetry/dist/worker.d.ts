import { type GscEnv } from "./gsc.ts";
import { type TelemetryEnv } from "./handler.ts";
type Env = TelemetryEnv & GscEnv;
declare const _default: {
    fetch(request: Request<unknown, IncomingRequestCfProperties<unknown>>, env: Env): Promise<Response> | Response;
    scheduled(_controller: ScheduledController, env: Env): Promise<void>;
};
export default _default;
