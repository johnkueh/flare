// The /spaces calls (PROTOCOL.md, "HTTP"), with the device already known.
// A Worker authenticates the request its own way (App Attest or
// Android key attestation, say), then calls these with the device id it got.
// Each returns the space's own Result, so the Worker maps refusals onto
// whatever error shape its API uses.

import { lookupCode, parseInviteCode, releaseCode, reserveCode } from "./codes";
import { schemaMismatches, type SyncSchema } from "./schema-check";
import type { NewDevice, Result, SpaceEnv, SpaceObject, SpaceRpc } from "./space";

/** What a Worker serving spaces needs: the space objects and the code
 *  index (`space_codes`, see migrations/space_codes.sql). */
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
  return result;
}

export async function spaceInfo(env: SpacesEnv, spaceId: string, deviceId: string) {
  const space = spaceStub(env, spaceId);
  return space ? space.info(deviceId) : notFound;
}

export async function leaveSpace(env: SpacesEnv, spaceId: string, deviceId: string) {
  const space = spaceStub(env, spaceId);
  if (!space) return notFound;
  const result = await space.leave(deviceId);
  logSpace("space_leave", deviceId, spaceId, result);
  return result;
}

export async function removeDevice(env: SpacesEnv, spaceId: string, deviceId: string, target: string) {
  const space = spaceStub(env, spaceId);
  if (!space) return notFound;
  const result = await space.removeDevice(deviceId, target);
  logSpace("space_remove_device", deviceId, spaceId, result);
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

export async function changes(env: SpacesEnv, spaceId: string, deviceId: string, since: number, limit: number) {
  const space = spaceStub(env, spaceId);
  return space ? space.changes(deviceId, since, limit) : notFound;
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
