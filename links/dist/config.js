// links.json: what a Flare app's links look like, and the pure functions the
// Worker, the CLI and the tests share. Nothing here touches the network.
/** The query key the Android Play referrer carries the link under. */
export const REFERRER_KEY = "flare_link";
/** The custom-scheme host that wraps an https link: <scheme>://link?url=… */
export const SCHEME_HOST = "link";
/** Problems with a links.json, as sentences. Empty when it's fine. */
export function checkLinks(file) {
    const problems = [];
    if (!file || typeof file !== "object")
        return ["links.json isn't an object"];
    if (typeof file.domain !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(file.domain)) {
        problems.push(`domain should be a bare host like "example.com", not ${JSON.stringify(file.domain)}`);
    }
    if (typeof file.name !== "string" || !file.name)
        problems.push("name is missing");
    if (file.scheme !== undefined && !/^[a-z][a-z0-9+.-]*$/.test(file.scheme)) {
        problems.push(`scheme ${JSON.stringify(file.scheme)} isn't a valid URL scheme`);
    }
    for (const id of file.ios?.appIds ?? []) {
        if (!/^[A-Z0-9]{10}\.[\w.-]+$/.test(id))
            problems.push(`ios.appIds: ${JSON.stringify(id)} should be "<team id>.<bundle id>"`);
    }
    if (file.android) {
        if (!file.android.packages?.length)
            problems.push("android.packages is empty");
        for (const digest of file.android.sha256 ?? []) {
            if (!normalizeSha256(digest))
                problems.push(`android.sha256: ${JSON.stringify(digest)} isn't a SHA-256`);
        }
    }
    if (!file.links || Object.keys(file.links).length === 0)
        problems.push("links is empty");
    for (const [kind, link] of Object.entries(file.links ?? {})) {
        if (!/^[a-z][a-z0-9_]*$/.test(kind))
            problems.push(`links.${kind}: names are lowercase letters, digits and _`);
        if (typeof link?.path !== "string" || !link.path.startsWith("/")) {
            problems.push(`links.${kind}.path should start with /`);
            continue;
        }
        for (const segment of segments(link.path)) {
            if (segment.startsWith(":") && !/^:[a-zA-Z_]\w*$/.test(segment))
                problems.push(`links.${kind}.path: bad parameter ${segment}`);
        }
    }
    return problems;
}
function segments(path) {
    return path.split("/").filter(Boolean);
}
/** Matches a path against one link pattern. */
function matchPath(pattern, pathname) {
    const want = segments(pattern);
    const got = segments(pathname);
    if (want.length !== got.length)
        return null;
    const params = {};
    for (const [i, part] of want.entries()) {
        let value;
        try {
            value = decodeURIComponent(got[i]);
        }
        catch {
            return null;
        }
        if (part.startsWith(":")) {
            if (!value)
                return null;
            params[part.slice(1)] = value;
        }
        else if (part !== value) {
            return null;
        }
    }
    return params;
}
/** The app link in a URL or in text containing one: an https link on the
 *  links domain (or www.), or <scheme>://link?url=… wrapping one. */
export function parseLink(file, input) {
    let url;
    try {
        url = typeof input === "string" ? new URL(firstUrl(input) ?? "") : input;
    }
    catch {
        return null;
    }
    if (file.scheme && url.protocol === `${file.scheme}:` && url.hostname === SCHEME_HOST) {
        const inner = url.searchParams.get("url");
        return inner ? parseLink(file, inner) : null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
        return null;
    const host = url.hostname.toLowerCase();
    if (host !== file.domain && host !== `www.${file.domain}`)
        return null;
    for (const [kind, link] of Object.entries(file.links)) {
        const params = matchPath(link.path, url.pathname);
        if (params)
            return { kind, params, url: linkUrl(file, kind, params) };
    }
    return null;
}
/** The first http(s) or app-scheme URL in some text ("Join Flat: https://…"). */
function firstUrl(text) {
    const match = text.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/i);
    return match ? match[0].replace(/[).,;!?]+$/, "") : null;
}
/** The https link for a kind and its parts. */
export function linkUrl(file, kind, params) {
    const link = file.links[kind];
    if (!link)
        throw new Error(`no link kind "${kind}" in links.json`);
    const path = segments(link.path).map((part) => {
        if (!part.startsWith(":"))
            return part;
        const value = params[part.slice(1)];
        if (value === undefined || value === "")
            throw new Error(`link "${kind}" needs ${part}`);
        return encodeURIComponent(value);
    });
    return `https://${file.domain}/${path.join("/")}`;
}
/** <scheme>://link?url=<the https link>, for the landing page's Open button. */
export function schemeUrl(file, url) {
    return file.scheme ? `${file.scheme}://${SCHEME_HOST}?url=${encodeURIComponent(url)}` : null;
}
/** Where to install the app, carrying the link through on Android. */
export function storeUrl(file, platform, url, deferred) {
    if (platform === "ios")
        return file.ios?.store ?? (file.ios?.appStoreId ? `https://apps.apple.com/app/id${file.ios.appStoreId}` : null);
    const android = file.android;
    if (!android?.packages?.length)
        return null;
    const store = new URL(android.store ?? `https://play.google.com/store/apps/details?id=${android.packages[0]}`);
    if (deferred && store.hostname === "play.google.com") {
        // Play hands `referrer` to the app once, through the Install Referrer API.
        store.searchParams.set("referrer", `${REFERRER_KEY}=${encodeURIComponent(url)}`);
    }
    return store.toString();
}
/** apple-app-site-association: which paths open which iOS apps. */
export function appleAppSiteAssociation(file) {
    const components = Object.entries(file.links).map(([kind, link]) => ({
        "/": `/${segments(link.path).map((part) => (part.startsWith(":") ? "*" : part)).join("/")}`,
        comment: kind,
    }));
    return {
        applinks: {
            details: file.ios?.appIds.length ? [{ appIDs: file.ios.appIds, components }] : [],
        },
    };
}
/** assetlinks.json: which Android apps may open the domain's links. */
export function assetLinks(file) {
    const android = file.android;
    if (!android?.packages?.length)
        return [];
    const fingerprints = android.sha256.map(normalizeSha256).filter((d) => d !== null);
    return android.packages.map((pkg) => ({
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: fingerprints },
    }));
}
/** "0c5d2c…" or "0C:5D:2C:…" → "0C:5D:2C:…", or null. */
export function normalizeSha256(digest) {
    const hex = String(digest).replace(/:/g, "").toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(hex))
        return null;
    return hex.match(/../g).join(":");
}
