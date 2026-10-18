export interface LinksFile {
    $schema?: string;
    /** The domain links live on, e.g. "heycooked.com". No scheme, no path. */
    domain: string;
    /** The app's name, as the landing page says it ("Get Cooked"). */
    name: string;
    /** The app's custom URL scheme, e.g. "cooked". The landing page's Open
     *  button uses it, because a link tapped on its own domain (or inside
     *  Instagram's or TikTok's browser) doesn't open the app by itself. */
    scheme?: string;
    ios?: {
        /** "<team id>.<bundle id>" of every app that may open the links. */
        appIds: string[];
        /** Where the landing page sends iPhones without the app: an App Store
         *  page (a custom product page is fine) or a TestFlight link. */
        store?: string;
        /** The App Store id, for Safari's Smart App Banner. */
        appStoreId?: string;
    };
    android?: {
        /** Package names that may open the links. The first gets the Play link. */
        packages: string[];
        /** SHA-256 of each signing certificate, hex with or without colons: the
         *  Play app signing key for store builds, plus any debug key. */
        sha256: string[];
        /** Overrides the Play Store page (defaults to the first package's). */
        store?: string;
    };
    /** Each kind of link: its path, with `:name` for each part the app needs. */
    links: Record<string, LinkKind>;
}
export interface LinkKind {
    /** e.g. "/j/:code". Every `:name` is one path segment. */
    path: string;
    /** Carry this kind of link through an install: Android's Play Install
     *  Referrer, and a paste on iPhone. */
    deferred?: boolean;
}
/** A link the app understands: its kind and the parts of its path. */
export interface Link {
    kind: string;
    params: Record<string, string>;
    /** The canonical https URL, on the links domain. */
    url: string;
}
/** The query key the Android Play referrer carries the link under. */
export declare const REFERRER_KEY = "flare_link";
/** The custom-scheme host that wraps an https link: <scheme>://link?url=… */
export declare const SCHEME_HOST = "link";
/** Problems with a links.json, as sentences. Empty when it's fine. */
export declare function checkLinks(file: LinksFile): string[];
/** The app link in a URL or in text containing one: an https link on the
 *  links domain (or www.), or <scheme>://link?url=… wrapping one. */
export declare function parseLink(file: LinksFile, input: string | URL): Link | null;
/** The https link for a kind and its parts. */
export declare function linkUrl(file: LinksFile, kind: string, params: Record<string, string>): string;
/** <scheme>://link?url=<the https link>, for the landing page's Open button. */
export declare function schemeUrl(file: LinksFile, url: string): string | null;
/** Where to install the app, carrying the link through on Android. */
export declare function storeUrl(file: LinksFile, platform: "ios" | "android", url: string, deferred: boolean): string | null;
/** apple-app-site-association: which paths open which iOS apps. */
export declare function appleAppSiteAssociation(file: LinksFile): {
    applinks: {
        details: {
            appIDs: string[];
            components: {
                "/": string;
                comment: string;
            }[];
        }[];
    };
};
/** assetlinks.json: which Android apps may open the domain's links. */
export declare function assetLinks(file: LinksFile): {
    relation: string[];
    target: {
        namespace: string;
        package_name: string;
        sha256_cert_fingerprints: string[];
    };
}[];
/** "0c5d2c…" or "0C:5D:2C:…" → "0C:5D:2C:…", or null. */
export declare function normalizeSha256(digest: string): string | null;
/** A certificate hash as an API reports it, hex (any case, colons or not)
 *  or base64, → "0C:5D:2C:…", or null. */
export declare function certificateSha256(value: string): string | null;
/** The events FlareLinks reports through `onEvent`, for the app's own event list. */
export declare const LINK_EVENTS: {
    readonly link_opened: {
        readonly description: "A link opened the app (Flare links). kind: the link's kind in links.json.";
        readonly params: {
            readonly kind: "invite";
        };
    };
    readonly link_deferred_claimed: {
        readonly description: "A link tapped before installing reached the app on first launch (Flare links). via: paste (iPhone) or referrer (Android, Play).";
        readonly params: {
            readonly kind: "invite";
            readonly via: "paste";
        };
    };
};
/** An events file with the link events added, in the file's own shape:
 *  params as example values (Flare telemetry's events.json) or as a list of
 *  names. Returns the names it added; existing entries are left alone. */
export declare function addLinkEvents(file: {
    events?: Record<string, unknown>;
}): {
    file: {
        events: Record<string, unknown>;
    };
    added: string[];
};
