// For an app's own Worker: send events from the server, and forward the
// browser sender's batches.
//
//   // wrangler.jsonc: "services": [{ "binding": "TELEMETRY", "service": "flare-telemetry" }]
//   import events from "../events.json";
//   const telemetry = serverTelemetry({ target: env.TELEMETRY, appId: "ledgersignal", appKey: "k_…", events });
//
//   // the browser's batches, on this origin so ad blockers leave them alone
//   if (url.pathname === "/api/events") return mountEvents(request, env.TELEMETRY);
//
//   // an event, joined to the browser session that made the request
//   telemetry.track("statement_extracted", { pages: 12 }, { userId, request, waitUntil: (p) => ctx.waitUntil(p) });
//
// `target` is the service binding to the shared `flare-telemetry` Worker, or
// its URL for an app hosted somewhere else. Sending never throws and never
// holds up the response when `waitUntil` is given.

import {
  type AnyEvents,
  cleanParams,
  type EventName,
  type EventParams,
  type EventsFile,
  eventId,
  IDS_COOKIE,
  NAME,
  type Params,
  type WireBatch,
} from "./events.ts";

export type { EventsFile } from "./events.ts";

/** A service binding (`env.TELEMETRY`) or the Worker's origin, e.g. "https://flare-telemetry.example.workers.dev". */
export type Target = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } | string;

const MAX_BODY_BYTES = 1_000_000;
const SDK = "flare-telemetry-server/0.6.0";

function post(target: Target, init: RequestInit): Promise<Response> {
  if (typeof target === "string") return fetch(`${target.replace(/\/$/, "")}/v1/events`, init);
  // A service binding ignores the host; the path is what the Worker routes on.
  return target.fetch("https://flare-telemetry/v1/events", init);
}

function cfCountry(request: Request | undefined): string | null {
  const c = (request as { cf?: { country?: unknown } } | undefined)?.cf?.country;
  return typeof c === "string" ? c : null;
}

/** The browser sender's install and session ids, from its cookie. */
export function browserIds(request: Request | undefined): { installId: string; sessionId: string } | null {
  const cookie = request?.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k !== IDS_COOKIE || !v) continue;
    const [installId, sessionId] = v.split(".");
    if (/^[0-9a-f]{32}$/.test(installId ?? "")) {
      return { installId, sessionId: /^[0-9a-f]{32}$/.test(sessionId ?? "") ? sessionId : "" };
    }
  }
  return null;
}

/**
 * Forwards a browser batch to the telemetry Worker, adding the visitor's
 * country (which the shared Worker can't see behind a service binding).
 * Mount it at the endpoint the browser sender posts to.
 */
export async function mountEvents(request: Request, target: Target): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "use POST" }, { status: 405 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return Response.json({ error: "batch too large" }, { status: 413 });
  let body: WireBatch;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "body is not JSON" }, { status: 400 });
  }
  if (body && typeof body === "object" && body.context && typeof body.context === "object") {
    body.context.country = cfCountry(request);
  }
  try {
    const res = await post(target, {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-key": request.headers.get("x-app-key") ?? "" },
      body: JSON.stringify(body),
    });
    return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "text/plain" } });
  } catch {
    return Response.json({ error: "telemetry unavailable" }, { status: 503 });
  }
}

export interface ServerTelemetryOptions<E extends EventsFile> {
  target: Target;
  appId: string;
  appKey: string;
  events?: E;
  /** Default "prod". */
  env?: string;
  appVersion?: string;
}

export interface TrackOptions {
  /** The signed-in user, so this joins their web and phone events. */
  userId?: string | null;
  /** The request this happened in: its browser cookie gives the install and session, and its country. */
  request?: Request;
  /** `ctx.waitUntil`, so the response doesn't wait on telemetry. Without it the send runs on its own. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface ServerTelemetry<E extends EventsFile> {
  /** Send one event. Never throws; a bad name is dropped. Resolves when it's sent (or failed), or at once with `waitUntil`. */
  track<K extends EventName<E>>(name: K, params?: EventParams<E, K>, options?: TrackOptions): Promise<void>;
  /** An `error` event for a caught error. */
  reportError(error: unknown, options?: TrackOptions): Promise<void>;
}

/** Stack lines from V8 (workerd) as SDK frames, innermost first. */
function frames(stack: string | undefined): Params[] {
  const out: Params[] = [];
  for (const line of (stack ?? "").split("\n")) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    out.push({ function: m[1] ?? null, file_line: `${m[2]}:${m[3]}:${m[4]}`, module: m[2], in_app: !m[2].includes("node_modules") });
    if (out.length >= 30) break;
  }
  return out;
}

export function serverTelemetry<E extends EventsFile = AnyEvents>(options: ServerTelemetryOptions<E>): ServerTelemetry<E> {
  const send = async (name: string, params: Params, opts: TrackOptions = {}): Promise<void> => {
    if (!NAME.test(name)) return;
    const ids = browserIds(opts.request);
    const now = Date.now();
    const batch: WireBatch = {
      context: {
        app_id: options.appId,
        env: options.env ?? "prod",
        platform: "server",
        install_id: ids?.installId ?? "server",
        app_version: options.appVersion ?? null,
        country: cfCountry(opts.request),
        sdk: SDK,
      },
      sent_at: now,
      events: [
        { name, event_id: eventId(now), ts: now, session_id: ids?.sessionId || null, user_id: opts.userId ?? null, params: cleanParams(params) },
      ],
    };
    const sending = post(options.target, {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-key": options.appKey },
      body: JSON.stringify(batch),
    }).then(
      (res) => {
        // Read the body so the connection is released; nothing to do with it.
        void res.body?.cancel();
      },
      () => undefined,
    );
    if (opts.waitUntil) opts.waitUntil(sending);
    else await sending;
  };

  return {
    track(name, params, opts) {
      return send(name, (params ?? {}) as Params, opts);
    },
    reportError(error, opts) {
      const e = error instanceof Error ? error : null;
      return send(
        "error",
        { type: e?.name ?? typeof error, message: (e?.message ?? String(error)).slice(0, 500), frames: frames(e?.stack), from_previous_run: false },
        opts,
      );
    },
  };
}
