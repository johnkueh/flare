#!/usr/bin/env node
// Sets up push for a Flare app's Worker, and sends test notifications.
//
//   flare-push setup     wire this Worker for push; safe to rerun
//   flare-push test      send one notification to a device, from this machine
//
// Run it next to the Worker's wrangler.jsonc. It doesn't set the Worker's
// secrets: it lists them in "secrets.required" and says where each comes
// from, and you set them the way you set your others. test reads them from
// the environment or the Worker's .dev.vars.
//
// setup:
//   --ios <ids>            bundle ids, comma-separated (APNS_TOPICS); the first is the default
//   --android <package>    the Android package name
//   --firebase <project>   the Firebase project id (default: FCM_SERVICE_ACCOUNT's)
//   --google-services <path>  where google-services.json goes (default: android/app/ in the repo)
//   --app <name>           the app's 1Password item, e.g. Cooked (default: the Worker's name);
//                          a new FCM key is saved there as FCM_SERVICE_ACCOUNT
//   --vault <name>         the 1Password vault (default Vault)
//   --op <cmd>             the 1Password CLI (default op)
//   --skip <steps>         any of worker,apple,firebase,secrets, comma-separated
//   --env <name>           a wrangler environment
//   --dry-run              say what would change, change nothing
//
// test:
//   --device <id> | --member <id>   devices from the Worker's D1 (remote)
//   --token <token> --platform ios|android [--sandbox] [--app-id <bundle id>]
//   --key <notification> [--data k=v ...]   render one from notifications.json
//   --title <text> --body <text>            or say it outright

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createSign } from "node:crypto";
import http2 from "node:http2";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addTopLevel, addVar, parseDevVars, parseJsonc } from "./wrangler-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SECRETS = ["APNS_KEY_P8", "APNS_KEY_ID", "APNS_TEAM_ID", "FCM_SERVICE_ACCOUNT"];
const STEPS = ["worker", "apple", "firebase", "secrets"];

