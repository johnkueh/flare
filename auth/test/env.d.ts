import type { D1Migration } from "cloudflare:test";
import type { FlareAuthEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends FlareAuthEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_ATTEST_CA: string;
      TEST_ANDROID_CA: string;
    }
  }
}
