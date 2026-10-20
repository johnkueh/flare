// The chat inside the widget's iframe (/chat?app=…). The page embeds its config as
// window.__SUPPORT__ = {app, name, greeting, origins}. It talks to the support Worker's /v1 API on
// this same origin and to the launcher on the host page through postMessage.
(() => {
  const cfg = window.__SUPPORT__;
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // Storage can be blocked in a third-party frame; fall back to memory.
  const memory = {};
  const store = {
    get(k) {
      try {
        return JSON.parse(localStorage.getItem(k));
      } catch {
        return memory[k] ?? null;
      }
    },
    set(k, v) {
      memory[k] = v;
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
    remove(k) {
      delete memory[k];
      try {
        localStorage.removeItem(k);
      } catch {}
    },
  };
  const KEY = `flare-support:${cfg.app}`;
  const SEEN = `flare-support:${cfg.app}:seen`;

  const state = {
    session: null,
    contact: null,
    conversations: [],
    view: "home", // home | thread
    current: null, // conversation id, or "new"
    messages: [],
    socket: null,
    retry: 0,
    opened: false,
    sending: false,
    identityKnown: false,
  };

  // The launcher reports who the visitor is (or that it can't tell) on page load and again each
  // time the chat opens, after asking the page's token endpoint. Wait for that before starting a
  // session, or someone who signed in without a page load would be treated as a visitor.
  let identityArrived;
  let identityReady;
  const awaitIdentity = () => {
    identityReady = new Promise((resolve) => {
      identityArrived = resolve;
    });
  };
  awaitIdentity();

  const parent = (data) => window.parent.postMessage({ source: "flare-support", ...data }, "*");

  const api = async (path, opts = {}) => {
    const res = await fetch(path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(state.session ? { Authorization: `Bearer ${state.session}` } : {}), ...(opts.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { status: res.status });
    return body;
  };

  const subOf = (token) => {
    try {
      return JSON.parse(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"))).sub || null;
    } catch {
      return null;
    }
  };

  async function startSession(identity) {
    const saved = store.get(KEY);
    const body = { app: cfg.app };
    if (identity) body.identity = identity;
    else if (saved?.session && !saved.sub) body.session = saved.session;
    const res = await api("/v1/session", { method: "POST", body: JSON.stringify(body) });
    state.session = res.session;
    state.contact = res.contact;
    store.set(KEY, { session: res.session, sub: identity ? subOf(identity) : null });
  }

  async function onIdentity(token) {
    state.identityKnown = true;
    const before = state.session;
    const saved = store.get(KEY);
    const sub = token ? subOf(token) : null;
    try {
      if (token) {
        if (saved?.session && saved.sub === sub) state.session = saved.session;
        else await startSession(token);
      } else if (saved?.session && !saved.sub) state.session = saved.session;
      else {
        // Signed out (or never here): forget a signed-in user's session.
        if (saved?.sub) store.remove(KEY);
        state.session = null;
      }
      if (state.session) await loadConversations();
    } catch (e) {
      if (e.status === 401) {
        store.remove(KEY);
        state.session = null;
      }
    }
    identityArrived();
    if (state.session !== before) {
      // Someone else now (signed in or out): their conversations, not the last person's.
      disconnect();
      state.view = "home";
      state.current = null;
      render();
    } else if (state.view === "home") render();
  }

  async function loadConversations() {
    const res = await api("/v1/conversations");
    state.contact = res.contact;
    state.conversations = res.conversations;
    reportUnread();
  }

  const seen = () => store.get(SEEN) || {};
  const markSeen = (id, at) => {
    const s = seen();
    if ((s[id] || 0) >= at) return;
    s[id] = at;
    store.set(SEEN, s);
    reportUnread();
  };
  const isUnread = (c) => c.lastAuthor === "agent" && c.lastMessageAt > (seen()[c.id] || 0);
  const reportUnread = () => parent({ type: "unread", count: state.conversations.filter(isUnread).length });

  // --- live thread ---

  function connect(id) {
    disconnect();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/v1/conversations/${id}/ws?session=${encodeURIComponent(state.session)}`);
    state.socket = ws;
    ws.onopen = () => {
      state.retry = 0;
      setStatus("");
    };
    ws.onmessage = (event) => {
      const frame = JSON.parse(event.data);
      if (frame.type === "history") {
        state.messages = frame.messages;
        renderThread();
      } else if (frame.type === "message") {
        if (!state.messages.some((m) => m.id === frame.message.id)) state.messages.push(frame.message);
        renderThread();
      } else if (frame.type === "error" && frame.error === "slow_down") setStatus("You're sending messages very fast. Wait a moment, then try again.");
    };
    ws.onclose = () => {
      if (state.socket !== ws) return;
      state.socket = null;
      if (state.view === "thread" && state.current === id && state.opened) {
        state.retry = Math.min(state.retry + 1, 6);
        setStatus("Reconnecting…");
        setTimeout(() => {
          if (state.view === "thread" && state.current === id && !state.socket) connect(id);
        }, 500 * 2 ** state.retry);
      }
    };
  }

  function disconnect() {
    const ws = state.socket;
    state.socket = null;
    if (ws) ws.close();
  }

  const setStatus = (text) => {
    const s = $("#status");
    if (s) {
      s.textContent = text;
      s.hidden = !text;
    }
  };

  // --- actions ---

  function openThread(id) {
    state.view = "thread";
    state.current = id;
    state.messages = [];
    render();
    if (id !== "new" && state.opened) connect(id);
    setTimeout(() => $("#composer")?.focus(), 0);
  }

  function goHome() {
    disconnect();
    state.view = "home";
    state.current = null;
    render();
    if (state.session) loadConversations().then(render, () => {});
  }

  async function send(text) {
    const body = text.trim();
    if (!body || state.sending) return false;
    if (state.current !== "new") {
      if (!state.socket || state.socket.readyState !== 1) {
        setStatus("Not connected yet. Try again in a moment.");
        return false;
      }
      state.socket.send(JSON.stringify({ type: "send", body }));
      return true;
    }
    state.sending = true;
    try {
      await Promise.race([identityReady, new Promise((r) => setTimeout(r, 5000))]);
      if (!state.session) await startSession(null);
      const res = await api("/v1/conversations", { method: "POST", body: JSON.stringify({ body }) });
      state.current = res.id;
      state.messages = [res.message];
      state.conversations.unshift({ id: res.id, subject: body.slice(0, 80), preview: body, lastAuthor: "customer", status: "open", lastMessageAt: res.message.at });
      renderThread();
      connect(res.id);
      return true;
    } catch {
      setStatus("That didn't send. Check your connection and try again.");
      return false;
    } finally {
      state.sending = false;
    }
  }

  async function saveEmail(email) {
    await api("/v1/contact", { method: "POST", body: JSON.stringify({ email }) });
    state.contact = { ...(state.contact || {}), email };
  }

  // --- rendering ---

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const when = (at) => (new Date(at).toDateString() === new Date().toDateString() ? timeFmt.format(at) : dayFmt.format(at));

  function render() {
    const main = $("#main");
    main.replaceChildren();
    $("#back").hidden = state.view !== "thread";
    $("#title").textContent = cfg.name;
    if (state.view === "home") renderHome(main);
    else renderThreadShell(main);
  }

  function renderHome(main) {
    const intro = el("div", "intro");
    intro.append(el("h1", "", "Hi there"), el("p", "", cfg.greeting || `Ask us anything about ${cfg.name}. We usually reply within a few hours.`));
    const start = el("button", "primary", "Send us a message");
    start.type = "button";
    start.onclick = () => openThread("new");
    intro.append(start);
    main.append(intro);
    if (state.conversations.length) {
      main.append(el("h2", "list-title", "Your conversations"));
      const list = el("ul", "list");
      for (const c of state.conversations) {
        const li = el("li");
        const b = el("button", `row${isUnread(c) ? " unread" : ""}`);
        b.type = "button";
        const top = el("span", "row-top");
        top.append(el("span", "row-subject", c.subject || "Conversation"), el("span", "row-time", when(c.lastMessageAt)));
        b.append(top, el("span", "row-preview", `${c.lastAuthor === "agent" ? "" : "You: "}${c.preview}`));
        b.onclick = () => openThread(c.id);
        li.append(b);
        list.append(li);
      }
      main.append(list);
    }
  }

  function renderThreadShell(main) {
    const log = el("div", "log");
    log.id = "log";
    log.setAttribute("role", "log");
    log.setAttribute("aria-live", "polite");
    const status = el("p", "status");
    status.id = "status";
    status.hidden = true;
    const form = el("form", "compose");
    const input = el("textarea");
    input.id = "composer";
    input.rows = 1;
    input.placeholder = "Write a message…";
    input.setAttribute("aria-label", "Message");
    input.maxLength = 5000;
    const sendBtn = el("button", "send");
    sendBtn.type = "submit";
    sendBtn.setAttribute("aria-label", "Send");
    sendBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    const grow = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    };
    input.oninput = grow;
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = input.value;
      if (await send(text)) {
        input.value = "";
        grow();
      }
    };
    form.append(input, sendBtn);
    main.append(log, status, form);
    renderThread();
  }

  function renderThread() {
    const log = $("#log");
    if (!log) return;
    log.replaceChildren();
    if (state.current === "new" && !state.messages.length) {
      log.append(el("p", "empty", cfg.greeting || `Ask us anything about ${cfg.name}.`));
    }
    for (const m of state.messages) {
      const mine = m.author === "customer";
      const b = el("div", `msg ${mine ? "mine" : "theirs"}`);
      if (!mine) b.append(el("span", "who", m.authorName || cfg.name));
      b.append(el("p", "body", m.body), el("span", "at", when(m.at)));
      log.append(b);
    }
    const last = state.messages[state.messages.length - 1];
    // After their first message, ask an anonymous visitor where to send replies.
    if (last && state.contact && !state.contact.identified && !state.contact.email && state.messages.some((m) => m.author === "customer")) {
      log.append(emailCard());
    }
    log.scrollTop = log.scrollHeight;
    if (last && state.current && state.current !== "new" && state.opened) {
      markSeen(state.current, last.at);
      const c = state.conversations.find((x) => x.id === state.current);
      if (c) Object.assign(c, { lastAuthor: last.author, lastMessageAt: last.at, preview: last.body });
    }
  }

  function emailCard() {
    const card = el("form", "email-card");
    card.append(el("p", "", "Where should we send our reply if you've left?"));
    const row = el("div", "email-row");
    const input = el("input");
    input.type = "email";
    input.required = true;
    input.autocomplete = "email";
    input.placeholder = "you@example.com";
    input.setAttribute("aria-label", "Your email");
    const btn = el("button", "primary small", "Save");
    btn.type = "submit";
    row.append(input, btn);
    card.append(row);
    card.onsubmit = async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        await saveEmail(input.value.trim());
        card.replaceChildren(el("p", "saved", `Thanks. We'll email ${input.value.trim()} if you're not here.`));
      } catch {
        btn.disabled = false;
        input.setCustomValidity("Check this email address.");
        input.reportValidity();
        input.oninput = () => input.setCustomValidity("");
      }
    };
    return card;
  }

  // --- wiring ---

  $("#back").onclick = goHome;
  $("#close").onclick = () => parent({ type: "close" });

  window.addEventListener("message", (event) => {
    if (!cfg.origins.includes(event.origin) || event.source !== window.parent) return;
    const data = event.data || {};
    if (data.source !== "flare-support") return;
    if (data.type === "identity") onIdentity(data.token);
    else if (data.type === "opened") {
      state.opened = true;
      awaitIdentity();
      if (state.view === "thread" && state.current && state.current !== "new" && !state.socket) connect(state.current);
      renderThread();
    } else if (data.type === "closed") {
      state.opened = false;
      // A closed panel holds no connection, so our replies reach them by email instead.
      disconnect();
    }
  });

  render();
  parent({ type: "ready", accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() });
})();
