// Firebase Cloud Messaging, HTTP v1, as a service account. There's no
// multicast in v1: one request per token.
import { importKey, signJwt } from "./jwt.js";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
let cached = null;
export function resetFcmToken() {
    cached = null;
}
async function accessToken(account, doFetch, now) {
    if (cached && cached.email === account.client_email && now < cached.expires)
        return cached.token;
    const iat = Math.floor(now / 1000);
    const uri = account.token_uri ?? TOKEN_URI;
    const key = await importKey("RS256", account.private_key);
    const assertion = await signJwt("RS256", key, {}, { iss: account.client_email, scope: SCOPE, aud: uri, iat, exp: iat + 3600 });
    const res = await doFetch(uri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    if (!res.ok)
        throw new Error(`Google OAuth: HTTP ${res.status}`);
    const body = (await res.json());
    // Renew five minutes early.
    cached = { email: account.client_email, token: body.access_token, expires: now + ((body.expires_in ?? 3600) - 300) * 1000 };
    return body.access_token;
}
/** The message FCM gets. `notification` makes Android show it while the
 *  app is in the background; `data` reaches the app either way. */
export function fcmPayload(message) {
    return {
        message: {
            token: message.token,
            notification: { title: message.title, body: message.body },
            data: { key: message.key, ...message.data },
            android: {
                priority: message.interruption === "passive" ? "normal" : "high",
                ...(message.collapseId && { collapse_key: message.collapseId }),
                notification: {
                    ...(message.channel && { channel_id: message.channel }),
                    ...(message.collapseId && { tag: message.collapseId }),
                    ...(message.sound && { default_sound: true }),
                },
            },
        },
    };
}
export async function sendFcm(account, message, options = {}) {
    const doFetch = options.fetch ?? fetch;
    let token;
    try {
        token = await accessToken(account, doFetch, options.now ?? Date.now());
    }
    catch (e) {
        return { status: "retry", reason: e instanceof Error ? e.message : String(e) };
    }
    let res;
    try {
        res = await doFetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(fcmPayload(message)),
        });
    }
    catch (e) {
        return { status: "retry", reason: `network: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (res.ok)
        return { status: "sent", id: (await res.json().catch(() => null))?.name };
    const body = (await res.json().catch(() => null));
    const code = body?.error?.details?.find((d) => d.errorCode)?.errorCode ?? body?.error?.status ?? `HTTP ${res.status}`;
    if (code === "UNREGISTERED" || res.status === 404)
        return { status: "gone", reason: code };
    if (res.status === 401) {
        resetFcmToken();
        return { status: "retry", reason: code };
    }
    if (res.status === 429 || res.status >= 500 || code === "UNAVAILABLE" || code === "INTERNAL") {
        const after = Number(res.headers.get("retry-after"));
        return { status: "retry", reason: code, ...(Number.isFinite(after) && after > 0 && { after }) };
    }
    // INVALID_ARGUMENT on a token that isn't one at all.
    if (code === "INVALID_ARGUMENT" && /registration token/i.test(body?.error?.message ?? ""))
        return { status: "gone", reason: code };
    return { status: "failed", reason: code };
}
