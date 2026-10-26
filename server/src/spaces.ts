// The /spaces calls (PROTOCOL.md, "HTTP"), with the caller already known.
// A Worker authenticates the request its own way (@flare/auth's
// `authenticate`, say), then calls these with the member id it got: the
// user, or before accounts the device.
// Each returns the space's own Result, so the Worker maps refusals onto
// whatever error shape its API uses.

import { lookupCode, parseInviteCode, releaseCode, reserveCode } from "./codes";
import type { Write } from "./docs";
import { schemaMismatches, type SyncSchema } from "./schema-check";
import type { NewDevice, Result, SeenDevice, SpaceEnv, SpaceObject, SpaceRpc } from "./space";

/** What a Worker serving spaces needs: the space objects, the code index
 *  (`space_codes`) and the member index (`space_members`); see migrations/. */
export interface SpacesEnv extends SpaceEnv {
  SPACES: DurableObjectNamespace<SpaceObject>;
}

/** The space's Durable Object, or null for an id that can't be one. */
export function spaceStub(env: Pick<SpacesEnv, "SPACES">, spaceId: string): SpaceRpc | null {
  if (!/^[0-9a-f]{64}$/.test(spaceId)) return null;
  try {
    return env.SPACES.get(env.SPACES.idFromString(spaceId)) as unknown as SpaceRpc;
  } catch {
    return null;
  }
}

const notFound = { ok: false, error: "NOT_FOUND" } as const;

export async function createSpace(env: SpacesEnv, device: NewDevice, name: string) {
  const id = env.SPACES.newUniqueId();
  const spaceId = id.toString();
  const code = await reserveCode(env.DB, spaceId);
  const result = await (env.SPACES.get(id) as unknown as SpaceRpc).create(spaceId, name, code, device);
  logSpace("space_create", device.id, spaceId, result);
  if (result.ok) await addMember(env, device.id, spaceId);
  return result;
}

/** What an invite code (as typed, or a link) would join. */
export async function previewInvite(env: SpacesEnv, text: string) {
  const code = parseInviteCode(text);
  const spaceId = code && (await lookupCode(env.DB, code));
  const space = spaceId ? spaceStub(env, spaceId) : null;
  if (!code || !space) return notFound;
  return space.preview(code);
}

export async function joinSpace(env: SpacesEnv, spaceId: string, text: string, device: NewDevice) {
  const code = parseInviteCode(text);
  const space = spaceStub(env, spaceId);
  if (!code || !space) return notFound;
  // The space holds its current code, so it checks the code itself.
  const result = await space.join(code, device);
  logSpace("space_join", device.id, spaceId, result);
  if (result.ok) await addMember(env, device.id, spaceId);
  return result;
}

/** With `device`, lists the phone or browser under the member. */
export async function spaceInfo(env: SpacesEnv, spaceId: string, deviceId: string, device?: SeenDevice) {
  const space = spaceStub(env, spaceId);
  return space ? space.info(deviceId, device) : notFound;
}

export async function leaveSpace(env: SpacesEnv, spaceId: string, deviceId: string) {
  const space = spaceStub(env, spaceId);
  if (!space) return notFound;
  const result = await space.leave(deviceId);
  logSpace("space_leave", deviceId, spaceId, result);
  if (result.ok) await removeMember(env, deviceId, spaceId);
  return result;
}

export async function removeDevice(env: SpacesEnv, spaceId: string, deviceId: string, target: string) {
  const space = spaceStub(env, spaceId);
  if (!space) return notFound;
  const result = await space.removeDevice(deviceId, target);
  logSpace("space_remove_device", deviceId, spaceId, result);
  if (result.ok) await removeMember(env, target, spaceId);
  return result;
}

export async function resetCode(env: SpacesEnv, spaceId: string, deviceId: string) {
  const space = spaceStub(env, spaceId);
  if (!space) return notFound;
  // Reserve the new code first, so it's unique; give it back if the space
  // refuses.
  const code = await reserveCode(env.DB, spaceId);
  const result = await space.resetCode(deviceId, code);
  logSpace("space_reset_code", deviceId, spaceId, result);
  if (!result.ok) {
    await releaseCode(env.DB, code);
    return result;
  }
  await releaseCode(env.DB, result.previous);
  return result;
}

