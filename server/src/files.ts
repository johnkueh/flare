// A space's files (photos, videos), kept in R2 under
// `spaces/{spaceId}/{sha256}`. Documents name a file by the hex SHA-256 of
// its bytes in a `blob` field, so a file never changes once written and
// two phones uploading the same one store it once.
//
// The space Durable Object still decides who may read and write: every
// call checks membership with it first. Files written before R2 (PR #126
// kept them in the object's SQLite) are moved here by the space's
// moveFilesToR2(): on a miss here, and by the API's hourly sweep.

import type { Result, SpaceRpc } from "./space";

/** What the Worker serving files needs: a bucket for them. */
export interface FilesEnv {
  SPACE_FILES: R2Bucket;
}

/** Largest file a space keeps. Workers accept request bodies up to 100 MB. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const HASH = /^[0-9a-f]{64}$/;
const BAD_UPLOAD = /sha-?256|checksum|digest|length|size/i;

export function fileKey(spaceId: string, hash: string): string {
  return `spaces/${spaceId}/${hash}`;
}

/** Stores `body` (exactly `size` bytes) as `hash`. R2 checks the bytes
 *  against the hash and refuses a mismatch. */
export async function putFile(
  env: FilesEnv,
  space: SpaceRpc,
  spaceId: string,
  deviceId: string,
  hash: string,
  body: ReadableStream | ArrayBuffer,
  size: number,
  type: string,
): Promise<Result<{ size: number }>> {
  if (!HASH.test(hash)) return { ok: false, error: "INVALID_OPS", reason: "hash" };
  if (!(size >= 0) || size > MAX_FILE_BYTES) return { ok: false, error: "INVALID_OPS", reason: "too large" };
  const member = await space.info(deviceId);
  if (!member.ok) return member;
  const key = fileKey(spaceId, hash);
  if (await env.SPACE_FILES.head(key)) {
    if (!(body instanceof ArrayBuffer)) await body.cancel();
    return { ok: true, size };
  }
  // A stream needs its length up front; R2 checks it and the hash.
  const value = body instanceof ArrayBuffer ? body : body.pipeThrough(new FixedLengthStream(size));
  try {
    await env.SPACE_FILES.put(key, value, {
      sha256: hash,
      httpMetadata: { contentType: type.slice(0, 100) || "application/octet-stream" },
    });
  } catch (error) {
    // The bytes didn't match the hash or the length: the upload is wrong.
    // Anything else is R2's trouble, so it surfaces as a 500 to retry.
    if (BAD_UPLOAD.test(String(error))) return { ok: false, error: "INVALID_OPS", reason: "hash doesn't match" };
    throw error;
  }
  return { ok: true, size };
}

/** The file as a response: immutable, so caches may keep it forever. */
export async function getFile(
  env: FilesEnv,
  space: SpaceRpc,
  spaceId: string,
  deviceId: string,
  hash: string,
): Promise<Result<{ response: Response }>> {
  if (!HASH.test(hash)) return { ok: false, error: "NOT_FOUND" };
  const member = await space.info(deviceId);
  if (!member.ok) return member;
  const key = fileKey(spaceId, hash);
  let object: R2ObjectBody | null = await env.SPACE_FILES.get(key);
  if (!object) {
    // Maybe kept by the space itself, from before R2: move its files over.
    await space.moveFilesToR2();
    object = await env.SPACE_FILES.get(key);
    if (!object) return { ok: false, error: "NOT_FOUND" };
  }
  const headers = new Headers({
    "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "Content-Length": String(object.size),
    "Cache-Control": "private, max-age=31536000, immutable",
    ETag: `"${hash}"`,
  });
  return { ok: true, response: new Response(object.body, { headers }) };
}

/** Deletes every file of a space (when the space itself is deleted). */
export async function deleteFiles(env: FilesEnv, spaceId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.SPACE_FILES.list({ prefix: `spaces/${spaceId}/`, cursor });
    if (page.objects.length) await env.SPACE_FILES.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
