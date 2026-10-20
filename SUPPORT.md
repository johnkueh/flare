# Support

A support chat for your apps, like Intercom, on your own Worker. Customers write from a chat
bubble on your site, and you answer from your email or from Claude.

```
your site ── <script src=…/widget.js> ── chat (iframe) ──WebSocket──▶ Conversation DO ──▶ D1 inbox
email replies ── support+…@ (signed) ── Email Routing ──▶ email() ┘        │
Claude ── /mcp (OAuth) ── list, read, reply, note, close, search ───────────┘
                                         replies reach the customer live, or by email
```

One deployment serves every app you list in `APPS`, so all your apps share one inbox, and each
conversation is tagged with its app. Apps stay apart: each has its own signing secret and support
address, and a contact belongs to one app.

## What you get

- **Chat widget.** One script tag. A button opens the chat, which lists the customer's
  conversations and shows replies live. Signed-in users are recognised; visitors who aren't are
  asked for an email after their first message. A badge shows replies they haven't read.
- **Email replies.** When you answer and the customer isn't in the chat, the answer is emailed,
  and their email reply comes back into the same conversation. Each conversation has its own
  signed reply-to address (`support+c.<id>.<sig>@`). Only those addresses take mail: email to a
  plain address starts nothing, so support stays in the chat and your usual inbox stays yours.
- **Notifications you can answer.** When a customer writes, the address in `notify` gets an email.
  Reply to it and your answer goes to the customer.
- **An inbox in Claude.** The Worker is an MCP server. Add `<PUBLIC_URL>/mcp` to claude.ai as a
  custom connector, sign in with your admin key, and Claude can list, read, search and answer
  conversations, add internal notes, close them, and start one by email.
- **Cheap.** One Durable Object per conversation, sleeping between messages. One D1 database for
  the inbox and search.

## Set up

1. Copy `support/wrangler.example.jsonc` to `support/wrangler.jsonc` and fill in `PUBLIC_URL`,
   `routes` and `APPS`.
2. Create the database and the token store, and put their ids in the config:
   ```sh
   cd support && pnpm install
   npx wrangler d1 create flare-support
   npx wrangler kv namespace create OAUTH_KV
   ```
3. Set the secrets. `APP_SECRETS` holds one random secret per app, and the app's own Worker signs
   identity tokens with the same value:
   ```sh
   openssl rand -base64 32 | npx wrangler secret put SUPPORT_SECRET
   openssl rand -base64 24 | tee /dev/stderr | npx wrangler secret put ADMIN_KEY   # keep this: you type it to connect Claude
   echo '{"myapp":"'"$(openssl rand -base64 32)"'"}' | npx wrangler secret put APP_SECRETS
   ```
4. Deploy: `pnpm run deploy` (it applies the D1 migrations first).
5. Email, per app: onboard the app's domain to Cloudflare Email Service so the Worker can send
   from `email` (it can be your own address, e.g. `you@myapp.com`). Replies need a domain whose
   mail Cloudflare receives: turn on Email Routing with subaddressing for it and route the
   `inbound` address (or `email`, if you leave `inbound` out) to this Worker. If the app's domain
   already has a mail host (Google Workspace, say), don't touch its MX records: use a subdomain,
   e.g. `inbound: "support@reply.myapp.com"`, with Email Routing on `reply.myapp.com` only.
6. Claude: in claude.ai, Settings > Connectors > Add custom connector, URL `<PUBLIC_URL>/mcp`.
   Connecting opens a page that asks for the admin key.

## Add the widget to an app

On every page that should show it:

```html
<script src="https://support.myapp.com/widget.js" data-app="myapp" data-token-url="/api/support-token" async></script>
```

- `data-app`: the app's id in `APPS`. The page's origin must be in that app's `origins`.
- `data-token-url` (optional): an endpoint on your app that returns `{ "token": "…" }` for a
  signed-in user and 401 otherwise. Leave it out and everyone chats as a visitor.
- `data-accent` (optional): the button colour before the chat loads. After that it follows `accent`.
- `window.FlareSupport.open()`, `.close()`, `.hide()`, `.show()`, and `.identify(token)` after
  someone signs in without a page load.

The token endpoint, in the app's Worker:

```ts
import { signIdentity } from "@flare/support/token";

// GET /api/support-token
if (!user) return new Response(null, { status: 401 });
return Response.json({
  token: await signIdentity(env.SUPPORT_APP_SECRET, { app: "myapp", sub: user.id, email: user.email, name: user.name, org: team?.name }),
});
```

`SUPPORT_APP_SECRET` is the app's value from `APP_SECRETS`. Install the signer with
`pnpm add "@flare/support@github:johnkueh/flare#<rev>&path:/support"`; it has no dependencies.

Serving the widget from a subdomain of the app (support.myapp.com, as a route on the support
Worker) keeps the chat's storage first-party, so a visitor's conversations survive browsers that
partition third-party storage.

## The MCP tools

| Tool | What it does |
| --- | --- |
| `list_conversations` | Open conversations by default; filter by app, status, or who it waits on |
| `get_conversation` | Every message, with internal notes and who the customer is |
| `reply` | Answer the customer: live in their chat, or by email if they've left |
| `add_note` | A note only the team sees |
| `set_status` | Close or reopen (a customer writing reopens it anyway) |
| `search` | Conversations whose messages contain every word |
| `stats` | Per app: open, waiting on you, and since when |
| `start_conversation` | Email someone first; their reply lands in the inbox |

The admin key also works as a bearer token on `/mcp`, for scripts.

## Develop

```sh
cd support
pnpm test                         # Worker, Durable Object, D1, email and MCP tests in workerd
node scripts/bundle-widget.mjs    # after editing widget/*.js or widget/*.css
```

`wrangler dev` runs it locally with `.dev.vars` holding the three secrets. Email isn't sent
locally; the log says what would have been.