function fail(message) {
  console.error(`flare-push: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [], data: [] };
  const valued = ["ios", "android", "firebase", "google-services", "vault", "app", "op", "skip", "env", "device", "member", "token", "platform", "app-id", "key", "title", "body"];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "--sandbox") out[a.slice(2)] = true;
    else if (a === "--data") out.data.push(argv[++i]);
    else if (a.startsWith("--") && valued.includes(a.slice(2))) out[a.slice(2)] = argv[++i];
    else if (a === "-h" || a === "--help") out.help = true;
    else out._.push(a);
  }
  return out;
}

function findUp(name, from = process.cwd()) {
  let dir = resolve(from);
  for (let i = 0; i < 6; i++) {
    const f = join(dir, name);
    if (existsSync(f)) return f;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function step(title) {
  console.log(`\n${title}`);
}
const done = (line) => console.log(`  ✓ ${line}`);
const todo = (line) => console.log(`  → ${line}`);
const skip = (line) => console.log(`  - ${line}`);

// ── wrangler ────────────────────────────────────────────────────────────

function wranglerConfig() {
  const file = ["wrangler.jsonc", "wrangler.json"].map((n) => join(process.cwd(), n)).find(existsSync);
  if (!file) fail(existsSync("wrangler.toml") ? "wrangler.toml isn't supported; use wrangler.jsonc" : "no wrangler.jsonc here");
  const text = readFileSync(file, "utf8");
  return { file, text, config: parseJsonc(text) };
}

/** The config wrangler uses for `--env`, with top-level fallbacks. */
function effective(config, env) {
  return env ? { ...config, ...(config.env?.[env] ?? fail(`no env.${env} in wrangler.jsonc`)) } : config;
}

function wrangler(args, { env, input } = {}) {
  const res = spawnSync("npx", ["--yes", "wrangler", ...args, ...(env ? ["--env", env] : [])], {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const clean = (s) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  return { ok: res.status === 0, out: clean(res.stdout), err: clean(res.stderr) };
}

function stepWorker(args, ctx) {
  step("Worker");
  const { file } = ctx;
  let text = ctx.text;
  const config = effective(ctx.config, args.env);
  if (!config.name) fail(`${file} has no "name"`);
  const queue = `${config.name}-push`;

  const db = (config.d1_databases ?? []).find((d) => d.binding === "DB");
  if (!db) fail(`${file} has no D1 database bound as DB; @flare/push keeps tokens there`);
  done(`D1 database ${db.database_name} (DB)`);

  if (args.env && !ctx.config.env?.[args.env]?.queues && ctx.config.queues) {
    todo(`env.${args.env} doesn't inherit "queues": add the PUSH_QUEUE producer and consumer there by hand`);
  } else if (!config.queues) {
    text = addTopLevel(text, "queues", {
      producers: [{ binding: "PUSH_QUEUE", queue }],
      consumers: [{ queue, max_batch_size: 100, max_retries: 5 }],
    });
    done(`${args["dry-run"] ? "would add" : "added"} the PUSH_QUEUE producer and consumer for ${queue}`);
  } else {
    const producer = config.queues.producers?.find((p) => p.binding === "PUSH_QUEUE");
    const consumer = producer && config.queues.consumers?.find((c) => c.queue === producer.queue);
    if (producer && consumer) done(`queue ${producer.queue} (PUSH_QUEUE, consumed here)`);
    else
      todo(`"queues" is there but without ${producer ? "a consumer for " + producer.queue : "a PUSH_QUEUE producer"}; add:\n` +
        `      producers: { "binding": "PUSH_QUEUE", "queue": "${queue}" }\n` +
        `      consumers: { "queue": "${queue}", "max_batch_size": 100, "max_retries": 5 }`);
  }

  const topics = args.ios ?? config.vars?.APNS_TOPICS;
  if (args.ios && config.vars?.APNS_TOPICS && config.vars.APNS_TOPICS !== args.ios) {
    todo(`vars.APNS_TOPICS is "${config.vars.APNS_TOPICS}", not "${args.ios}"; change it by hand if that's wrong`);
  } else if (args.ios && !config.vars?.APNS_TOPICS) {
    if (args.env) todo(`add "APNS_TOPICS": "${args.ios}" to env.${args.env}.vars`);
    else {
      text = addVar(text, "APNS_TOPICS", args.ios);
      done(`${args["dry-run"] ? "would set" : "set"} vars.APNS_TOPICS to ${args.ios}`);
    }
  } else if (topics) done(`APNS_TOPICS ${topics}`);
  else skip("no iOS bundle ids (pass --ios to send to iOS)");

  if (text !== ctx.text && !args["dry-run"]) writeFileSync(file, text);

  // The table, as a migration next to the app's others.
  const dir = resolve(dirname(file), db.migrations_dir ?? "migrations");
  const sqls = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sql")) : [];
  const has = sqls.find((f) => readFileSync(join(dir, f), "utf8").includes("push_tokens"));
  if (has) done(`migration ${relative(process.cwd(), join(dir, has))}`);
  else {
    const numbered = sqls.map((f) => /^(\d+)_/.exec(f)?.[1]).filter(Boolean);
    const name = numbered.length
      ? `${String(Math.max(...numbered.map(Number)) + 1).padStart(numbered[0].length, "0")}_push_tokens.sql`
      : "push_tokens.sql";
    if (!args["dry-run"]) {
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(here, "../migrations/push_tokens.sql"), join(dir, name));
    }
    done(`${args["dry-run"] ? "would add" : "added"} migration ${relative(process.cwd(), join(dir, name))}`);
    todo(`apply it: wrangler d1 migrations apply ${db.database_name} --remote${args.env ? ` --env ${args.env}` : ""}`);
  }

  if (args["dry-run"]) todo(`would create queue ${queue} if it doesn't exist`);
  else {
    const made = wrangler(["queues", "create", queue]);
    if (made.ok) done(`created queue ${queue}`);
    else if (/already (exists|taken)|11009/i.test(made.err + made.out)) done(`queue ${queue} exists`);
    else todo(`couldn't create queue ${queue}: ${(made.err || made.out).trim().split("\n").find((l) => /error/i.test(l)) ?? made.err.trim()}`);
  }
  return { name: config.name, topics };
}

// ── Apple: the Push capability on each bundle id ─────────────────────────

