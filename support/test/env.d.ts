import type { D1Migration } from "cloudflare:test";
import type { SupportEnv } from "../src/config";

declare global {
  namespace Cloudflare {
    interface Env extends SupportEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_OUTBOX: KVNamespace;
      PUBLIC_URL: string;
    }
  }
}
