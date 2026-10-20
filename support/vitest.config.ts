import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** One D1 migration from a file of statements separated by `;` at line ends. */
function migration(name: string, path: string) {
  const sql = readFileSync(new URL(path, import.meta.url), "utf8");
  return { name, queries: sql.split(/;\s*\n/).map((q) => q.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean) };
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: [migration("0001_support", "./migrations/0001_support.sql")] } },
    }),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
