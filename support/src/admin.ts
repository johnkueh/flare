// The sign-in page Claude sends you to when you connect the inbox (GET/POST /authorize). There is
// one account: whoever knows ADMIN_KEY. You type it once per connection; the OAuth provider then
// issues Claude its own tokens.

import { AuthorizationError, CimdFetchError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { SupportEnv } from "./config.ts";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f5;color:#1b1f1d;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{width:min(400px,calc(100vw - 32px));background:#fff;border:1px solid #e3e6e3;border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 12px}p{margin:0 0 12px;color:#4a514d}.warn{color:#9a3412}
label{display:block;font-weight:600;margin:16px 0 6px}input{width:100%;box-sizing:border-box;font:inherit;padding:9px 11px;border:1px solid #cfd4d0;border-radius:8px}
.row{display:flex;gap:8px;margin-top:16px}button{font:inherit;padding:9px 16px;border-radius:8px;border:1px solid #cfd4d0;background:#fff;cursor:pointer}
button.primary{background:#1b1f1d;color:#fff;border-color:#1b1f1d}.error{color:#b91c1c}
</style></head><body><main>${body}</main></body></html>`;

function consentPage(d: ConsentDescription, handle: string, error?: string) {
  const who = d.clientDomain ? `<strong>${escape(d.clientName)}</strong> from ${escape(d.clientDomain)}` : `<strong>${escape(d.clientName)}</strong> (the app named itself)`;
  return page(
    "Connect the support inbox",
    `<h1>Connect the support inbox</h1>
<p>${who} wants to read and answer support conversations. Access goes to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ""}
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<label for="key">Admin key</label><input id="key" name="key" type="password" autocomplete="current-password" required>
${error ? `<p class="error">${escape(error)}</p>` : ""}
<div class="row"><button class="primary" name="decision" value="approve" type="submit">Connect</button><button name="decision" value="deny" type="submit" formnovalidate>Cancel</button></div></form>`
  );
}

const textError = (message: string, status = 400) => new Response(page("Can't connect", `<h1>Can't connect</h1><p>${escape(message)}</p>`), { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

/** Constant-time comparison, so the key can't be guessed a character at a time. */
async function sameKey(a: string, b: string) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export const isAdminKey = (env: SupportEnv, key: string) => Boolean(env.ADMIN_KEY) && sameKey(key, env.ADMIN_KEY);

export async function handleAuthorize(request: Request, env: SupportEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const auth = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(auth);
      const consent = await oauth.beginConsent(auth);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(consentPage(details, consent.handle), { headers: consent.headers });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (!(await isAdminKey(env, String(form.get("key") ?? "")))) {
      // A wrong key uses up the handle, so start over from Claude.
      await oauth.denyConsent(request, handle).catch(() => undefined);
      return textError("That key isn't right. Start connecting again from Claude.", 403);
    }
    const approved = await oauth.approveConsent(request, handle, {});
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: "admin",
      metadata: {},
      scope: approved.request.scope,
      props: { admin: true },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return textError(error.description);
    if (error instanceof CimdFetchError) return textError("This app could not be verified.");
    throw error;
  }
}
