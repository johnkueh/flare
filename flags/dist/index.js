// @flare/flags: feature flags on Cloudflare Flagship, typed from flags.json.
//
//   "@flare/flags"          the client (web pages, Node, command-line tools)
//   "@flare/flags/server"   the Worker endpoint and server-side reads
//   "@flare/flags/node"     fileStorage, to keep values between CLI runs
export { createFlags } from "./client.js";
