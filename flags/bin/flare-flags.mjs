#!/usr/bin/env node
// Keeps a Flagship app in step with flags.json.
//
//   flare-flags sync            create the flags flags.json has and Flagship doesn't
//   flare-flags check           fail when they differ (for CI)
//   flare-flags list            what Flagship has
//   flare-flags set <key> <value> --dev <url>
//                               change a flag's default in a running wrangler dev
//
// Run it next to the Worker's wrangler config: the Flagship app is the
// `flagship` binding's app_id there, and wrangler does the talking (so
// `wrangler login` or CLOUDFLARE_API_TOKEN is all the auth it needs).
//
//   --local | --remote   wrangler's local store (`wrangler dev`) or the real app (default: remote)
//   --app <id>           the Flagship app, instead of the wrangler config's
//   --file <path>        flags.json (default: ./flags.json, else ../flags.json…)
//   --dev <url>          talk to a running `wrangler dev` instead (its local store), e.g. http://localhost:8787

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function fail(message) {
  console.error(`flare-flags: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--local" || a === "--remote") out.where = a.slice(2);
    else if (a === "--app" || a === "--file" || a === "--dev") out[a.slice(2)] = argv[++i];
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

/** JSONC → JSON: drops comments and trailing commas (outside strings). */
function jsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function appId(args) {
  if (args.app) return args.app;
  const config = ["wrangler.jsonc", "wrangler.json"].map((n) => join(process.cwd(), n)).find(existsSync);
  if (!config) fail("no wrangler.jsonc here; pass --app <id>");
  const bindings = jsonc(readFileSync(config, "utf8")).flagship ?? [];
  if (bindings.length === 0) fail(`${config} has no "flagship" binding; pass --app <id>`);
  return bindings[0].app_id;
}

/** flags.json's flags, each with Flagship's type for it. */
function readFlags(args) {
  const file = args.file ? resolve(args.file) : findUp("flags.json");
  if (!file) fail("no flags.json here or above; pass --file <path>");
  const flags = JSON.parse(readFileSync(file, "utf8")).flags;
  if (!flags || typeof flags !== "object") fail(`${file}: expected {"flags": {...}}`);
  return {
    file,
    flags: Object.entries(flags).map(([key, def]) => {
      if (!KEY.test(key)) fail(`${file}: "${key}": keys start with a letter and use letters, digits, - and _ (64 at most)`);
      if (!def || !("default" in def)) fail(`${file}: ${key}: needs a "default"`);
      const d = def.default;
      const kind = def.type ?? (typeof d === "boolean" ? "boolean" : typeof d === "number" ? "number" : typeof d === "string" ? "string" : "object");
      const type = { boolean: "boolean", integer: "number", number: "number", string: "string", object: "json" }[kind];
      if (!type || d === null) fail(`${file}: ${key}: can't tell its type`);
      return { key, def, type };
    }),
  };
}

