// `flare-telemetry symbols` and `flare-telemetry crash`: readable crash
// stacks. The pure parts (Mach-O, R8 mappings, tool output) are in
// src/symbols.ts; this file does the files, R2, Basin SQL and processes.
//
// Symbol files live in the R2 bucket `flare-symbols`:
//   apple/<UUID>                       a dSYM's DWARF file, one key per slice
//   android/<app>/<build>/mapping.txt  R8's mapping for that build number
// and are cached in ~/.cache/flare-symbols once read.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

import {
  formatFrames,
  frameAddress,
  javaFrame,
  machOSlices,
  normalizeUuid,
  parseAtosLine,
  parseMapping,
  parseSymbolizerJson,
  retraceFrame,
} from "../dist/symbols.js";

export const BUCKET = process.env.FLARE_SYMBOLS_BUCKET ?? "flare-symbols";
// The shared Basin warehouse (TELEMETRY.md, "Querying").
const WAREHOUSE = process.env.FLARE_TELEMETRY_WAREHOUSE ?? "YOUR_ACCOUNT_ID_telemetry";
const CACHE = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "flare-symbols");
const APP = /^[a-z][a-z0-9_-]{0,31}$/;
const BUILD = /^[A-Za-z0-9._-]{1,32}$/;

function fail(message) {
  console.error(`flare-telemetry: ${message}`);
  process.exit(1);
}

