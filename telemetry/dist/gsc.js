// Google Search Console, pulled into the same table as the app's events:
// one `gsc_query` row per site, day, query, page, country and device, so
// "which searches bring people who go on to sign up" is one SQL join.
//
// Search Console has no push and its bulk export only goes to BigQuery, so
// the Worker reads the Search Analytics API once a day (`scheduled`) for the
// day three days back, when Google's numbers are final. POST /v1/gsc/pull
// pulls any day again (a backfill; the API keeps 16 months).
//
// Setup, once per site: a Google Cloud service account with the Search
// Console API enabled, its JSON key in the secret GSC_SERVICE_ACCOUNT, its
// email added as a (restricted) user on the Search Console property, and the
// site in GSC_SITES. Rows have a stable event_id per site, day and keys, so a
// day pulled twice is deduplicated with `SELECT DISTINCT event_id …` or
// `ROW_NUMBER() OVER (PARTITION BY event_id …)`.
const DIMENSIONS = ["query", "page", "country", "device"];
const PAGE_SIZE = 25_000;
// The API stops at 50k rows per day per site for one search type.
const MAX_ROWS = 50_000;
const SEND_CHUNK = 1000;
export const FINAL_AFTER_DAYS = 3;
const b64url = (bytes) => {
    const s = typeof bytes === "string" ? bytes : String.fromCharCode(...new Uint8Array(bytes));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
// FNV-1a, 64-bit, for stable row ids (the same as problems.ts).
function fnv1a64(s) {
    let h = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(s)) {
        h ^= BigInt(byte);
        h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return h.toString(16).padStart(16, "0");
}
/** An OAuth access token for the service account (a signed JWT, exchanged at Google). */
async function accessToken(serviceAccountJson, fetcher) {
    const sa = JSON.parse(serviceAccountJson);
    const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/webmasters.readonly",
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
    }));
    const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
    const res = await fetcher(tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: `${header}.${claims}.${b64url(sig)}`,
        }),
    });
    if (!res.ok)
        throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
    return (await res.json()).access_token;
}
/** One API row as a table row. Pure, so it's tested without Google. */
export function gscRow(site, appId, date, r, receivedAt) {
    const [query, page, country, device] = r.keys;
    return {
        received_at: receivedAt,
        client_ts: `${date}T00:00:00.000Z`,
        app_id: appId,
        env: "prod",
        platform: "search",
        install_id: "gsc",
        session_id: null,
        user_id: null,
        event_id: `gsc_${fnv1a64([site, date, ...r.keys].join("\n"))}`,
        name: "gsc_query",
        params: {
            site,
            date,
            query: query ?? "",
            page: page ?? "",
            // Search Console uses ISO 3166-1 alpha-3 in lowercase ("aus").
            country: country ?? "",
            device: device ?? "",
            clicks: r.clicks,
            impressions: r.impressions,
            position: Math.round(r.position * 100) / 100,
        },
        app_version: null,
        app_build: null,
        os_version: null,
        device_model: null,
        locale: null,
        country: null,
        sdk: "flare-telemetry-gsc",
    };
}
/** The UTC date `days` before `now`, as YYYY-MM-DD. */
export function daysAgo(now, days) {
    return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}
/** Pulls one day for every site in GSC_SITES, or only `site`. Returns rows written per site. */
export async function pullDay(env, date, fetcher = fetch, site) {
    if (!env.GSC_SERVICE_ACCOUNT)
        throw new Error("GSC_SERVICE_ACCOUNT is not set");
    let sites = JSON.parse(env.GSC_SITES || "{}");
    if (site) {
        if (!(site in sites))
            throw new Error(`${site} is not in GSC_SITES`);
        sites = { [site]: sites[site] };
    }
    const token = await accessToken(env.GSC_SERVICE_ACCOUNT, fetcher);
    const receivedAt = new Date().toISOString();
    const written = {};
    const failed = [];
    properties: for (const [property, appId] of Object.entries(sites)) {
        let startRow = 0;
        let total = 0;
        while (startRow < MAX_ROWS) {
            const res = await fetcher(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({ startDate: date, endDate: date, dimensions: DIMENSIONS, rowLimit: PAGE_SIZE, startRow, dataState: "final" }),
            });
            // One property failing (say, the service account isn't on it yet) doesn't stop the others.
            if (!res.ok) {
                failed.push(`Search Console ${property} ${date}: ${res.status} ${await res.text()}`);
                continue properties;
            }
            const rows = (await res.json()).rows ?? [];
            const out = rows.map((r) => gscRow(property, appId, date, r, receivedAt));
            for (let i = 0; i < out.length; i += SEND_CHUNK)
                await env.EVENTS.send(out.slice(i, i + SEND_CHUNK));
            total += out.length;
            if (rows.length < PAGE_SIZE)
                break;
            startRow += PAGE_SIZE;
        }
        written[property] = total;
    }
    if (failed.length > 0)
        throw new Error(`${failed.join("\n")}\nwritten: ${JSON.stringify(written)}`);
    return written;
}
/**
 * POST /v1/gsc/pull {"date": "YYYY-MM-DD", "site"?: "sc-domain:…"} with
 * `authorization: Bearer <GSC_ADMIN_TOKEN>`. With `site`, only that property is
 * pulled, so backfilling a newly added site doesn't write the others' rows again.
 */
export async function handleGscPull(request, env) {
    if (!env.GSC_ADMIN_TOKEN || request.headers.get("authorization") !== `Bearer ${env.GSC_ADMIN_TOKEN}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (request.method !== "POST")
        return Response.json({ error: "use POST" }, { status: 405 });
    const { date, site } = (await request.json().catch(() => ({})));
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
        return Response.json({ error: 'body needs {"date": "YYYY-MM-DD"}' }, { status: 400 });
    if (site !== undefined && !(site in JSON.parse(env.GSC_SITES || "{}"))) {
        return Response.json({ error: `${site} is not in GSC_SITES` }, { status: 400 });
    }
    try {
        return Response.json({ date, written: await pullDay(env, date, fetch, site) });
    }
    catch (e) {
        return Response.json({ error: e.message }, { status: 502 });
    }
}
