// The Worker side: evaluates flags.json through the Flagship binding.
//
//   const res = flagsHttp(request, { binding: env.FLAGS, flags });
//   if (res) return res;
//
// answers POST /ofrep/v1/evaluate/flags (all flags, what the apps call) and
// /ofrep/v1/evaluate/flags/{key} (one flag), so any OpenFeature OFREP
// provider works against it too. In Worker code, read flags directly with
// `evaluateFlags(env.FLAGS, flags, context)`.

import {
  accepts,
  type BulkResponse,
  type EvaluationContext,
  type FlagKey,
  type FlagResult,
  type FlagsFile,
  type FlagValue,
  type FlagValues,
  type Kind,
  kinds,
  PATH,
} from "./schema.ts";

export type { EvaluationContext, FlagsFile, FlagValues } from "./schema.ts";

interface Details<T> {
  value: T;
  variant?: string;
  reason?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** The part of Cloudflare's `Flagship` binding this package uses. */
export interface FlagshipBinding {
  getBooleanDetails(key: string, defaultValue: boolean, context?: object): Promise<Details<boolean>>;
  getStringDetails(key: string, defaultValue: string, context?: object): Promise<Details<string>>;
  getNumberDetails(key: string, defaultValue: number, context?: object): Promise<Details<number>>;
  getObjectDetails<T extends object>(key: string, defaultValue: T, context?: object): Promise<Details<T>>;
}

/** What the client sent, kept to the attributes worth trusting by default. */
export interface ClientContext {
  /** The signed-in user's id or the install's random id, as the app sent it. */
  targetingKey?: string;
  platform?: string;
  appVersion?: string;
  osVersion?: string;
  locale?: string;
}

export interface FlagsHttpOptions<F extends FlagsFile> {
  binding: FlagshipBinding;
  /** The app's flags.json. */
  flags: F;
  /** Mounted under a prefix, such as "/v1". Default: none. */
  prefix?: string;
  /**
   * The context Flagship evaluates with. Default: `defaults`, which is the
   * client's targetingKey, platform, appVersion, osVersion and locale plus
   * `country` from the request. Override it to use your own user id, or to
   * add attributes the client can't be trusted to send (a plan, a role):
   *
   *   context: async ({ request, defaults }) => ({
   *     ...defaults,
   *     targetingKey: (await whoIs(auth, request.headers))?.userId ?? defaults.targetingKey,
   *   })
   */
  context?: (args: {
    request: Request;
    client: ClientContext;
    defaults: EvaluationContext;
  }) => EvaluationContext | Promise<EvaluationContext>;
  /** Allow web pages on other origins: "*" or a list of origins. */
  cors?: "*" | readonly string[];
}

/** The flags endpoint for `request`, or null when it's for another route. */
export function flagsHttp<F extends FlagsFile>(request: Request, options: FlagsHttpOptions<F>): Promise<Response> | null {
  const url = new URL(request.url);
  const base = (options.prefix ?? "") + PATH;
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return null;
  return serve(request, url.pathname.slice(base.length + 1), options);
}

const CLIENT_KEYS = ["platform", "appVersion", "osVersion", "locale"] as const;

function clientContext(body: unknown): ClientContext {
  const raw = (body as { context?: Record<string, unknown> } | null)?.context;
  const out: ClientContext = {};
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.targetingKey === "string" && raw.targetingKey.length > 0 && raw.targetingKey.length <= 128) {
    out.targetingKey = raw.targetingKey;
  }
  for (const k of CLIENT_KEYS) {
    const v = raw[k];
    if (typeof v === "string" && v.length <= 64) out[k] = v;
  }
  return out;
}

