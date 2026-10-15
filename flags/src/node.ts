// Keeps a CLI's or a Node server's flags between runs, in a JSON file:
//
//   import { fileStorage } from "@flare/flags/node";
//   createFlags({ server, flags, storage: fileStorage(`${os.homedir()}/.mytool/flags.json`) });

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { FlagStorage } from "./client.ts";

export function fileStorage(path: string): FlagStorage {
  let data: Record<string, string> = {};
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Not there yet.
  }
  return {
    getItem: (k) => data[k] ?? null,
    setItem(k, v) {
      data[k] = v;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(data));
      renameSync(`${path}.tmp`, path);
    },
  };
}
