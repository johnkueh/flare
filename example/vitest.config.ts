import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { MIGRATIONS } from "./scripts/migrations.mjs";

/** One D1 migration from a file of statements. */
function migration(path: string) {
  const sql = readFileSync(new URL(path, import.meta.url), "utf8");
  return { name: path, queries: sql.split(/;\s*\n/).map((q) => q.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean) };
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
          TEST_MIGRATIONS: MIGRATIONS.map(migration),
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
