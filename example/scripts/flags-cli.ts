// A command-line tool reading the same flags as the apps:
//
//   pnpm flags                       the values for this machine, from http://localhost:8787
//   pnpm flags --server <url>        another Worker
//   pnpm flags --watch               and again whenever they change
//
// It keeps the last values in ~/.flare-example/flags.json, so it answers
// offline with what it saw last.

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { createFlags } from "@flare/flags";
import { fileStorage } from "@flare/flags/node";

import schema from "../flags.json" with { type: "json" };

const { values: args } = parseArgs({
  options: { server: { type: "string", default: "http://localhost:8787" }, watch: { type: "boolean", default: false } },
});

const flags = createFlags({
  server: args.server,
  flags: schema,
  storage: fileStorage(join(homedir(), ".flare-example", "flags.json")),
  context: { platform: "cli" },
  refreshInterval: args.watch ? 2000 : 0,
});
await flags.ready;

const print = () => {
  for (const [key, value] of Object.entries(flags.all())) console.log(`${key.padEnd(12)} ${JSON.stringify(value)}`);
  console.log(flags.lastError ? `(offline: ${flags.lastError.message}; last known values)` : `(from ${args.server})`);
};
print();

if (args.watch) {
  flags.subscribe((changed) => {
    flags.activate();
    console.log(`\nchanged: ${changed.join(", ")}`);
    print();
  });
  setInterval(() => {}, 1 << 30); // the refresh timer doesn't keep Node running by itself
}
