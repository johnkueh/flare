// POST /v1/events: the endpoint every app's telemetry-sdk posts to. Checks
// the public app key, turns the batch into rows and sends them to a Basin
// stream (which writes the `telemetry.events` Iceberg table, by day).
//
// Mount it in your own Worker, or deploy src/worker.ts as is.

import type { Pipeline } from "cloudflare:pipelines";

import { type Row, toRows } from "./rows.ts";

export type { Row } from "./rows.ts";

export interface TelemetryEnv {
  /** The Basin stream binding (wrangler `pipelines`). */
  EVENTS: Pipeline<Row>;
  /** JSON map of public app key -> app id, e.g. {"k_…": "glp3"}. */
  APP_KEYS: string;
}

const MAX_BODY_BYTES = 1_000_000;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-app-key",
  "access-control-max-age": "86400",
};

const reply = (status: number, error?: string) =>
  error ? Response.json({ error }, { status, headers: CORS }) : new Response(null, { status, headers: CORS });

export async function handleEvents(request: Request, env: TelemetryEnv): Promise<Response> {
  if (request.method === "OPTIONS") return reply(204);
  if (request.method !== "POST") return reply(405, "use POST");

  let keys: Record<string, string>;
  try {
    keys = JSON.parse(env.APP_KEYS);
  } catch {
    return reply(500, "APP_KEYS is not valid JSON");
  }
  const appId = keys[request.headers.get("x-app-key") ?? ""];
  if (!appId) return reply(401, "unknown app key");

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return reply(413, "batch too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, "body is not JSON");
  }

  const country = (request.cf?.country as string | undefined) ?? null;
  const rows = toRows(body, appId, Date.now(), country);
  if (typeof rows === "string") return reply(400, rows);
  // A failed send throws, so the response is a 5xx and the SDK retries.
  if (rows.length > 0) await env.EVENTS.send(rows);
  return reply(204);
}
