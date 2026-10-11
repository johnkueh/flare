// flareAttest: a Better Auth plugin that ties sign-in to a genuine copy of
// the app. A phone registers an App Attest or Android Keystore key once,
// then signs a fresh challenge whenever it signs in. The key's id becomes
// the session's `deviceId`, so a space can list "John's iPhone" under John.
//
// Anonymous sign-in requires it (it's the open door: anyone could mint
// users otherwise). Other sign-ins (Apple, email code) take it when a phone
// sends it and skip it on the web, where those sessions get no deviceId.

import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import * as z from "zod";
import { verifyAndroidAssertion, registerAndroidKey } from "./attest/android";
import {
  type AssertionResult,
  consumeChallenge,
  newChallenge,
  type RegisterResult,
  registerKey,
  verifyAssertion,
} from "./attest/apple";
import type { AttestEnv } from "./attest/env";

/** The challenge a sign-in's assertion signs (from GET /attest/challenge). */
export const CHALLENGE_HEADER = "X-Attest-Challenge";
/** Set by onRequest once a sign-in's assertion checks out; any copy a
 *  client sends is dropped first, so only this plugin can set it. */
const VERIFIED_DEVICE_HEADER = "X-Flare-Verified-Device";

export interface FlareAttestOptions {
  /** Let anonymous sign-in through without attestation. Simulators and CI
   *  only: App Attest doesn't run on the iOS simulator. */
  allowUnattested?: boolean;
}

export const flareAttest = (env: AttestEnv, options: FlareAttestOptions = {}) =>
  ({
    id: "flare-attest",
    schema: {
      session: {
        fields: {
          // The attested key that signed in, or null (web, unattested).
          deviceId: { type: "string", required: false, input: false },
        },
      },
    },
    endpoints: {
      attestChallenge: createAuthEndpoint("/attest/challenge", { method: "GET" }, async (ctx) =>
        ctx.json({ challenge: await newChallenge(env) }),
      ),
      attestApple: createAuthEndpoint(
        "/attest/apple",
        {
          method: "POST",
          body: z.object({ keyId: z.string(), attestation: z.string(), challenge: z.string() }),
        },
        async (ctx) => {
          const result = await registerKey(env, ctx.body);
          if (!result.ok) throw registrationError(result);
          return ctx.json({ keyId: result.keyId });
        },
      ),
      attestAndroid: createAuthEndpoint(
        "/attest/android",
        {
          method: "POST",
          body: z.object({ keyId: z.string(), certificateChain: z.array(z.string()).max(10), challenge: z.string() }),
        },
        async (ctx) => {
          const result = await registerAndroidKey(env, ctx.body);
          if (!result.ok) throw registrationError(result);
          return ctx.json({ keyId: result.keyId });
        },
      ),
    },
    async onRequest(request, ctx) {
      const headers = new Headers(request.headers);
      headers.delete(VERIFIED_DEVICE_HEADER);
      const path = endpointPath(request.url, ctx.options.basePath ?? "/api/auth");

      if (path.startsWith("/sign-in/") || path.startsWith("/sign-up/")) {
        const signed = headers.has("X-App-Attest-Key-Id") || headers.has("X-Android-Key-Id");
        if (signed) {
          const result = await verifySignIn(env, headers);
          if (!result.ok) return { response: refuse(result.code, result.detail) };
          headers.set(VERIFIED_DEVICE_HEADER, result.keyId);
        } else if (path === "/sign-in/anonymous" && !options.allowUnattested) {
          return { response: refuse("ATTESTATION_REQUIRED", "missing headers") };
        }
      }
      return { request: new Request(request, { headers }) };
    },
    init() {
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                async before(session, ctx) {
                  const deviceId = ctx?.headers?.get(VERIFIED_DEVICE_HEADER) ?? null;
                  return { data: { ...session, deviceId } };
                },
              },
            },
          },
        },
      };
    },
  }) satisfies BetterAuthPlugin;

/** A sign-in's assertion over its one-time challenge, App Attest or
 *  Android. The challenge is used up whether or not it verifies. */
async function verifySignIn(env: AttestEnv, headers: Headers): Promise<AssertionResult> {
  const challenge = headers.get(CHALLENGE_HEADER);
  if (!challenge || !(await consumeChallenge(env, challenge))) {
    return { ok: false, code: "INVALID_ASSERTION", detail: "unknown, used or expired challenge" };
  }
  const body = new TextEncoder().encode(challenge);
  return headers.has("X-Android-Key-Id")
    ? verifyAndroidAssertion(env, headers, body)
    : verifyAssertion(env, headers, body);
}

function registrationError(result: Extract<RegisterResult, { ok: false }>): APIError {
  const code = result.reason === "challenge" ? "INVALID_CHALLENGE" : "INVALID_ATTESTATION";
  console.log(JSON.stringify({ event: "auth_attest_register_rejected", code, detail: result.detail }));
  return new APIError("BAD_REQUEST", { code, message: result.detail });
}

function refuse(code: string, detail: string): Response {
  console.log(JSON.stringify({ event: "auth_attest_rejected", code, detail }));
  const message = code === "ATTESTATION_REQUIRED" ? "This device needs to verify itself." : "This device's signature didn't check out.";
  return Response.json({ code, message }, { status: 401 });
}

/** The path under Better Auth's basePath, e.g. "/sign-in/anonymous". */
function endpointPath(url: string, basePath: string): string {
  const pathname = new URL(url).pathname;
  const path = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname;
  return path.startsWith("/") ? path : `/${path}`;
}