function wrangler(args, where) {
  const flags = where === "local" ? ["--local"] : ["--remote"];
  try {
    const out = execFileSync("npx", ["--yes", "wrangler", "flagship", "flags", ...args, ...flags, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    return JSON.parse(out.slice(out.indexOf(out.match(/^[{[]/m)?.[0] ?? "{")));
  } catch (e) {
    const err = String(e.stderr ?? e.message).split("\n").find((l) => l.includes("ERROR")) ?? String(e.stderr ?? e.message);
    fail(err.replace(/\x1b\[[0-9;]*m/g, "").trim());
  }
}

// A running `wrangler dev`'s local store, through its local explorer API.
async function dev(base, method, path, body) {
  const res = await fetch(`${base.replace(/\/+$/, "")}/cdn-cgi/local/explorer/api/flagship${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.success === false) fail(`${method} ${path}: ${JSON.stringify(json?.errors ?? res.status)}`);
  return json.result;
}

async function listRemote(args, app) {
  if (args.dev) return dev(args.dev, "GET", `/apps/${app}/flags`);
  const out = wrangler(["list", app, "--all"], args.where);
  return out.items ?? out;
}

/** What `create` needs for a flag: on/off for booleans, else one variation. */
function definition({ key, def, type }) {
  const description = def.description ?? null;
  if (type === "boolean") {
    return { key, description, type, variations: { on: true, off: false }, default_variation: def.default ? "on" : "off", enabled: true, rules: [] };
  }
  return { key, description, type, variations: { default: def.default }, default_variation: "default", enabled: true, rules: [] };
}

async function create(args, app, flag) {
  const d = definition(flag);
  if (args.dev) return dev(args.dev, "POST", `/apps/${app}/flags`, d);
  const argv = ["create", app, flag.key, "--type", flag.type];
  if (flag.type === "boolean") argv.push("--default", d.default_variation);
  else argv.push("--variation", `default=${flag.type === "string" ? flag.def.default : JSON.stringify(flag.def.default)}`, "--default", "default");
  if (d.description) argv.push("--description", d.description);
  return wrangler(argv, args.where);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  if (args.help || !command) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 20).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  const app = appId(args);
  const where = args.dev ? `dev server ${args.dev}` : `${args.where ?? "remote"} app ${app}`;

  if (command === "set") {
    const [, key, raw] = args._;
    if (!args.dev) fail("set works on a running wrangler dev (--dev <url>); use the dashboard or `wrangler flagship flags update` for the real app");
    if (!key || raw === undefined) fail("usage: flare-flags set <key> <value> --dev <url>");
    const flag = (await listRemote(args, app)).find((f) => f.key === key);
    if (!flag) fail(`${key} isn't in the dev store (run flare-flags sync --dev ${args.dev})`);
    let value = raw;
    if (flag.type !== "string") {
      try {
        value = JSON.parse(raw);
      } catch {
        fail(`${raw} isn't a ${flag.type}`);
      }
    }
    const body =
      flag.type === "boolean"
        ? { default_variation: value ? "on" : "off" }
        : { variations: { ...flag.variations, [flag.default_variation]: value } };
    await dev(args.dev, "PATCH", `/apps/${app}/flags/${key}`, body);
    console.log(`${key} = ${JSON.stringify(value)}`);
    return;
  }

  if (command === "list") {
    for (const f of await listRemote(args, app)) {
      console.log(`${f.key}  (${f.type}${f.enabled ? "" : ", disabled"})  default: ${JSON.stringify(f.variations?.[f.default_variation])}`);
    }
    return;
  }

  const { file, flags } = readFlags(args);
  const existing = new Map((await listRemote(args, app)).map((f) => [f.key, f]));

  if (command === "sync") {
    let made = 0;
    for (const flag of flags) {
      if (existing.has(flag.key)) continue;
      await create(args, app, flag);
      console.log(`+ ${flag.key} (${flag.type}, default ${JSON.stringify(flag.def.default)})`);
      made++;
    }
    console.log(made ? `Created ${made} in the ${where}.` : `The ${where} has every flag in ${file}.`);
    return;
  }

  if (command === "check") {
    const problems = [];
    for (const flag of flags) {
      const there = existing.get(flag.key);
      if (!there) problems.push(`${flag.key}: not in Flagship (run flare-flags sync)`);
      else if (there.type && there.type !== flag.type) problems.push(`${flag.key}: Flagship has a ${there.type}, flags.json a ${flag.type}`);
    }
    const known = new Set(flags.map((f) => f.key));
    for (const key of existing.keys()) if (!known.has(key)) console.log(`note: ${key} is in Flagship but not in flags.json`);
    if (problems.length) fail(`the ${where} doesn't match ${file}:\n  ${problems.join("\n  ")}`);
    console.log(`The ${where} matches ${file}.`);
    return;
  }

  fail(`unknown command ${command} (sync, check or list)`);
}

main();
