// The web page's flags: bundled to public/flags.js by `pnpm build:web`.
import { createFlags } from "@flare/flags";

import schema from "../flags.json";

export const flags = createFlags({ server: "", flags: schema, context: { platform: "web" } });

// For the console and the end-to-end test: `flags.all()`, `await flags.refresh()`.
(globalThis as { flags?: unknown }).flags = flags;
