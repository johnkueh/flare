// Applies every migration to the local D1 that `wrangler dev` uses.
// `node scripts/db-local.mjs --persist-to <dir>` targets another local state.
import { execFileSync } from "node:child_process";
import { MIGRATIONS } from "./migrations.mjs";

const extra = process.argv.slice(2);
for (const file of MIGRATIONS) {
  execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--file", file, ...extra], { stdio: "inherit" });
}