function wrangler(args, quiet) {
  return spawnSync("npx", ["wrangler", ...args], { stdio: quiet ? "pipe" : ["ignore", "inherit", "inherit"], encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// Upload

/** Mach-O files to upload from an .xcarchive, a .dSYM, a folder of them, or a file. */
function machOFiles(path, depth = 0) {
  const st = statSync(path);
  if (st.isFile()) return [path];
  if (path.endsWith(".dSYM")) {
    const dwarf = join(path, "Contents", "Resources", "DWARF");
    return existsSync(dwarf) ? readdirSync(dwarf).map((n) => join(dwarf, n)) : [];
  }
  if (depth > 4) return [];
  const inside = path.endsWith(".xcarchive") && existsSync(join(path, "dSYMs")) ? join(path, "dSYMs") : path;
  return readdirSync(inside)
    .filter((n) => !n.startsWith("."))
    .flatMap((n) => {
      const child = join(inside, n);
      return statSync(child).isDirectory() ? machOFiles(child, depth + 1) : [];
    });
}

function looksLikeMapping(file) {
  if (extname(file) !== ".txt") return false;
  const head = readFileSync(file, "utf8").slice(0, 4096);
  return /^# compiler: R8/m.test(head) || /^\S+ -> \S+:$/m.test(head);
}

export function upload(args) {
  if (args._.length < 2) fail("pass what the release build left: an .xcarchive, .dSYM or folder (Apple), or mapping.txt with --app and --build (Android)");
  let sent = 0;
  for (const raw of args._.slice(1)) {
    const path = resolve(raw);
    if (!existsSync(path)) fail(`${raw}: not found`);

    if (statSync(path).isFile() && looksLikeMapping(path)) {
      if (!args.app || !APP.test(args.app)) fail("an R8 mapping needs --app <id>");
      if (!args.build || !BUILD.test(args.build)) fail("an R8 mapping needs --build <versionCode> (the app_build crashes report)");
      const key = `android/${args.app}/${args.build}/mapping.txt`;
      console.log(`${raw} -> ${BUCKET}/${key}`);
      if (wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", path, "--remote"]).status !== 0) fail(`uploading ${key} failed`);
      sent++;
      continue;
    }

    for (const file of machOFiles(path)) {
      const slices = machOSlices(new Uint8Array(readFileSync(file)));
      for (const slice of slices) {
        const key = `apple/${slice.uuid}`;
        console.log(`${basename(file)} ${slice.arch} ${slice.uuid} -> ${BUCKET}/${key}`);
        if (wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--remote"]).status !== 0) fail(`uploading ${key} failed`);
        sent++;
      }
    }
  }
  if (sent === 0) fail("found no dSYMs or mapping to upload");
}

// ---------------------------------------------------------------------------
// Finding symbols

function fetchFromR2(key) {
  const dest = join(CACHE, key);
  if (existsSync(dest)) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  const r = wrangler(["r2", "object", "get", `${BUCKET}/${key}`, "--file", dest, "--remote"], true);
  return r.status === 0 && existsSync(dest) ? dest : null;
}

/** On a Mac, Spotlight indexes the dSYMs inside Xcode archives by UUID. */
function findOnThisMac(uuid) {
  if (process.platform !== "darwin") return null;
  const r = spawnSync("mdfind", [`com_apple_xcode_dsym_uuids == ${uuid}`], { encoding: "utf8" });
  for (const dsym of (r.stdout ?? "").split("\n").filter(Boolean)) {
    for (const file of machOFiles(dsym)) {
      if (machOSlices(new Uint8Array(readFileSync(file))).some((s) => s.uuid === uuid)) return file;
    }
  }
  return null;
}

function dsymFor(uuid) {
  const cached = join(CACHE, "apple", uuid);
  if (existsSync(cached)) return cached;
  return findOnThisMac(uuid) ?? fetchFromR2(`apple/${uuid}`);
}

function which(tool) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [tool], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.split("\n")[0].trim();
  if (process.platform === "darwin") {
    const x = spawnSync("xcrun", ["--find", tool], { encoding: "utf8" });
    if (x.status === 0) return x.stdout.trim();
  }
  return null;
}

/** Per address, the frames it stands for (inlined first). atos on a Mac
 *  (it demangles Swift), llvm-symbolizer anywhere else. */
function lookUp(file, arch, addresses) {
  if (process.platform === "darwin" && which("atos")) {
    return addresses.map((address) => {
      const r = spawnSync("atos", ["-arch", arch, "-o", file, "-i", address], { encoding: "utf8" });
      return (r.stdout ?? "").split("\n").map(parseAtosLine).filter(Boolean);
    });
  }
  const symbolizer = which("llvm-symbolizer");
  if (!symbolizer) return null;
  const r = spawnSync(symbolizer, ["--output-style=JSON", "--demangle", `--default-arch=${arch}`, `--obj=${file}`, ...addresses], {
    encoding: "utf8",
  });
  return parseSymbolizerJson(r.stdout ?? "");
}

// ---------------------------------------------------------------------------
// Symbolicating one event

function appleFrames(frames, kind) {
  const out = frames.map((f) => ({
    module: f.module ?? "?",
    function: f.function ?? null,
    fileLine: f.file_line ?? null,
    inApp: f.in_app === true,
  }));
  const byImage = new Map();
  frames.forEach((f, i) => {
    // A Rust panic site is already readable. A symbol the phone found
    // (dladdr) is only the nearest exported one, so the dSYM still wins.
    const uuid = f.image_id ? normalizeUuid(f.image_id) : null;
    if (typeof f.offset === "number" && f.in_app !== true) {
      // The OS's own libraries: no dSYM of ours to find.
      if (!out[i].function) out[i].missing = `+0x${f.offset.toString(16)}`;
      return;
    }
    if (!uuid || typeof f.offset !== "number") {
      if (!out[i].function && !out[i].fileLine && typeof f.offset === "number") out[i].missing = `+0x${f.offset.toString(16)} (no binary UUID)`;
      return;
    }
    if (!byImage.has(uuid)) byImage.set(uuid, []);
    byImage.get(uuid).push(i);
  });

  const expanded = out.map((f) => [f]);
  for (const [uuid, indexes] of byImage) {
    const offsetText = (i) => `+0x${frames[i].offset.toString(16)}`;
    const file = dsymFor(uuid);
    const slice = file && machOSlices(new Uint8Array(readFileSync(file))).find((s) => s.uuid === uuid);
    if (!slice) {
      for (const i of indexes) if (!out[i].function) out[i].missing = `${offsetText(i)} (no dSYM for ${uuid})`;
      continue;
    }
    // A crash's top frame is where it stopped; every other frame, and every
    // frame of a caught error's stack, is a return address.
    const addresses = indexes.map((i) => frameAddress(slice, frames[i].offset, kind === "error" || i > 0));
    const found = lookUp(file, slice.arch, addresses);
    if (!found) {
      for (const i of indexes) if (!out[i].function) out[i].missing = `${offsetText(i)} (install llvm-symbolizer, or run on a Mac)`;
      continue;
    }
    indexes.forEach((i, n) => {
      const names = found[n] ?? [];
      if (names.length === 0) {
        if (!out[i].function) out[i].missing = `${offsetText(i)} (not in the dSYM)`;
        return;
      }
      expanded[i] = names.map((s, k) => ({
        ...out[i],
        function: s.function,
        fileLine: s.fileLine,
        inlined: k < names.length - 1,
      }));
    });
  }
  return expanded.flat();
}

function androidFrames(frames, mapping) {
  return frames.flatMap((f) => {
    const base = { module: f.module ?? "?", function: f.function ?? null, fileLine: f.file_line ?? null, inApp: f.in_app === true };
    const java = mapping && javaFrame(f);
    if (!java) return [base];
    const real = retraceFrame(mapping, java);
    // R8 renamed it, so it's the app's code (or a library shipped in it),
    // even though the phone couldn't tell from the renamed class.
    const renamed = mapping.has(java.className);
    return real.map((r, k) => ({
      ...base,
      module: renamed ? r.className.slice(0, Math.max(0, r.className.lastIndexOf("."))) : base.module,
      inApp: base.inApp || renamed,
      function: `${r.className}.${r.method}`,
      fileLine: r.file ? (r.line !== null ? `${r.file}:${r.line}` : r.file) : null,
      inlined: k < real.length - 1,
    }));
  });
}

/** Readable lines for one crash/hang/error row (or just its params). */
export function describe(row, app) {
  const params = typeof row.params === "string" ? JSON.parse(row.params) : (row.params ?? row);
  const name = row.name ?? "crash";
  const frames = Array.isArray(params.frames) ? params.frames : [];
  const build = params.crashed_build ?? row.app_build ?? null;
  const version = params.crashed_version ?? row.app_version ?? null;
  const notes = [];

  let readable;
  const apple = frames.some((f) => typeof f.offset === "number" && f.image_id);
  if (row.platform === "android" || (!apple && frames.some((f) => f.function && !f.offset))) {
    let mapping = null;
    if (app && build) {
      const file = fetchFromR2(`android/${app}/${build}/mapping.txt`);
      if (file) mapping = parseMapping(readFileSync(file, "utf8"));
      else notes.push(`no R8 mapping for ${app} build ${build}: names are as the app sent them`);
    }
    readable = androidFrames(frames, mapping);
  } else {
    readable = appleFrames(frames, name);
  }

  const lines = [`${name}  ${params.type ?? ""}`.trimEnd()];
  if (params.message) lines.push(params.message);
  const where = [
    version && `${version}${build ? ` (${build})` : ""}`,
    row.platform,
    row.os_version,
    row.device_model,
    row.client_ts && String(row.client_ts).slice(0, 16),
  ].filter(Boolean);
  if (where.length > 0) lines.push(where.join(", "));
  lines.push("", ...formatFrames(readable));
  for (const note of notes) lines.push("", note);
  const crumbs = Array.isArray(params.breadcrumbs) ? params.breadcrumbs : [];
  if (crumbs.length > 0) {
    lines.push("", "Before it (oldest first):");
    for (const c of crumbs) lines.push(`  ${typeof c === "string" ? c : JSON.stringify(c)}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Reading crashes from Basin

async function sql(query) {
  const token = process.env.WRANGLER_BASIN_SQL_AUTH_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!token) fail("set WRANGLER_BASIN_SQL_AUTH_TOKEN or CLOUDFLARE_API_TOKEN (a token that can read the telemetry catalog)");
  const split = WAREHOUSE.indexOf("_");
  const url = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${WAREHOUSE.slice(0, split)}/basin-sql/query/${WAREHOUSE.slice(split + 1)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ warehouse: WAREHOUSE, query }),
  });
  const body = await response.json().catch(() => null);
  if (!body?.success) fail(`Basin SQL: ${body?.errors?.map((e) => e.message).join("; ") ?? `${response.status} ${response.statusText}`}`);
  return body.result?.rows ?? [];
}

export async function crash(args) {
  if (args.file) {
    const row = JSON.parse(readFileSync(resolve(args.file), "utf8"));
    console.log(describe(row, args.app ?? row.app_id).join("\n"));
    return;
  }
  const app = args.app;
  if (!app || !APP.test(app)) fail("pass --app <id> (or --file event.json)");
  const days = Number(args.days ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 90) fail("--days is 1 to 90");
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const env = args.env ?? "prod";
  if (!APP.test(env)) fail("--env is a plain name, e.g. prod");
  const scope = `app_id = '${app}' AND env = '${env}' AND name IN ('crash', 'hang', 'error') AND __ingest_ts >= '${since}'`;

  const fingerprint = args._[1];
  if (!fingerprint) {
    const rows = await sql(
      `SELECT json_get_str(params, 'fingerprint') AS fp, name, json_get_str(params, 'title') AS title,
              COUNT(*) AS n, COUNT(DISTINCT install_id) AS installs
       FROM telemetry.events WHERE ${scope}
       GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 30`,
    );
    if (rows.length === 0) return console.log(`No crashes, hangs or errors for ${app} (${env}) since ${since}.`);
    for (const r of rows) console.log(`${r.fp}  ${String(r.n).padStart(5)} × ${String(r.installs).padStart(4)} installs  ${r.name}  ${r.title}`);
    console.log(`\nflare-telemetry crash <fingerprint> --app ${app}   shows the newest one, readable`);
    return;
  }
  if (!/^[0-9a-f]{16}$/.test(fingerprint)) fail("a fingerprint is 16 hex characters, as the list prints it");
  const rows = await sql(
    `SELECT name, params, platform, app_version, app_build, os_version, device_model, client_ts
     FROM telemetry.events WHERE ${scope} AND json_get_str(params, 'fingerprint') = '${fingerprint}'
     ORDER BY client_ts DESC LIMIT 1`,
  );
  if (rows.length === 0) fail(`no ${fingerprint} for ${app} (${env}) since ${since}; try --days 30`);
  console.log(describe(rows[0], app).join("\n"));
}
