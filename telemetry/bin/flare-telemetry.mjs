#!/usr/bin/env node
// Opts a project into Flare telemetry and keeps its events.json honest.
//
//   flare-telemetry init --app <id> [--key <k_…>] [--service <worker>]
//       writes events.json, binds your ingest Worker (`flare-telemetry`, or
//       --service <name>) in wrangler.jsonc (as TELEMETRY), and prints the app key line for the
//       Worker's APP_KEYS plus the code to paste. Safe to run again.
//   flare-telemetry check [--file <path>]
//       fails when events.json breaks the naming rules (for CI)
//   flare-telemetry symbols <.xcarchive | .dSYM | folder>...
//   flare-telemetry symbols mapping.txt --app <id> --build <versionCode>
//       uploads a release build's dSYMs or R8 mapping to R2
//   flare-telemetry crash --app <id> [<fingerprint>] [--days 7] [--env prod]
//   flare-telemetry crash --file <event.json> [--app <id>]
//       lists crashes, hangs and errors, or prints the newest of one group
//       with readable frames (bin/symbols.mjs)
//   flare-telemetry gsc --url <telemetry Worker> --from YYYY-MM-DD [--to YYYY-MM-DD] [--site sc-domain:…]
//       backfills Search Console a day at a time through POST /v1/gsc/pull
//       (token in FLARE_GSC_ADMIN_TOKEN); --to defaults to three days ago
//
// The product's iOS and Android apps use the same app id and events.json,
// so every platform lands in one table under one set of names.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { checkEvents } from "../dist/events.js";
import { crash, upload } from "./symbols.mjs";

const APP = /^[a-z][a-z0-9_-]{0,31}$/;

function fail(message) {
  console.error(`flare-telemetry: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (["--app", "--key", "--file", "--build", "--days", "--env", "--service", "--url", "--from", "--to", "--site"].includes(a)) out[a.slice(2)] = argv[++i];
    else if (a === "-h" || a === "--help") out.help = true;
    else out._.push(a);
  }
  return out;
}

function findUp(name, from = process.cwd()) {
  let dir = resolve(from);
  for (let i = 0; i < 5; i++) {
    const f = join(dir, name);
    if (existsSync(f)) return f;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const TEMPLATE = {
  events: {
    signed_up: { description: "An account was created.", params: { method: "email" } },
  },
};

function check(args) {
  const file = args.file ? resolve(args.file) : findUp("events.json");
  if (!file) fail("no events.json here or above; pass --file <path>");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${file}: ${e.message}`);
  }
  const problems = checkEvents(parsed);
  if (problems.length > 0) fail(`${relative(process.cwd(), file)}:\n  ${problems.join("\n  ")}`);
  console.log(`${relative(process.cwd(), file) || file}: ${Object.keys(parsed.events).length} events, all fine`);
}

/** Adds the TELEMETRY service binding after "main" in wrangler.jsonc. Returns what it did. */
function bindWorker(config, service) {
  const text = readFileSync(config, "utf8");
  if (/"binding"\s*:\s*"TELEMETRY"/.test(text)) return "already bound";
  if (/"services"\s*:/.test(text)) return "has a services list: add the TELEMETRY binding to it yourself";
  const main = /^(\s*)"main"\s*:\s*"[^"]*"\s*,?[^\n]*$/m.exec(text);
  if (!main) return 'has no "main" line: add the TELEMETRY binding yourself';
  const indent = main[1].replace(/^\n/, "");
  const line = main[0].trimEnd().endsWith(",") || /,\s*\/\//.test(main[0]) ? main[0] : main[0].replace(/("main"\s*:\s*"[^"]*")/, "$1,");
  const binding = `${indent}// Telemetry: your Flare ingest Worker (see @flare/telemetry).\n${indent}"services": [{ "binding": "TELEMETRY", "service": "${service}" }],`;
  writeFileSync(config, text.replace(main[0], `${line}\n${binding}`));
  return "added the TELEMETRY service binding";
}