function ascToken() {
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_FILEPATH, ASC_KEY } = process.env;
  const pem = ASC_KEY ?? (ASC_KEY_FILEPATH && existsSync(ASC_KEY_FILEPATH) ? readFileSync(ASC_KEY_FILEPATH, "utf8") : null);
  if (!ASC_KEY_ID || !ASC_ISSUER_ID || !pem) return null;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: "ES256", kid: ASC_KEY_ID, typ: "JWT" })}.${b64({ iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
  const sig = createSign("SHA256").update(input).sign({ key: pem.replace(/\\n/g, "\n"), dsaEncoding: "ieee-p1363" });
  return `${input}.${sig.toString("base64url")}`;
}

async function asc(token, method, path, body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${json?.errors?.[0]?.detail ?? res.status}`);
  return json;
}

async function stepApple(args, topics) {
  step("Apple");
  if (!topics) return skip("no iOS bundle ids");
  const token = ascToken();
  if (!token) return skip("no App Store Connect key (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_FILEPATH or ASC_KEY): turn on Push Notifications for the bundle id in the developer portal");
  for (const id of topics.split(",").map((t) => t.trim()).filter(Boolean)) {
    const found = await asc(token, "GET", `/v1/bundleIds?filter[identifier]=${encodeURIComponent(id)}&limit=200`);
    const bundle = found.data.find((b) => b.attributes.identifier === id);
    if (!bundle) {
      todo(`${id} isn't registered with Apple yet (Xcode does it on the first signed build); rerun after`);
      continue;
    }
    const caps = await asc(token, "GET", `/v1/bundleIds/${bundle.id}/bundleIdCapabilities`);
    if (caps.data.some((c) => c.attributes.capabilityType === "PUSH_NOTIFICATIONS")) {
      done(`${id} has Push Notifications`);
    } else if (args["dry-run"]) {
      todo(`would turn on Push Notifications for ${id}`);
    } else {
      await asc(token, "POST", "/v1/bundleIdCapabilities", {
        data: {
          type: "bundleIdCapabilities",
          attributes: { capabilityType: "PUSH_NOTIFICATIONS" },
          relationships: { bundleId: { data: { type: "bundleIds", id: bundle.id } } },
        },
      });
      done(`turned on Push Notifications for ${id}`);
    }
  }
  todo("in Xcode, add the Push Notifications capability to the app target (the aps-environment entitlement); automatic signing refreshes the profiles");
}

// ── Firebase: the Android app, google-services.json, the service account key ──

function googleToken() {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) return process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  try {
    return execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function google(token, project, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-goog-user-project": project },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${new URL(url).pathname}: ${json?.error?.message ?? res.status}`);
  return json;
}

async function androidApp(token, project, pkg, dryRun) {
  const base = `https://firebase.googleapis.com/v1beta1/projects/${project}/androidApps`;
  const { apps = [] } = await google(token, project, "GET", `${base}?pageSize=100`);
  const app = apps.find((a) => a.packageName === pkg);
  if (app) return { appId: app.appId, made: false };
  if (dryRun) return { appId: null, made: true };
  let op = await google(token, project, "POST", base, { packageName: pkg, displayName: pkg });
  for (let i = 0; !op.done && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    op = await google(token, project, "GET", `https://firebase.googleapis.com/v1beta1/${op.name}`);
  }
  if (!op.done) throw new Error(`registering ${pkg} in Firebase didn't finish`);
  if (op.error) throw new Error(`registering ${pkg}: ${op.error.message}`);
  return { appId: op.response.appId, made: true };
}

function googleServicesPath(args) {
  if (args["google-services"]) return resolve(args["google-services"]);
  const root = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return process.cwd();
    }
  })();
  for (const dir of ["android/app", "app"]) if (existsSync(join(root, dir, "build.gradle.kts")) || existsSync(join(root, dir, "build.gradle"))) return join(root, dir, "google-services.json");
  return null;
}

const vaultOf = (args) => args.vault ?? "Vault";
const itemOf = (args, ctx) => args.app ?? ctx.name;

/** Saves `value` as field `field` of the app's 1Password item, making the
 *  item if it isn't there. Returns an error message, or null. */
