// Files kept by a space object before R2 (PR #126 stored them in its
// SQLite) move to R2 on a read that misses, and by this sweep. Run it from
// the Worker's cron until it reports null.

import { spaceStub, type SpacesEnv } from "./spaces";

/** Marks that every space's files live in R2, so the sweep stops. Delete
 *  the object to run it again. */
export const FILES_MOVED = "maintenance/files-moved-to-r2";

/** Asks every space to move the files it kept itself into R2. Once a sweep
 *  finishes cleanly no space has any left, since new files only ever go
 *  to R2. */
export async function moveAllFilesToR2(
  env: SpacesEnv & { SPACE_FILES: R2Bucket },
): Promise<{ spaces: number; moved: number; failed: number } | null> {
  if (await env.SPACE_FILES.head(FILES_MOVED)) return null;
  const { results } = await env.DB.prepare("SELECT DISTINCT space_id FROM space_codes").all<{ space_id: string }>();
  let moved = 0;
  let failed = 0;
  for (const { space_id } of results) {
    const space = spaceStub(env, space_id);
    if (!space) continue;
    try {
      moved += (await space.moveFilesToR2()).moved;
    } catch (error) {
      failed++;
      console.error(JSON.stringify({ event: "move_files_error", space: space_id, detail: String(error).slice(0, 300) }));
    }
  }
  if (!failed) await env.SPACE_FILES.put(FILES_MOVED, new Date().toISOString());
  console.log(JSON.stringify({ event: "move_files", spaces: results.length, moved, failed }));
  return { spaces: results.length, moved, failed };
}
