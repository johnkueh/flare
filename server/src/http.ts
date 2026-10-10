// The two /spaces routes that aren't JSON calls: the live WebSocket and
// files as raw bytes. A Worker calls `spaceHttp` before its own router;
// it answers those paths and returns null for everything else.

import { getFile, MAX_FILE_BYTES, putFile } from "./files";
import { DEVICE_HEADER } from "./space";
import { spaceStub, type SpacesEnv } from "./spaces";

export interface SpaceHttpOptions {
  /** Where the spaces API is mounted, e.g. "/v1". */
  prefix: string;
  /** The device making the request, or the response refusing it. A
   *  WebSocket can't sign its upgrade request, so this is usually a bearer
   *  token check. */
  authenticate(request: Request): Promise<string | Response>;
}

const STATUS = { NOT_FOUND: 404, NOT_MEMBER: 403, NOT_OWNER: 403, FULL: 409, INVALID_OPS: 400 } as const;

/** `{prefix}/spaces/{id}/live` and `{prefix}/spaces/{id}/blobs/{sha256}`. */
export function spaceHttp(request: Request, env: SpacesEnv & { SPACE_FILES: R2Bucket }, options: SpaceHttpOptions): Promise<Response> | null {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(`${options.prefix}/spaces/`)) return null;
  const rest = path.slice(options.prefix.length);
  const live = /^\/spaces\/([^/]+)\/live$/.exec(rest);
  if (live) return openLive(request, env, live[1], options);
  const blob = /^\/spaces\/([^/]+)\/blobs\/([^/]+)$/.exec(rest);
  if (blob) return spaceFile(request, env, blob[1], blob[2], options);
  return null;
}

/** PUT and GET a space's file (a photo): raw bytes in R2. */
async function spaceFile(
  request: Request,
  env: SpacesEnv & { SPACE_FILES: R2Bucket },
  spaceId: string,
  hash: string,
  options: SpaceHttpOptions,
): Promise<Response> {
  const device = await options.authenticate(request);
  if (device instanceof Response) return device;
  const space = spaceStub(env, spaceId);
  if (!space) return Response.json({ code: "NOT_FOUND" }, { status: 404 });

  if (request.method === "PUT") {
    const size = Number(request.headers.get("Content-Length") ?? NaN);
    if (!Number.isFinite(size)) return Response.json({ code: "LENGTH_REQUIRED" }, { status: 411 });
    if (size > MAX_FILE_BYTES) return Response.json({ code: "TOO_LARGE" }, { status: 413 });
    const type = request.headers.get("Content-Type") ?? "application/octet-stream";
    const body = request.body ?? new ArrayBuffer(0);
    const result = await putFile(env, space, spaceId, device, hash, body, size, type);
    if (!result.ok) return Response.json({ code: result.error, reason: result.reason }, { status: STATUS[result.error] });
    return Response.json({ size: result.size });
  }
  if (request.method === "GET") {
    const result = await getFile(env, space, spaceId, device, hash);
    if (!result.ok) return Response.json({ code: result.error }, { status: STATUS[result.error] });
    return result.response;
  }
  return new Response("Method not allowed", { status: 405 });
}

/** Hands the WebSocket to the space once the device checks out. */
async function openLive(request: Request, env: SpacesEnv, spaceId: string, options: SpaceHttpOptions): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const device = await options.authenticate(request);
  if (device instanceof Response) return device;
  const space = spaceStub(env, spaceId);
  if (!space) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.set(DEVICE_HEADER, device);
  return space.fetch(new Request(request.url, { method: "GET", headers }));
}