function opSave(args, title, field, value) {
  const op = args.op ?? "op";
  const vault = vaultOf(args);
  const exists = spawnSync(op, ["item", "get", title, "--vault", vault], { stdio: "ignore" }).status === 0;
  const res = exists
    ? spawnSync(op, ["item", "edit", title, "--vault", vault, `${field}[concealed]=${value}`], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] })
    : spawnSync(op, ["item", "create", "--vault", vault, "--format", "json", "-"], {
        input: JSON.stringify({ title, category: "API_CREDENTIAL", fields: [{ id: field, type: "CONCEALED", label: field, value }] }),
        encoding: "utf8",
        stdio: ["pipe", "ignore", "pipe"],
      });
  return res.status === 0 ? null : (res.stderr || `${op} exited ${res.status}`).trim();
}

/** A secret from the environment, the Worker's .dev.vars, or the app's 1Password item. */
function secretValue(args, ctx, name) {
  if (process.env[name]) return process.env[name];
  const dev = devVars();
  if (dev[name]) return dev[name];
  const item = name.startsWith("APNS_") ? "Apple Push" : itemOf(args, ctx);
  const res = spawnSync(args.op ?? "op", ["read", `op://${vaultOf(args)}/${item}/${name}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return res.status === 0 ? res.stdout.trim() : null;
}

function devVars() {
  const file = join(process.cwd(), ".dev.vars");
  return existsSync(file) ? parseDevVars(readFileSync(file, "utf8")) : {};
}

async function stepFirebase(args, ctx) {
  step("Firebase");
  if (!args.android) return skip("no Android package (pass --android to send to Android)");
  let account = null;
  try {
    const saved = secretValue(args, ctx, "FCM_SERVICE_ACCOUNT");
    account = saved ? JSON.parse(saved) : null;
  } catch {
    fail("FCM_SERVICE_ACCOUNT isn't JSON");
  }
  const project = args.firebase ?? account?.project_id;
  if (!project) return todo("pass --firebase <project id> (create the project at console.firebase.google.com first)");
  const token = googleToken();
  if (!token) return todo("sign in with `gcloud auth login` (or set GOOGLE_OAUTH_ACCESS_TOKEN) so I can reach Firebase");

  const { appId, made } = await androidApp(token, project, args.android, args["dry-run"]);
  done(`${made ? (args["dry-run"] ? "would register" : "registered") : "found"} ${args.android} in ${project}`);

  const out = googleServicesPath(args);
  if (!out) todo("pass --google-services <path> to write google-services.json (no android/app here)");
  else if (existsSync(out)) done(`${relative(process.cwd(), out)} is there`);
  else if (args["dry-run"] || !appId) todo(`would write ${relative(process.cwd(), out)}`);
  else {
    const config = await google(token, project, "GET", `https://firebase.googleapis.com/v1beta1/projects/-/androidApps/${appId}/config`);
    writeFileSync(out, Buffer.from(config.configFileContents, "base64"));
    done(`wrote ${relative(process.cwd(), out)} (not a secret: commit it)`);
  }

  if (account) return done(`FCM_SERVICE_ACCOUNT is ${account.client_email}`);
  // No key yet: make one for the project's Firebase Admin service account.
  const { accounts = [] } = await google(token, project, "GET", `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts?pageSize=100`);
  const admin = accounts.find((a) => a.email.startsWith("firebase-adminsdk-"));
  if (!admin) return todo(`${project} has no firebase-adminsdk service account; make a key in Firebase → Project settings → Service accounts`);
  const title = itemOf(args, ctx);
  if (args["dry-run"]) return todo(`would create a key for ${admin.email} and save it as FCM_SERVICE_ACCOUNT in 1Password item "${title}" (${vaultOf(args)})`);
  const key = await google(token, project, "POST", `https://iam.googleapis.com/v1/${admin.name}/keys`, {});
  const json = Buffer.from(key.privateKeyData, "base64").toString("utf8");
  const saved = opSave(args, title, "FCM_SERVICE_ACCOUNT", JSON.stringify(JSON.parse(json)));
  if (saved) {
    // Don't lose it: the key can't be downloaded again.
    const file = join(process.cwd(), "FCM_SERVICE_ACCOUNT.json");
    writeFileSync(file, json, { mode: 0o600 });
    chmodSync(file, 0o600);
    todo(`couldn't save it to 1Password (${saved}); it's in ${file}: store it, then delete the file`);
  } else done(`created a key for ${admin.email} and saved it as FCM_SERVICE_ACCOUNT in "${title}"`);
}

// ── Secrets: listed in wrangler.jsonc, set by you ───────────────────────

function stepSecrets(args, ctx) {
  step("Secrets");
  const config = effective(parseJsonc(readFileSync(ctx.file, "utf8")), args.env);
  const listed = config.secrets?.required ?? [];
  const missing = SECRETS.filter((s) => !listed.includes(s));
  if (missing.length === 0) done(`secrets.required lists ${SECRETS.join(", ")}`);
  else if (config.secrets || args.env) todo(`add ${missing.map((s) => `"${s}"`).join(", ")} to ${args.env ? `env.${args.env}.` : ""}secrets.required`);
  else {
    if (!args["dry-run"]) writeFileSync(ctx.file, addTopLevel(readFileSync(ctx.file, "utf8"), "secrets", { required: SECRETS }));
    done(`${args["dry-run"] ? "would list" : "listed"} the push secrets in secrets.required`);
  }
  const vault = vaultOf(args);
  todo(
    `set them on the Worker (and in .dev.vars for flare-push test), the way you set your others:\n` +
      `      APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID: the team's APNs key, its id and your team id (one for every app; 1Password ${vault} → "Apple Push")\n` +
      `      FCM_SERVICE_ACCOUNT: the Firebase service account JSON (1Password ${vault} → "${itemOf(args, ctx)}")`,
  );
}

async function setup(args) {
  const skips = new Set((args.skip ?? "").split(",").filter(Boolean));
  for (const s of skips) if (!STEPS.includes(s)) fail(`--skip takes ${STEPS.join(", ")}`);
  const ctx = wranglerConfig();
  const config = effective(ctx.config, args.env);
  ctx.name = config.name;
  let topics = args.ios ?? config.vars?.APNS_TOPICS;
  if (args["dry-run"]) console.log("Dry run: nothing changes.");
  if (!skips.has("worker")) topics = stepWorker(args, ctx).topics;
  if (!skips.has("apple")) await stepApple(args, topics);
  if (!skips.has("firebase")) await stepFirebase(args, ctx);
  if (!skips.has("secrets")) stepSecrets(args, ctx);
  console.log("\nThen deploy, and send yourself one: flare-push test --member <your user id>");
}

// ── test ────────────────────────────────────────────────────────────────

/** fetch over HTTP/2, which APNs requires and Node's fetch doesn't speak. */
function h2fetch(url, init = {}) {
  const u = new URL(url);
  return new Promise((resolvePromise, reject) => {
    const client = http2.connect(u.origin);
    client.on("error", reject);
    const req = client.request({ ":method": init.method ?? "GET", ":path": u.pathname + u.search, ...init.headers });
    const chunks = [];
    let head = {};
    req.on("response", (h) => (head = h));
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      client.close();
      const headers = Object.fromEntries(Object.entries(head).filter(([k]) => !k.startsWith(":")).map(([k, v]) => [k, String(v)]));
      const status = head[":status"] ?? 500;
      resolvePromise(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers }));
    });
    req.on("error", (e) => {
      client.close();
      reject(e);
    });
    req.end(init.body);
  });
}