/** Pushes ops. With `schema`, logs (never refuses) ops that don't fit it,
 *  so an app that drifted from the shared list shows up in the logs. */
export async function pushOps(env: SpacesEnv, spaceId: string, deviceId: string, ops: unknown[], schema?: SyncSchema) {
  const space = spaceStub(env, spaceId);
  if (!space) return notFound;
  if (schema) {
    const mismatches = schemaMismatches(schema, ops);
    if (mismatches.length) {
      console.log(JSON.stringify({ event: "space_schema_mismatch", key: deviceId.slice(0, 8), mismatches: mismatches.slice(0, 10) }));
    }
  }
  const result = await space.push(deviceId, ops);
  if (!result.ok && result.error === "INVALID_OPS") {
    console.log(JSON.stringify({ event: "space_push_invalid", key: deviceId.slice(0, 8), reason: result.reason }));
  }
  return result;
}

/** Writes into a space as the server, not a member: for the app's own
 *  triggers and the jobs they start. It skips the membership check, so the
 *  space id must come from a trigger or the app's own records, never from
 *  a request. Each document's writes land after the newest timestamp in
 *  it, so they win over what a phone wrote even when its clock is ahead. */
export async function serverWrite(env: Pick<SpacesEnv, "SPACES">, spaceId: string, writes: Write[]) {
  const space = spaceStub(env, spaceId);
  if (!space) return notFound;
  return space.serverWrite(writes, await serverNode());
}

/** The timestamp node of the server's writes: 16 hex characters of a
 *  fixed SHA-256, worked out on first use (not at startup). */
let node: Promise<string> | null = null;
function serverNode(): Promise<string> {
  node ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode("flare:server"))
    .then((hash) => [...new Uint8Array(hash).subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return node;
}

export async function changes(env: SpacesEnv, spaceId: string, deviceId: string, since: number, limit: number) {
  const space = spaceStub(env, spaceId);
  return space ? space.changes(deviceId, since, limit) : notFound;
}

/** Moves every space `from` is in over to `to`: call it from @flare/auth's
 *  onLinkAccount (an anonymous user signed in to a real account). */
export async function relinkMember(env: SpacesEnv, from: string, to: string) {
  const { results } = await env.DB.prepare("SELECT space_id FROM space_members WHERE member_id = ?")
    .bind(from)
    .all<{ space_id: string }>();
  return relinkSpaces(env, results.map((r) => r.space_id), from, to);
}

/** Moves the given spaces' membership from `from` to `to`. For a device
 *  from before accounts: the app sends the spaces it's in, and the Worker
 *  calls this with the device id the session was attested with. Spaces
 *  `from` isn't an active member of are skipped. */
export async function relinkSpaces(env: SpacesEnv, spaceIds: string[], from: string, to: string) {
  const moved: string[] = [];
  for (const spaceId of spaceIds) {
    const space = spaceStub(env, spaceId);
    const result = space ? await space.relinkMember(from, to) : notFound;
    logSpace("space_relink", from, spaceId, result);
    if (result.ok && result.moved) {
      moved.push(spaceId);
      await addMember(env, to, spaceId);
    }
    await removeMember(env, from, spaceId);
  }
  return { moved };
}

async function addMember(env: SpacesEnv, memberId: string, spaceId: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO space_members (member_id, space_id) VALUES (?, ?)")
    .bind(memberId, spaceId)
    .run();
}

async function removeMember(env: SpacesEnv, memberId: string, spaceId: string) {
  await env.DB.prepare("DELETE FROM space_members WHERE member_id = ? AND space_id = ?").bind(memberId, spaceId).run();
}

function logSpace(event: string, deviceId: string, spaceId: string, result: Result<object>) {
  console.log(
    JSON.stringify({
      event,
      key: deviceId.slice(0, 8),
      space: spaceId.slice(0, 8),
      ok: result.ok,
      error: result.ok ? null : (result.error ?? null),
    }),
  );
}
