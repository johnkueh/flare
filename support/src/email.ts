// Email in and out. Every message we send carries a signed reply-to address on the app's support
// mailbox, support+c.<conversation>.<sig>@ for customers and support+a.<conversation>.<sig>@ for
// the person answering, so a reply lands back in the right conversation, as the right author.
// Email Routing delivers support+anything@ to the support@ rule (subaddressing), and that rule
// sends it to this Worker's email() handler.

import PostalMime from "postal-mime";
import type { AppConfig, SupportEnv } from "./config.ts";
import { hmac } from "./token.ts";

export type ReplyKind = "c" | "a";

const sig = async (env: SupportEnv, kind: ReplyKind, conversationId: string) => (await hmac(env.SUPPORT_SECRET, `reply.${kind}.${conversationId}`)).slice(0, 16);

/** support+<kind>.<conversation>.<sig>@domain */
export async function replyAddress(env: SupportEnv, app: AppConfig, kind: ReplyKind, conversationId: string): Promise<string | undefined> {
  const address = app.inbound ?? app.email;
  if (!address) return;
  const [local, domain] = address.split("@");
  return `${local}+${kind}.${conversationId}.${await sig(env, kind, conversationId)}@${domain}`;
}

/** The conversation and author a reply-to address names, or null when it isn't one of ours or the signature is wrong. */
export async function parseReplyAddress(env: SupportEnv, address: string): Promise<{ kind: ReplyKind; conversationId: string } | null> {
  const local = address.split("@")[0] ?? "";
  const tag = local.split("+")[1];
  if (!tag) return null;
  const [kind, conversationId, s, extra] = tag.split(".");
  if (!(kind === "c" || kind === "a") || !conversationId || !s || extra !== undefined) return null;
  // Some mail systems lowercase the local part, so compare without case.
  if ((await sig(env, kind, conversationId)).toLowerCase() !== s.toLowerCase()) return null;
  return { kind, conversationId };
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const html = (paragraphs: string[], small?: string) =>
  `<!doctype html><html lang="en"><body style="margin:0"><div style="max-width:560px;padding:16px;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#1b1f1d">${paragraphs
    .map((p) => `<p style="margin:0 0 14px;white-space:pre-wrap">${escape(p)}</p>`)
    .join("")}${small ? `<p style="margin:20px 0 0;color:#6b716d;font-size:13px">${escape(small)}</p>` : ""}</div></body></html>`;

async function send(env: SupportEnv, message: { from: { email: string; name: string }; to: string; replyTo?: string; subject: string; paragraphs: string[]; small?: string; inReplyTo?: string }) {
  // Tests read what would have been sent from here.
  if (env.TEST_OUTBOX) await env.TEST_OUTBOX.put(`${Date.now()}-${crypto.randomUUID()}`, JSON.stringify({ ...message, text: [...message.paragraphs, message.small].join("\n\n") }));
  if (!env.EMAIL) {
    console.log(JSON.stringify({ tag: "support", event: "email_skipped", subject: message.subject }));
    return false;
  }
  const text = [...message.paragraphs, ...(message.small ? [message.small] : [])].join("\n\n");
  try {
    await env.EMAIL.send({
      from: message.from,
      to: message.to,
      subject: message.subject,
      text,
      html: html(message.paragraphs, message.small),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(message.inReplyTo ? { headers: { "In-Reply-To": message.inReplyTo, References: message.inReplyTo } } : {}),
    });
    console.log(JSON.stringify({ tag: "support", event: "email_sent", subject: message.subject }));
    return true;
  } catch (err) {
    console.error(JSON.stringify({ tag: "support", event: "email_failed", subject: message.subject, error: String(err) }));
    return false;
  }
}

const subjectOf = (subject: string, fallback: string) => {
  const s = subject.trim() || fallback;
  return /^re:/i.test(s) ? s : `Re: ${s}`;
};

/** Our reply, emailed to a customer who isn't looking at the chat. */
export async function emailCustomer(
  env: SupportEnv,
  app: AppConfig,
  c: { conversationId: string; to: string; subject: string; body: string; authorName?: string; inReplyTo?: string }
) {
  if (!app.email) return false;
  return send(env, {
    from: { email: app.email, name: c.authorName ? `${c.authorName} at ${app.name}` : app.name },
    to: c.to,
    replyTo: await replyAddress(env, app, "c", c.conversationId),
    subject: subjectOf(c.subject, `Your message to ${app.name}`),
    paragraphs: [c.body],
    small: "Reply to this email to keep the conversation going.",
    inReplyTo: c.inReplyTo,
  });
}

/** Tells whoever answers support that a customer wrote. They can answer by replying to it. */
export async function notifyTeam(env: SupportEnv, app: AppConfig, n: { conversationId: string; from: string; subject: string; body: string; isNew: boolean }) {
  if (!(app.email && app.notify)) return false;
  return send(env, {
    from: { email: app.email, name: `${app.name} support` },
    to: app.notify,
    replyTo: await replyAddress(env, app, "a", n.conversationId),
    subject: `${n.isNew ? "New" : "Re"}: ${n.subject || n.body.slice(0, 60)} (${n.from})`,
    paragraphs: [`${n.from} wrote:`, n.body],
    small: `Reply to this email to answer them, or open the support inbox in Claude. Conversation ${n.conversationId}.`,
  });
}

export type Inbound = { from: string; fromName?: string; to: string; subject: string; body: string; messageId?: string; auto: boolean };

/** The parts of an incoming email we keep: the new text only, without the quoted thread below it. */
export async function parseInbound(raw: ReadableStream | ArrayBuffer | string, envelope: { from: string; to: string }, headers: Headers): Promise<Inbound> {
  const email = await PostalMime.parse(raw);
  const text = email.text ?? (email.html ? htmlToText(email.html) : "");
  const autoSubmitted = headers.get("auto-submitted");
  const precedence = headers.get("precedence")?.toLowerCase();
  return {
    from: (email.from?.address ?? envelope.from).toLowerCase(),
    fromName: email.from?.name || undefined,
    to: envelope.to,
    subject: email.subject ?? "",
    body: stripQuoted(text),
    messageId: email.messageId ?? undefined,
    auto: Boolean((autoSubmitted && autoSubmitted.toLowerCase() !== "no") || precedence === "bulk" || precedence === "auto_reply" || precedence === "list"),
  };
}

const htmlToText = (h: string) =>
  h
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

// The line most mail apps put above the quoted message, and the signature marker.
const QUOTE_HEADERS = [
  /^On .{0,200}wrote:\s*$/,
  /^On .{0,120}$/, // Gmail sometimes wraps "On <date>, <name>" onto two lines
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^_{10,}\s*$/, // Outlook's rule above "From:"
  /^From: .+$/,
  /^Sent from my (iPhone|iPad|Android)/i,
  /^-- $/,
];

/** The reply above the quoted thread. Gmail, Apple Mail and Outlook all put the quote below a header line or `>` lines. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith(">")) break;
    if (QUOTE_HEADERS.some((r) => r.test(line.trim()))) {
      // "On <date>, <name>" is only a quote header if "wrote:" follows on the next line or two.
      if (/^On /.test(line.trim()) && !/wrote:\s*$/.test(line.trim())) {
        const next = [lines[i + 1], lines[i + 2]].map((l) => (l ?? "").trim());
        if (!next.some((l) => /wrote:$/.test(l))) {
          kept.push(line);
          continue;
        }
      }
      break;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}