function devicesFromD1(args, config) {
  const [column, id] = args.device ? ["device_id", args.device] : ["member_id", args.member];
  if (!/^[\w.:@-]{1,200}$/.test(id)) fail(`${id} doesn't look like an id`);
  const db = (config.d1_databases ?? []).find((d) => d.binding === "DB");
  if (!db) fail("no D1 database bound as DB in wrangler.jsonc");
  const res = wrangler(["d1", "execute", db.database_name, "--remote", "--json", "--command", `SELECT * FROM push_tokens WHERE ${column} = '${id}'`], { env: args.env });
  if (!res.ok) fail(`reading push_tokens: ${res.err.trim().split("\n").find((l) => /error/i.test(l)) ?? res.err.trim()}`);
  const rows = JSON.parse(res.out.slice(res.out.indexOf("[")))[0]?.results ?? [];
  if (rows.length === 0) fail(`no devices for ${column} ${id} (has the app sent its token? PUT /v1/push/device)`);
  return rows.map((r) => ({ device: r.device_id, platform: r.platform, token: r.token, apnsEnv: r.apns_env ?? undefined, appId: r.app_id ?? undefined, permission: r.permission }));
}

async function test(args) {
  for (const [k, v] of Object.entries(devVars())) process.env[k] ??= v;
  const dist = join(here, "../dist");
  const { sendApns } = await import(join(dist, "apns.js"));
  const { sendFcm } = await import(join(dist, "fcm.js"));
  const { render } = await import(join(dist, "schema.js"));

  const ctx = existsSync("wrangler.jsonc") || existsSync("wrangler.json") ? wranglerConfig() : null;
  const config = ctx ? effective(ctx.config, args.env) : {};
  let targets;
  if (args.token) {
    if (args.platform !== "ios" && args.platform !== "android") fail("--token needs --platform ios or android");
    targets = [{ device: "(token)", platform: args.platform, token: args.token, apnsEnv: args.sandbox ? "sandbox" : "production", appId: args["app-id"] }];
  } else if (args.device || args.member) {
    if (!ctx) fail("no wrangler.jsonc here to find the D1 database; pass --token instead");
    targets = devicesFromD1(args, config);
  } else fail("who to? --member <id>, --device <id> or --token <token> --platform <ios|android>");

  const data = Object.fromEntries(args.data.map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  let title = args.title ?? "Test from flare-push";
  let body = args.body ?? `Sent ${new Date().toLocaleTimeString()}`;
  let spec = {};
  if (args.key) {
    const file = findUp("notifications.json");
    if (!file) fail("no notifications.json here or above");
    spec = JSON.parse(readFileSync(file, "utf8")).notifications?.[args.key] ?? fail(`notifications.json has no "${args.key}"`);
    title = render(spec.title, data);
    body = render(spec.body, data);
  }

  const topics = (config.vars?.APNS_TOPICS ?? process.env.APNS_TOPICS ?? args["app-id"] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  let account = null;
  try {
    account = process.env.FCM_SERVICE_ACCOUNT ? JSON.parse(process.env.FCM_SERVICE_ACCOUNT) : null;
  } catch {
    fail("FCM_SERVICE_ACCOUNT isn't JSON");
  }

  let failed = 0;
  for (const t of targets) {
    const message = {
      v: 1,
      key: args.key ?? "test",
      device: t.device,
      platform: t.platform,
      token: t.token,
      ...(t.apnsEnv && { apnsEnv: t.apnsEnv }),
      ...(t.appId && { appId: t.appId }),
      title,
      body,
      threadId: args.key ?? "test",
      interruption: spec.interruption ?? "active",
      ...(spec.channel && { channel: spec.channel }),
      sound: spec.sound ?? true,
      data,
    };
    let result;
    if (t.platform === "ios") {
      const { APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID } = process.env;
      if (!APNS_KEY_P8 || !APNS_KEY_ID || !APNS_TEAM_ID) result = { status: "failed", reason: "APNS_KEY_P8, APNS_KEY_ID and APNS_TEAM_ID aren't in the environment or .dev.vars" };
      else if (!topics.length) result = { status: "failed", reason: "no bundle id (vars.APNS_TOPICS or --app-id)" };
      else result = await sendApns({ key: APNS_KEY_P8, keyId: APNS_KEY_ID, teamId: APNS_TEAM_ID, topics }, message, { fetch: h2fetch });
    } else if (!account) result = { status: "failed", reason: "FCM_SERVICE_ACCOUNT isn't in the environment or .dev.vars" };
    else result = await sendFcm(account, message);

    const where = `${t.platform}${t.apnsEnv && t.platform === "ios" ? ` ${t.apnsEnv}` : ""} ${t.device}`;
    const note = t.permission && t.permission !== "allowed" ? ` (permission: ${t.permission})` : "";
    if (result.status === "sent") console.log(`✓ ${where}: sent${note}`);
    else {
      failed++;
      const hint =
        result.reason === "BadDeviceToken"
          ? " (a sandbox token sent to production or the other way round? Xcode builds are sandbox)"
          : result.status === "gone"
            ? " (the token is dead; the Worker deletes it on its next send)"
            : /ProviderToken/.test(result.reason)
              ? " (APNS_KEY_P8, APNS_KEY_ID and APNS_TEAM_ID don't belong together)"
              : "";
      console.log(`✗ ${where}: ${result.reason}${hint}`);
    }
  }
  if (failed) process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  if (args.help || !command) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 33).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  if (command === "setup") return setup(args);
  if (command === "test") return test(args);
  fail(`unknown command ${command} (setup or test)`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
