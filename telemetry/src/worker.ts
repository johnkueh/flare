// The standalone ingest Worker (wrangler.jsonc): /v1/events, plus the daily
// Search Console pull (gsc.ts) when GSC_SERVICE_ACCOUNT is set.
import { daysAgo, FINAL_AFTER_DAYS, type GscEnv, handleGscPull, pullDay } from "./gsc.ts";
import { handleEvents, type TelemetryEnv } from "./handler.ts";

type Env = TelemetryEnv & GscEnv;

export default {
  fetch(request, env): Promise<Response> | Response {
    const path = new URL(request.url).pathname;
    if (path === "/v1/events") return handleEvents(request, env);
    if (path === "/v1/gsc/pull") return handleGscPull(request, env);
    return new Response("not found", { status: 404 });
  },
  async scheduled(_controller, env) {
    if (!env.GSC_SERVICE_ACCOUNT) return;
    const date = daysAgo(Date.now(), FINAL_AFTER_DAYS);
    // A failure throws, so it shows in the Worker's logs and cron history.
    console.log(JSON.stringify({ gsc: date, written: await pullDay(env, date) }));
  },
} satisfies ExportedHandler<Env>;
