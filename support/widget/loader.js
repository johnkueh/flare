// The support launcher, served as /widget.js. Put it on a page with:
//   <script src="https://support.example.com/widget.js" data-app="myapp" data-token-url="/api/support-token" async></script>
// It draws the chat button and opens the chat (an iframe from the support Worker) above it.
// data-token-url (optional): an endpoint on the app's own origin that answers {token} for a
// signed-in user (see @flare/support/token) and 401 otherwise.
// window.FlareSupport: open(), close(), identify(token) after sign-in, hide() and show() for the button.
(() => {
  if (window.FlareSupport && window.FlareSupport.version) return;
  const script = document.currentScript || document.querySelector('script[src*="/widget.js"][data-app]');
  if (!script) return;
  const base = new URL(script.src).origin;
  const app = script.dataset.app;
  const tokenUrl = script.dataset.tokenUrl;
  // The app's accent arrives from the chat page once it loads; data-accent avoids the first flash.
  const accent = /^#[0-9a-f]{3,8}$/i.test(script.dataset.accent || "") ? script.dataset.accent : "#1b1f1d";
  const position = script.dataset.position === "left" ? "left" : "right";

  let frame = null;
  let ready = false;
  let open = false;
  let hidden = script.dataset.hidden === "true";
  let identity;
  let identityLoaded = !tokenUrl;
  let unread = 0;

  const host = document.createElement("div");
  host.setAttribute("data-flare-support", "");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
  :host{all:initial}
  .btn{position:fixed;bottom:20px;${position}:20px;z-index:2147483000;width:56px;height:56px;border-radius:50%;border:0;padding:0;cursor:pointer;
    background:var(--flare-accent,${accent});color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.18),0 1px 3px rgba(0,0,0,.12);display:grid;place-items:center;transition:transform .15s}
  .btn:hover{transform:scale(1.05)}.btn:focus-visible{outline:3px solid var(--flare-accent,${accent});outline-offset:3px}
  .btn svg{width:26px;height:26px}.btn .x{display:none}.btn.open .chat{display:none}.btn.open .x{display:block}
  .badge{position:absolute;top:-2px;${position === "left" ? "left" : "right"}:-2px;min-width:20px;height:20px;padding:0 5px;box-sizing:border-box;border-radius:10px;background:#dc2626;color:#fff;
    font:600 12px/20px system-ui,-apple-system,sans-serif;text-align:center;display:none}
  .badge.on{display:block}
  .panel{position:fixed;bottom:88px;${position}:20px;z-index:2147483000;width:380px;height:min(640px,calc(100vh - 112px));border-radius:16px;overflow:hidden;
    box-shadow:0 12px 48px rgba(0,0,0,.2),0 2px 6px rgba(0,0,0,.1);background:#fff;opacity:0;transform:translateY(8px);pointer-events:none;transition:opacity .15s,transform .15s}
  .panel.open{opacity:1;transform:none;pointer-events:auto}
  .panel iframe{border:0;width:100%;height:100%;display:block;color-scheme:normal}
  .hidden{display:none}
  @media (max-width:480px){.panel{inset:0;width:100%;height:100%;border-radius:0}.panel.open~.btn{display:none}}
  @media (prefers-reduced-motion:reduce){.btn,.panel{transition:none}}
  </style>
  <div class="panel" part="panel"></div>
  <button class="btn" type="button" aria-label="Open support chat" aria-expanded="false">
    <svg class="chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>
    <svg class="x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    <span class="badge" aria-hidden="true"></span>
  </button>`;
  const panel = root.querySelector(".panel");
  const button = root.querySelector(".btn");
  const badge = root.querySelector(".badge");

  const post = (data) => {
    if (frame && ready) frame.contentWindow.postMessage({ source: "flare-support", ...data }, base);
  };

  const sendIdentity = () => {
    if (identityLoaded) post({ type: "identity", token: identity || null });
  };

  const render = () => {
    button.classList.toggle("open", open);
    button.classList.toggle("hidden", hidden && !open);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Close support chat" : "Open support chat");
    panel.classList.toggle("open", open);
    badge.textContent = unread > 9 ? "9+" : String(unread);
    badge.classList.toggle("on", unread > 0 && !open);
  };

  const ensureFrame = () => {
    if (frame) return;
    frame = document.createElement("iframe");
    frame.title = "Support chat";
    frame.allow = "clipboard-write";
    frame.src = `${base}/chat?app=${encodeURIComponent(app)}`;
    panel.appendChild(frame);
  };

  // Asks the app who is signed in. Runs on page load and again whenever the chat opens, so
  // signing in or out without a page load (single-page apps) is picked up.
  const loadIdentity = async () => {
    if (tokenUrl) {
      try {
        const res = await fetch(tokenUrl, { credentials: "same-origin", headers: { Accept: "application/json" } });
        identity = res.ok ? (await res.json()).token : null;
      } catch {
        identity = null;
      }
      identityLoaded = true;
    }
    sendIdentity();
  };

  const setOpen = (value) => {
    open = value;
    if (open) ensureFrame();
    render();
    post({ type: open ? "opened" : "closed" });
    if (open) loadIdentity();
  };

  window.addEventListener("message", (event) => {
    if (event.origin !== base || !frame || event.source !== frame.contentWindow) return;
    const data = event.data || {};
    if (data.source !== "flare-support") return;
    if (data.type === "ready") {
      ready = true;
      if (/^#[0-9a-f]{3,8}$/i.test(data.accent || "")) host.style.setProperty("--flare-accent", data.accent);
      sendIdentity();
      if (open) post({ type: "opened" });
    } else if (data.type === "close") setOpen(false);
    else if (data.type === "unread") {
      unread = Number(data.count) || 0;
      render();
    }
  });

  button.addEventListener("click", () => setOpen(!open));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) setOpen(false);
  });

  window.FlareSupport = {
    version: 1,
    open: () => setOpen(true),
    close: () => setOpen(false),
    identify: (token) => {
      identity = token || null;
      identityLoaded = true;
      sendIdentity();
    },
    hide: () => {
      hidden = true;
      render();
    },
    show: () => {
      hidden = false;
      render();
    },
  };

  const start = () => {
    document.body.appendChild(host);
    render();
    loadIdentity();
    // Load the chat in the background so replies show as a badge; it makes no requests until
    // there's a conversation to look at.
    (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(ensureFrame);
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
