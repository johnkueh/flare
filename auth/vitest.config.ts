import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { createTestCA } from "./test/attest-ca.ts";

/** One D1 migration from a file of statements separated by blank lines. */
function migration(name: string, path: string) {
  const sql = readFileSync(new URL(path, import.meta.url), "utf8");
  return { name, queries: sql.split(/;\s*\n/).map((q) => q.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean) };
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // Throwaway CAs stand in for Apple's and Google's attestation roots;
      // the Worker trusts their roots and the helpers issue device
      // certificates from them.
      const ca = await createTestCA();
      const androidCA = await createTestCA("Test Android Attestation");
      return {
        wrangler: { configPath: "./test/wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: [
              migration("attest", "./migrations/attest.sql"),
              migration("better_auth", "./migrations/better_auth.sql"),
              migration("test_links", "./test/migrations/test_links.sql"),
            ],
            APP_ATTEST_TEST_ROOT_PEM: ca.rootPem,
            TEST_ATTEST_CA: JSON.stringify(ca),
            ANDROID_ATTEST_TEST_ROOT_PEM: androidCA.rootPem,
            TEST_ANDROID_CA: JSON.stringify(androidCA),
          },
        },
      };
    }),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