async function serve<F extends FlagsFile>(request: Request, key: string, options: FlagsHttpOptions<F>): Promise<Response> {
  const cors = corsHeaders(request, options.cors);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") {
    return Response.json({ errorCode: "INVALID_CONTEXT", errorDetails: "Use POST" }, { status: 405, headers: cors });
  }
  const body: unknown = await request.json().catch(() => null);
  const client = clientContext(body);
  const country = (request as { cf?: { country?: string } }).cf?.country;
  const defaults: EvaluationContext = { ...client, ...(country ? { country } : {}) };
  const context = options.context ? await options.context({ request, client, defaults }) : defaults;

  if (key) {
    const one = (await results(options.binding, options.flags, context, [decodeURIComponent(key)]))[0];
    const status = one.errorCode === "FLAG_NOT_FOUND" ? 404 : one.errorCode ? 400 : 200;
    return Response.json(one, { status, headers: { ...cors, "cache-control": "no-store" } });
  }

  const flags = await results(options.binding, options.flags, context);
  const etag = await etagOf(flags);
  const headers = { ...cors, etag, "cache-control": "no-store" };
  if (matches(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return Response.json({ flags } satisfies BulkResponse, { headers });
}

function matches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

async function etagOf(flags: FlagResult[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(flags.map((f) => [f.key, f.value ?? null, f.errorCode ?? null])));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 12);
  return `"${btoa(String.fromCharCode(...hash)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}"`;
}

function corsHeaders(request: Request, cors: FlagsHttpOptions<FlagsFile>["cors"]): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!cors || !origin) return {};
  if (cors !== "*" && !cors.includes(origin)) return {};
  return {
    "access-control-allow-origin": cors === "*" ? "*" : origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, if-none-match",
    "access-control-expose-headers": "etag",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

async function evaluate(binding: FlagshipBinding, key: string, kind: Kind, fallback: unknown, context: object): Promise<FlagResult> {
  let details: Details<unknown>;
  try {
    switch (kind) {
      case "boolean":
        details = await binding.getBooleanDetails(key, fallback as boolean, context);
        break;
      case "string":
        details = await binding.getStringDetails(key, fallback as string, context);
        break;
      case "integer":
      case "number":
        details = await binding.getNumberDetails(key, fallback as number, context);
        break;
      default:
        details = await binding.getObjectDetails(key, fallback as object, context);
    }
  } catch (e) {
    return { key, errorCode: "GENERAL", errorDetails: e instanceof Error ? e.message : String(e) };
  }
  if (details.errorCode || details.reason === "ERROR") {
    return { key, errorCode: details.errorCode ?? "GENERAL", errorDetails: details.errorMessage ?? "" };
  }
  if (!accepts(kind, details.value)) {
    return { key, errorCode: "TYPE_MISMATCH", errorDetails: `${key} isn't ${kind === "integer" ? "a whole number" : `a ${kind}`}` };
  }
  return { key, value: details.value, reason: details.reason, variant: details.variant };
}

async function results(binding: FlagshipBinding, file: FlagsFile, raw: EvaluationContext, only?: string[]): Promise<FlagResult[]> {
  const all = kinds(file);
  // Flagship takes primitives only.
  const context = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== null));
  const keys = only ?? [...all.keys()];
  return Promise.all(
    keys.map((key) => {
      const kind = all.get(key);
      if (!kind) return { key, errorCode: "FLAG_NOT_FOUND", errorDetails: `${key} isn't in flags.json` };
      return evaluate(binding, key, kind, file.flags[key].default, context);
    }),
  );
}

/**
 * Every flag for `context`, typed from flags.json. A flag Flagship can't
 * evaluate (missing, wrong type) gets its default.
 *
 *   const { "new-checkout": newCheckout } = await evaluateFlags(env.FLAGS, flags, { targetingKey: userId });
 */
export async function evaluateFlags<F extends FlagsFile>(
  binding: FlagshipBinding,
  flags: F,
  context: EvaluationContext = {},
): Promise<FlagValues<F>> {
  const out: Record<string, unknown> = {};
  for (const r of await results(binding, flags, context)) {
    out[r.key] = "value" in r && r.value !== undefined ? r.value : flags.flags[r.key].default;
  }
  return out as FlagValues<F>;
}

/** One flag for `context`, typed from flags.json. */
export async function evaluateFlag<F extends FlagsFile, K extends FlagKey<F>>(
  binding: FlagshipBinding,
  flags: F,
  key: K,
  context: EvaluationContext = {},
): Promise<FlagValue<F, K>> {
  const [r] = await results(binding, flags, context, [key]);
  return (r.value !== undefined ? r.value : flags.flags[key].default) as FlagValue<F, K>;
}
