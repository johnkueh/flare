// @flare/auth: accounts for apps on Flare, on Better Auth.
//
// Every phone signs in on first launch as an anonymous user, proved genuine
// by App Attest or Android key attestation (./plugin.ts). Signing in later
// with a real account links that user, so nothing is lost. Phones send the
// session token as a bearer token; web pages use Better Auth's cookie.
//
// A Worker builds one auth per request (Better Auth wants the env's
// bindings) and mounts it under the API's prefix:
//
//   const auth = flareAuth(env);
//   if (url.pathname.startsWith("/v1/auth/")) return auth.handler(request);
//   const space = spaceHttp(request, env, { prefix: "/v1", authenticate: (r) => authenticate(auth, r) });

import { type BetterAuthOptions, betterAuth } from "better-auth";
import { anonymous, bearer } from "better-auth/plugins";
import type { AttestEnv } from "./attest/env";
import { type FlareAttestOptions, flareAttest } from "./plugin";

export { CHALLENGE_HEADER, flareAttest } from "./plugin";
export type { AttestEnv } from "./attest/env";

export interface FlareAuthEnv extends AttestEnv {
  /** At least 32 random characters; signs cookies and tokens. */
  BETTER_AUTH_SECRET: string;
  /** The API's public origin, e.g. "https://api.example.com". */
  BETTER_AUTH_URL: string;
  /** "true" lets anonymous sign-in through unattested (simulators, CI). */
  FLARE_AUTH_ALLOW_UNATTESTED?: string;
}

/** Called when an anonymous user becomes a real one (or signs in to an
 *  account that already exists). Spaces keyed on the anonymous user's id
 *  move to the new one here. */
export type LinkAccount = (users: { anonymousUserId: string; userId: string }) => Promise<void>;

export interface FlareAuthOptions {
  /** Where the auth routes are mounted. Default "/v1/auth". */
  basePath?: string;
  onLinkAccount?: LinkAccount;
  /** Anything else for Better Auth: socialProviders, more plugins,
   *  trustedOrigins, session lifetimes. Plugins are added after Flare's. */
  betterAuth?: Omit<BetterAuthOptions, "database" | "secret" | "baseURL" | "basePath">;
}

export function flareAuthOptions(env: FlareAuthEnv, options: FlareAuthOptions = {}) {
  const attest: FlareAttestOptions = { allowUnattested: env.FLARE_AUTH_ALLOW_UNATTESTED === "true" };
  return {
    ...options.betterAuth,
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: options.basePath ?? "/v1/auth",
    plugins: [
      flareAttest(env, attest),
      anonymous({
        onLinkAccount: async ({ anonymousUser, newUser }) => {
          await options.onLinkAccount?.({ anonymousUserId: anonymousUser.user.id, userId: newUser.user.id });
        },
      }),
      bearer(),
      ...(options.betterAuth?.plugins ?? []),
    ],
  } satisfies BetterAuthOptions;
}

export function flareAuth(env: FlareAuthEnv, options: FlareAuthOptions = {}) {
  return betterAuth(flareAuthOptions(env, options));
}

export type FlareAuth = ReturnType<typeof flareAuth>;

/** Who a request is: the session's user and the device it signed in on
 *  (`web:<session id>` when it didn't attest). Null when signed out. */
export async function whoIs(auth: FlareAuth, headers: Headers): Promise<{ userId: string; deviceId: string } | null> {
  const found = await auth.api.getSession({ headers });
  if (!found) return null;
  const session = found.session as typeof found.session & { deviceId?: string | null };
  return { userId: found.user.id, deviceId: session.deviceId ?? `web:${session.id}` };
}

/** `spaceHttp`'s authenticate: the user id, or a 401 that tells the app to
 *  sign in again (SpaceTokens refreshes on it). */
export async function authenticate(auth: FlareAuth, request: Request): Promise<string | Response> {
  const who = await whoIs(auth, request.headers);
  if (who) return who.userId;
  return Response.json({ code: "ATTESTATION_REQUIRED", message: "Sign in again." }, { status: 401 });
}
