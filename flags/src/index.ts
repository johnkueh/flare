// @flare/flags: feature flags on Cloudflare Flagship, typed from flags.json.
//
//   "@flare/flags"          the client (web pages, Node, command-line tools)
//   "@flare/flags/server"   the Worker endpoint and server-side reads
//   "@flare/flags/node"     fileStorage, to keep values between CLI runs

export { createFlags, type FlagStorage, type Flags, type FlagsOptions, type Listener } from "./client.ts";
export type { EvaluationContext, FlagDef, FlagKey, FlagsFile, FlagValue, FlagValues } from "./schema.ts";
