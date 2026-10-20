// /widget.js (the launcher a page includes) and /chat (the chat page inside its iframe).

import type { AppConfig } from "./config.ts";
import { CHAT_CSS, CHAT_JS, LOADER_JS } from "./widget-assets.ts";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// JSON inside a <script>: escape what could close the tag or start a comment.
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

const HEX = /^#[0-9a-f]{3,8}$/i;

export function loaderResponse(): Response {
  return new Response(LOADER_JS, {
    headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}

export function chatResponse(appId: string, app: AppConfig): Response {
  const accent = app.accent && HEX.test(app.accent) ? app.accent : "#1b1f1d";
  const config = { app: appId, name: app.name, greeting: app.greeting ?? "", origins: app.origins };
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(app.name)} support</title><style>${CHAT_CSS}:root{--accent:${accent}}</style></head><body>
<header><button id="back" type="button" aria-label="Back" hidden><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
<p class="title" id="title"></p>
<button id="close" type="button" aria-label="Close"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>
<main id="main"></main>
<script>window.__SUPPORT__=${scriptJson(config)};</script><script>${CHAT_JS}</script></body></html>`;
  // Only the app's own pages may frame the chat.
  const ancestors = app.origins.filter((o) => /^https?:\/\/[\w.-]+(:\d+)?$/.test(o)).join(" ") || "'none'";
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors ${ancestors}; base-uri 'none'; form-action 'none'`,
      "Referrer-Policy": "no-referrer",
    },
  });
}
