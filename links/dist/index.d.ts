import { type Link, type LinksFile } from "./config.ts";
export { appleAppSiteAssociation, assetLinks, addLinkEvents, certificateSha256, checkLinks, LINK_EVENTS, type Link, type LinkKind, type LinksFile, linkUrl, normalizeSha256, parseLink, REFERRER_KEY, SCHEME_HOST, schemeUrl, storeUrl, } from "./config.ts";
/** What the landing page and chat previews say about one link. */
export interface LinkCard {
    /** "Mia invited you to Flat". */
    title: string;
    /** A line under it ("3 people, 42 recipes"). */
    text?: string;
    /** Shown large with a Copy button, e.g. an invite code ("7KQ2-M9XD"). */
    detail?: string;
    /** An absolute image URL for previews in Messages and WhatsApp. */
    image?: string;
}
export interface LinksOptions {
    /** The card for a link, or null for the default ("Open this in Cooked").
     *  Return `false` to answer 404 (a revoked code, say). */
    describe?: (link: Link, request: Request) => LinkCard | null | false | Promise<LinkCard | null | false>;
    page?: {
        /** The app icon, absolute or root-relative ("/icon.png"). */
        icon?: string;
        /** The button color. */
        accent?: string;
        /** The image previews use when the card has none. */
        image?: string;
        /** Extra CSS appended to the page's own. */
        css?: string;
    };
    /** `link_page_viewed` with { kind }, for the app's telemetry. */
    onEvent?: (name: string, props: Record<string, string>) => void;
}
export interface FlareLinks {
    /** Answers the .well-known files and every link path; null for anything else. */
    http(request: Request): Promise<Response | null>;
    /** The https link for a kind and its parts. */
    url(kind: string, params: Record<string, string>): string;
    /** The link a URL (or text holding one) points at. */
    parse(input: string | URL): Link | null;
}
export declare function flareLinks(file: LinksFile, options?: LinksOptions): FlareLinks;
/** The page someone sees when the app didn't open: what the link is, Get
 *  (copies the link, then the store) and Open (the app's own scheme). */
export declare function landingPage(file: LinksFile, link: Link, card: LinkCard | null, page: NonNullable<LinksOptions["page"]>): string;
