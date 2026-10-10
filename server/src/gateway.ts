// SyncGateway: a space member that runs on the server, for clients that
// keep no store of their own (a web page). Export it from the Worker that
// serves the spaces, and bind other Workers to it with a service binding:
//
//   "services": [{ "binding": "SYNC", "service": "my-api", "entrypoint": "SyncGateway" }]
//
// Service bindings are private to the account, so the gateway trusts the
// device id its caller passes: the calling Worker decides who a device is
// (a cookie, a session, whatever suits that app).

import { WorkerEntrypoint } from "cloudflare:workers";
import { lookupCode, parseInviteCode } from "./codes";
import { foldDocs, stampWrites, type Doc, type Write } from "./docs";
import { getFile, type FilesEnv } from "./files";
import {
  DEVICE_HEADER,
  MAX_OPS_PER_PUSH,
  type InvitePreview,
  type NewDevice,
  type Result,
  type SpaceEnv,
  type SpaceInfo,
  type SpaceRpc,
} from "./space";

export type { Doc, Write };

export interface GatewayEnv extends SpaceEnv {
  SPACES: DurableObjectNamespace;
  SPACE_FILES: FilesEnv["SPACE_FILES"];
}

/** The gateway as a caller's binding sees it. Workers' own `Service<>`
 *  typing recurses into `Json` too deeply for tsc (as with SpaceRpc). */
export type GatewayRpc = {
  [K in "preview" | "join" | "info" | "leave" | "read" | "write" | "file"]: (
    ...args: Parameters<SyncGateway[K]>
  ) => ReturnType<SyncGateway[K]>;
} & { fetch(request: Request): Promise<Response> };

/** Header naming the space on a `fetch` (WebSocket) through the gateway. */
export const SPACE_HEADER = "X-Space-Id";

export class SyncGateway extends WorkerEntrypoint<GatewayEnv> {
  /** What an invite code (or link) would join. */
  async preview(text: string): Promise<Result<{ spaceId: string; code: string; preview: InvitePreview }>> {
    const code = parseInviteCode(text);
    const spaceId = code && (await lookupCode(this.env.DB, code));
    const space = spaceId && this.space(spaceId);
    if (!code || !spaceId || !space) return { ok: false, error: "NOT_FOUND" };
    const result = await space.preview(code);
    return result.ok ? { ok: true, spaceId, code, preview: result.preview } : result;
  }

  async join(spaceId: string, code: string, device: NewDevice): Promise<Result<{ info: SpaceInfo }>> {
    const space = this.space(spaceId);
    const parsed = parseInviteCode(code);
    if (!space || !parsed) return { ok: false, error: "NOT_FOUND" };
    return space.join(parsed, device);
  }

  async info(spaceId: string, deviceId: string): Promise<Result<{ info: SpaceInfo }>> {
    const space = this.space(spaceId);
    return space ? space.info(deviceId) : { ok: false, error: "NOT_FOUND" };
  }

  async leave(spaceId: string, deviceId: string): Promise<Result<{ time: number }>> {
    const space = this.space(spaceId);
    return space ? space.leave(deviceId) : { ok: false, error: "NOT_FOUND" };
  }

  /** Every live document in `collection`. `version` is the space's version
   *  it reflects (the live socket's `{"version": N}` past it means re-read). */
  async read(
    spaceId: string,
    deviceId: string,
    collection: string,
    orderBy?: string,
  ): Promise<Result<{ version: number; docs: Doc[] }>> {
    const space = this.space(spaceId);
    if (!space) return { ok: false, error: "NOT_FOUND" };
    const ops = [];
    let since = 0;
    for (;;) {
      const page = await space.changes(deviceId, since, 0);
      if (!page.ok) return page;
      ops.push(...page.ops);
      since = page.version;
      if (!page.more) break;
    }
    return { ok: true, version: since, docs: foldDocs(ops, collection, orderBy) };
  }

  /** Applies writes as this device, stamped with the server's clock. */
  async write(spaceId: string, deviceId: string, writes: Write[]): Promise<Result<{ version: number }>> {
    const space = this.space(spaceId);
    if (!space) return { ok: false, error: "NOT_FOUND" };
    if (!Array.isArray(writes) || writes.length > MAX_OPS_PER_PUSH) {
      return { ok: false, error: "INVALID_OPS", reason: "writes" };
    }
    const result = await space.push(deviceId, stampWrites(writes, await nodeId(deviceId), Date.now()));
    return result.ok ? { ok: true, version: result.version } : result;
  }

  /** A file the space's documents name by hash (a photo), as a
   *  response to hand on: bytes and immutable cache headers, or a JSON
   *  error with its status. */
  async file(spaceId: string, deviceId: string, hash: string): Promise<Response> {
    const space = this.space(spaceId);
    if (!space) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    const result = await getFile(this.env, space, spaceId, deviceId, hash);
    if (result.ok) return result.response;
    return Response.json({ error: result.error }, { status: result.error === "NOT_MEMBER" ? 403 : 404 });
  }

  /** The space's live WebSocket, for the device in DEVICE_HEADER and the
   *  space in SPACE_HEADER. Forward the browser's upgrade request here. */
  override async fetch(request: Request): Promise<Response> {
    const space = this.space(request.headers.get(SPACE_HEADER) ?? "");
    if (!space) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    const headers = new Headers(request.headers);
    headers.set(DEVICE_HEADER, request.headers.get(DEVICE_HEADER) ?? "");
    return space.fetch(new Request(request.url, { headers }));
  }

  private space(spaceId: string): SpaceRpc | null {
    if (!/^[0-9a-f]{64}$/.test(spaceId)) return null;
    try {
      return this.env.SPACES.get(this.env.SPACES.idFromString(spaceId)) as unknown as SpaceRpc;
    } catch {
      return null;
    }
  }
}

/** A device's timestamp node: 16 hex characters of its id's SHA-256. */
async function nodeId(deviceId: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deviceId)));
  return [...hash.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