function init(args) {
  const app = args.app;
  if (!app || !APP.test(app)) fail("pass --app <id>: the product's app id, lowercase (the same one its phone apps use)");
  const key = args.key ?? `k_${app.replace(/-/g, "_")}_${randomBytes(12).toString("hex")}`;

  const eventsFile = args.file ? resolve(args.file) : join(process.cwd(), "events.json");
  if (existsSync(eventsFile)) console.log(`- ${relative(process.cwd(), eventsFile)}: kept`);
  else {
    writeFileSync(eventsFile, `${JSON.stringify(TEMPLATE, null, 2)}\n`);
    console.log(`- ${relative(process.cwd(), eventsFile)}: written (add your events)`);
  }

  const config = ["wrangler.jsonc", "wrangler.json"].map((n) => join(process.cwd(), n)).find(existsSync);
  if (config) console.log(`- ${relative(process.cwd(), config)}: ${bindWorker(config, args.service ?? "flare-telemetry")}`);
  else console.log("- no wrangler.jsonc here: off Cloudflare, use the Worker's URL as `target` instead of env.TELEMETRY");

  const rel = (p) => `./${relative(process.cwd(), p)}`;
  console.log(`
1. Register the key: in your telemetry Worker's wrangler.jsonc, add to APP_KEYS
     "${key}": "${app}"
   and deploy it. Keys aren't secrets.

2. Browser (once, at startup):
     import { telemetry } from "@flare/telemetry/browser";
     import events from "${rel(eventsFile)}";
     export const t = telemetry({ appId: "${app}", appKey: "${key}", events });
     t.identify(user.id); // after sign-in

3. Worker:
     import { mountEvents, serverTelemetry } from "@flare/telemetry/server";
     if (url.pathname === "/api/events") return mountEvents(request, env.TELEMETRY);
     const telemetry = serverTelemetry({ target: env.TELEMETRY, appId: "${app}", appKey: "${key}", events });
     telemetry.track("signed_up", { method: "email" }, { userId, request, waitUntil: (p) => ctx.waitUntil(p) });

Then \`flare-telemetry check\` in CI keeps events.json valid.`);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Every YYYY-MM-DD from `from` to `to`, inclusive. */
function days(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

async function gsc(args) {
  const token = process.env.FLARE_GSC_ADMIN_TOKEN;
  if (!args.url) fail("pass --url <your telemetry Worker>, e.g. https://flare-telemetry.<you>.workers.dev");
  if (!token) fail("set FLARE_GSC_ADMIN_TOKEN to the Worker's GSC_ADMIN_TOKEN");
  const to = args.to ?? new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  if (!DAY.test(args.from ?? "") || !DAY.test(to)) fail("pass --from YYYY-MM-DD (and optionally --to YYYY-MM-DD)");
  const list = days(args.from, to);
  if (list.length === 0) fail(`--from ${args.from} is after --to ${to}`);
  const endpoint = `${args.url.replace(/\/+$/, "")}/v1/gsc/pull`;
  for (const date of list) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args.site ? { date, site: args.site } : { date }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) fail(`${date}: ${res.status} ${body.error ?? ""}\nStopped; rerun with --from ${date}${args.site ? ` --site ${args.site}` : ""}.`);
    console.log(`${date} ${JSON.stringify(body.written)}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const [command] = args._;
if (args.help || !command) {
  console.log(
    [
      "usage: flare-telemetry init --app <id> [--key <k_…>] [--service <worker>] [--file events.json]",
      "       flare-telemetry check [--file events.json]",
      "       flare-telemetry symbols <.xcarchive | .dSYM | folder>...",
      "       flare-telemetry symbols mapping.txt --app <id> --build <versionCode>",
      "       flare-telemetry crash --app <id> [<fingerprint>] [--days 7] [--env prod]",
      "       flare-telemetry crash --file <event.json> [--app <id>]",
      "       flare-telemetry gsc --url <telemetry Worker> --from YYYY-MM-DD [--to YYYY-MM-DD] [--site sc-domain:…]",
    ].join("\n"),
  );
  process.exit(args.help ? 0 : 1);
}
if (command === "init") init(args);
else if (command === "check") check(args);
else if (command === "symbols") upload(args);
else if (command === "crash") await crash(args);
else if (command === "gsc") await gsc(args);
else fail(`unknown command ${command}`);
