// Turns one SDK batch into stream rows (schema.json). Pure, so it is tested
// with node --test; index.ts does the HTTP side.

import { PROBLEM_EVENTS, problemParams } from "./problems.ts";

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

export const MAX_EVENTS_PER_BATCH = 500;
const KEY = /^[a-z][a-z0-9_]{0,63}$/;
// Clients with a clock this far off get the server's time instead.
const MAX_CLOCK_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

const str = (v: unknown, max = 200): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Returns the rows to store, or an error string for a batch that can never
 * be valid (the SDK drops those instead of retrying). Individual bad events
 * inside a good batch are skipped, not fatal.
 */
export function toRows(
  body: unknown,
  appId: string,
  receivedAtMs: number,
  country: string | null,
): Row[] | string {
  if (!isObject(body) || !isObject(body.context) || !Array.isArray(body.events)) {
    return "expected {context, events[]}";
  }
  if (body.events.length > MAX_EVENTS_PER_BATCH) return `at most ${MAX_EVENTS_PER_BATCH} events per batch`;
  const ctx = body.context;
  if (ctx.app_id !== appId) return "app_id does not match the app key";
  const installId = str(ctx.install_id, 64);
  const env = str(ctx.env, 16);
  const platform = str(ctx.platform, 32);
  if (!installId || !env || !platform) return "context needs install_id, env and platform";

  // Shift client timestamps by the gap between the SDK's send time and ours,
  // so a phone with a wrong clock still lands on the right day.
  const sentAt = typeof body.sent_at === "number" ? body.sent_at : receivedAtMs;
  const skew = Math.abs(receivedAtMs - sentAt) > MAX_CLOCK_SKEW_MS ? null : receivedAtMs - sentAt;
  const receivedAt = new Date(receivedAtMs).toISOString();

  const rows: Row[] = [];
  for (const e of body.events) {
    if (!isObject(e)) continue;
    const name = typeof e.name === "string" && KEY.test(e.name) ? e.name : null;
    const eventId = str(e.event_id, 64);
    if (!name || !eventId) continue;
    const params = isObject(e.params) ? e.params : {};
    const ts = typeof e.ts === "number" && Number.isFinite(e.ts) && skew !== null ? e.ts + skew : receivedAtMs;
    rows.push({
      received_at: receivedAt,
      client_ts: new Date(ts).toISOString(),
      app_id: appId,
      env,
      platform,
      install_id: installId,
      session_id: str(e.session_id, 64),
      user_id: str(e.user_id, 128),
      event_id: eventId,
      name,
      params: PROBLEM_EVENTS.has(name) ? problemParams(name, params) : params,
      app_version: str(ctx.app_version, 32),
      app_build: str(ctx.app_build, 32),
      os_version: str(ctx.os_version, 32),
      device_model: str(ctx.device_model, 64),
      locale: str(ctx.locale, 32),
      // The app's own Worker passes on the visitor's country (mountEvents);
      // behind a service binding this Worker can't see it.
      country: str(ctx.country, 2) ?? country,
      sdk: str(ctx.sdk, 64),
    });
  }
  return rows;
}
