// The Worker's bindings, and the apps it serves (the APPS var).

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Conversation } from "./conversation.ts";

export type SupportEnv = {
  DB: D1Database;
  CONVERSATION: DurableObjectNamespace<Conversation>;
  EMAIL?: SendEmail;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** App id -> AppConfig (an object var in wrangler.jsonc, or the same as a JSON string). */
  APPS: Apps | string;
  /** Secret, JSON: app id -> the secret that app's Worker signs identity tokens with. */
  APP_SECRETS?: string;
  /** Secret: signs widget sessions and reply-to addresses. */
  SUPPORT_SECRET: string;
  /** Secret: the key you type on the sign-in page when you connect the inbox to Claude. */
  ADMIN_KEY: string;
  /** Tests only: every email is also written here. */
  TEST_OUTBOX?: KVNamespace;
};

export type AppConfig = {
  /** Shown in the widget header and as the email sender's name. */
  name: string;
  /** Pages allowed to show the widget, e.g. ["https://example.com"]. */
  origins: string[];
  /** The support address customers write to and get replies from, e.g. "support@example.com". */
  email?: string;
  /** Who is told about new customer messages. */
  notify?: string;
  /** Widget accent colour. */
  accent?: string;
  /** First line in an empty widget. */
  greeting?: string;
};

export type Apps = Record<string, AppConfig>;

const parsed = new Map<string, Apps>();

export function apps(env: SupportEnv): Apps {
  if (typeof env.APPS !== "string") return env.APPS ?? {};
  let a = parsed.get(env.APPS);
  if (!a) {
    a = JSON.parse(env.APPS || "{}") as Apps;
    parsed.set(env.APPS, a);
  }
  return a;
}

export const app = (env: SupportEnv, id: string | null | undefined): AppConfig | undefined => (id ? apps(env)[id] : undefined);

export function appSecret(env: SupportEnv, id: string): string | undefined {
  if (!env.APP_SECRETS) return;
  return (JSON.parse(env.APP_SECRETS) as Record<string, string>)[id];
}

/** The app whose support address is on `domain`. */
export function appForDomain(env: SupportEnv, domain: string): string | undefined {
  const d = domain.toLowerCase();
  return Object.entries(apps(env)).find(([, a]) => a.email?.toLowerCase().endsWith(`@${d}`))?.[0];
}
