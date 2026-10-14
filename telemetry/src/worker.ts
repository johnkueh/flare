// The standalone ingest Worker (wrangler.jsonc): /v1/events and nothing else.
import { handleEvents, type TelemetryEnv } from "./handler.ts";

export default {
  fetch(request, env): Promise<Response> | Response {
    if (new URL(request.url).pathname === "/v1/events") return handleEvents(request, env);
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<TelemetryEnv>;
