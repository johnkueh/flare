// Links for a Flare app's Worker (LINKS.md).
//
//   const links = flareLinks(linksFile, { describe });
//   const res = await links.http(request);   // .well-known files + landing pages
//   if (res) return res;
//   links.url("invite", { code })            // https://example.com/j/7KQ2M9XD
//
// A tapped link opens the app when it's installed (Universal Links, App
// Links). Otherwise the landing page shows what the link is and sends the
// person to the store, carrying the link through: Android's Play Install
// Referrer hands it to the app on first launch, and on iPhone the Get button
// copies it for the app's paste button.

import {
  appleAppSiteAssociation,
  assetLinks,
  type Link,
  type LinksFile,
  linkUrl,
  parseLink,
  schemeUrl,
  storeUrl,
} from "./config.ts";

export {
  appleAppSiteAssociation,
  assetLinks,
  checkLinks,
  type Link,
  type LinkKind,
  type LinksFile,
  linkUrl,
  normalizeSha256,
  parseLink,
  REFERRER_KEY,
  SCHEME_HOST,
  schemeUrl,
  storeUrl,
} from "./config.ts";

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

export function flareLinks(file: LinksFile, options: LinksOptions = {}): FlareLinks {
  return {
    url: (kind, params) => linkUrl(file, kind, params),
    parse: (input) => parseLink(file, input),
    async http(request) {
      if (request.method !== "GET" && request.method !== "HEAD") return null;
      const url = new URL(request.url);
      // Apple and Google fetch these without following redirects, so they're
      // answered on every host (www included).
      if (url.pathname === "/.well-known/apple-app-site-association" || url.pathname === "/apple-app-site-association") {
        return json(appleAppSiteAssociation(file));
      }
      if (url.pathname === "/.well-known/assetlinks.json") return json(assetLinks(file));

      // Matched on the request's own path, so previews and wrangler dev work.
      const link = parseLink(file, new URL(url.pathname, `https://${file.domain}`));
      if (!link) return null;
      const card = options.describe ? await options.describe(link, request) : null;
      if (card === false) return new Response("This link doesn't work any more.", { status: 404 });
      options.onEvent?.("link_page_viewed", { kind: link.kind });
      return new Response(request.method === "HEAD" ? null : landingPage(file, link, card, options.page ?? {}), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex",
        },
      });
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
  });
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The page someone sees when the app didn't open: what the link is, Get
 *  (copies the link, then the store) and Open (the app's own scheme). */
export function landingPage(file: LinksFile, link: Link, card: LinkCard | null, page: NonNullable<LinksOptions["page"]>): string {
  const name = file.name;
  const deferred = file.links[link.kind]?.deferred === true;
  const title = card?.title ?? `Open this in ${name}`;
  const text = card?.text ?? "";
  const image = card?.image ?? page.image;
  const accent = page.accent ?? "#1a1a1a";
  const ios = storeUrl(file, "ios", link.url, deferred);
  const android = storeUrl(file, "android", link.url, deferred);
  const open = schemeUrl(file, link.url);
  const e = escapeHtml;
  // Read by the page script; JSON in a script tag only needs "<" escaped.
  const data = JSON.stringify({ url: link.url, ios, android, deferred }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="robots" content="noindex">
<meta property="og:title" content="${e(title)}">
<meta property="og:site_name" content="${e(name)}">
<meta property="og:url" content="${e(link.url)}">
${text ? `<meta property="og:description" content="${e(text)}">\n<meta name="description" content="${e(text)}">` : ""}
${image ? `<meta property="og:image" content="${e(image)}">\n<meta name="twitter:card" content="summary_large_image">` : ""}
${file.ios?.appStoreId ? `<meta name="apple-itunes-app" content="app-id=${e(file.ios.appStoreId)}, app-argument=${e(link.url)}">` : ""}
${page.icon ? `<link rel="icon" href="${e(page.icon)}">` : ""}
<style>
:root{--accent:${e(accent)};--accent-text:var(--accent);--bg:#fff;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e6e6e6;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#f2f2f2;--muted:#a0a0a0;--line:#2c2c2c;--accent-text:color-mix(in srgb,var(--accent) 55%,#fff)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:440px;margin:0 auto;padding:48px 24px;display:flex;flex-direction:column;gap:20px;min-height:100vh}
.app{display:flex;align-items:center;gap:12px;font-weight:600}
.app img{width:48px;height:48px;border-radius:11px}
h1{font-size:28px;line-height:1.2;margin:0}
p{margin:0;color:var(--muted)}
.detail{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--line);border-radius:14px;padding:14px 16px;font:600 24px/1 ui-monospace,Menlo,monospace;letter-spacing:.04em}
.detail button{font:600 15px -apple-system,sans-serif;background:none;border:0;color:var(--accent-text);cursor:pointer}
.actions{display:flex;flex-direction:column;gap:10px;margin-top:auto}
.btn{display:block;text-align:center;text-decoration:none;font-weight:600;padding:15px;border-radius:14px;background:var(--accent);color:#fff;border:0;font-size:17px;cursor:pointer}
.btn.quiet{background:none;color:var(--fg);border:1px solid var(--line)}
.hint a{color:var(--accent-text)}
.hint{font-size:14px;text-align:center}
[hidden]{display:none!important}
${page.css ?? ""}
</style>
</head>
<body>
<main>
  <div class="app">${page.icon ? `<img src="${e(page.icon)}" alt="">` : ""}<span>${e(name)}</span></div>
  <h1>${e(title)}</h1>
  ${text ? `<p>${e(text)}</p>` : ""}
  ${card?.detail ? `<div class="detail"><span id="detail">${e(card.detail)}</span><button type="button" id="copy-detail">Copy</button></div>` : ""}
  <div class="actions">
    ${open ? `<a class="btn" id="open" href="${e(open)}">Open in ${e(name)}</a>` : ""}
    <a class="btn${open ? " quiet" : ""}" id="get" href="${e(ios ?? android ?? "/")}">Get ${e(name)}</a>
    <p class="hint" id="hint" hidden>Your link is copied. Open ${e(name)} after it installs and tap Paste.</p>
    <p class="hint" id="other" hidden></p>
  </div>
</main>
<script>
(() => {
  const d = ${data};
  const ua = navigator.userAgent;
  const isIos = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const get = document.getElementById("get");
  const store = isAndroid ? d.android : isIos ? d.ios : null;
  if (store) get.href = store;
  else if (!d.ios && !d.android) get.hidden = true;
  else {
    // A computer: offer both stores instead of guessing.
    get.hidden = true;
    const other = document.getElementById("other");
    other.hidden = false;
    [["iPhone", d.ios], ["Android", d.android]].filter((s) => s[1]).forEach(([label, href], i) => {
      if (i) other.append(" · ");
      const a = document.createElement("a");
      a.href = href;
      a.textContent = label;
      other.append(a);
    });
  }
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } };
  get.addEventListener("click", async (event) => {
    // iPhone has no install referrer: the app's paste button reads this.
    if (!isIos || !d.deferred) return;
    event.preventDefault();
    if (await copy(d.url)) document.getElementById("hint").hidden = false;
    setTimeout(() => { location.href = get.href; }, 600);
  });
  const detail = document.getElementById("copy-detail");
  if (detail) detail.addEventListener("click", async () => {
    if (await copy(document.getElementById("detail").textContent)) detail.textContent = "Copied";
  });
})();
</script>
</body>
</html>`;
}
