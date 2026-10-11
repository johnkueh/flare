import { DurableObject } from "cloudflare:workers";
import { releaseSpaceCodes } from "./codes";
import { deleteFiles, fileKey } from "./files";

// One Durable Object per space: the server half of PROTOCOL.md.
// Its SQLite database holds the space's devices and every entry. It knows
// nothing about any app's data: it stores entries by path and compares
// timestamps as strings, nothing else.
//
// The Worker in front authenticates the caller, reserves invite codes in D1,
// and calls the RPC methods below. A member is whoever the Worker says the
// caller is: with @flare/auth that's the signed-in user, so every phone a
// person signs in on is already a member, and the phones themselves are
// listed under them. (Before accounts, a member was one attested device;
// relinkMember() moves such a member to a user.)
// Methods return `{ ok: false, error }` rather than throwing, so error codes
// survive the RPC hop.

// -- wire types -----------------------------------------------------------------

export type Platform = "ios" | "android" | "web" | "other";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One write to one entry path. */
export type Op = { c: string; d: string; f: string; s: string; v: Json; t: string; k?: "parent" };

/** A phone or browser a member has used here, newest first. */
export type MemberDevice = { id: string; name: string; platform: Platform; lastSeen: number };

/** A member. `id` is the user (or, before accounts, the device); `name`
 *  and `platform` are from the device they joined on. */
export type Device = {
  id: string;
  name: string;
  platform: Platform;
  joinedAt: number;
  lastSeen: number;
  devices: MemberDevice[];
};

export type SpaceInfo = {
  spaceId: string;
  name: string;
  code: string;
  owner: string;
  you: string;
  version: number;
  time: number;
  devices: Device[];
};

export type InvitePreview = {
  spaceId: string;
  name: string;
  devices: number;
  collections: Record<string, number>;
  time: number;
};

export type PushResult = { version: number; time: number; corrections: Op[] };
export type ChangesResult = { ops: Op[]; version: number; more: boolean; reset: boolean; time: number };

export type SpaceError = "NOT_FOUND" | "NOT_MEMBER" | "NOT_OWNER" | "FULL" | "INVALID_OPS";
export type Result<T> =
  | ({ ok: true } & T)
  | { ok: false; error: SpaceError; /** INVALID_OPS: which op and why. */ index?: number; reason?: string };

/** Who is creating or joining: the member's id, and the device's name and
 *  platform. `deviceId` names the device itself when it differs from the
 *  member (a user's phone), so it's listed under them. */
export type NewDevice = { id: string; name: string; platform: Platform; deviceId?: string };

/** The device a member is calling from, to list under them. */
export type SeenDevice = { id: string; name?: string; platform?: Platform };

// -- limits -------------------------------------------------------------------------

export const MAX_DEVICES = 12;
export const MAX_OPS_PER_PUSH = 500;
export const MAX_CHANGES_PAGE = 1000;
export const MAX_VALUE_BYTES = 64 * 1024;
const DAY = 24 * 60 * 60 * 1000;
/** How stale a device's `last_seen` may get before a request rewrites it. */
const SEEN_EVERY_MS = 60 * 60 * 1000;

/** Devices not seen for this long are dropped when someone joins. */
export const DEVICE_STALE_MS = 180 * DAY;
/** An empty space's data is deleted this long after the last device leaves. */
export const EMPTY_SPACE_TTL_MS = 30 * DAY;
/** Timestamps further ahead of the server's clock are refused. */
export const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;

export const ZERO_TIMESTAMP = "000000000000000-0000-0000000000000000";
const TIMESTAMP = /^\d{15}-[0-9a-f]{4}-[0-9a-f]{16}$/;
const NAME = /^[A-Za-z0-9_.:-]+$/;
const DELETE_FIELD = "_del";

// -- op validation ------------------------------------------------------------------

/** Checks one op against PROTOCOL.md's rules. Returns the op (with only the
 *  protocol's keys) or why it's malformed. */
export function validateOp(raw: unknown): Op | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "not an object";
  const op = raw as Record<string, unknown>;
  const { c, d, f, s, t, k } = op;
  if (typeof c !== "string" || c.length < 1 || c.length > 64 || !NAME.test(c)) return "bad c";
  if (typeof d !== "string" || d.length < 1 || d.length > 128 || !NAME.test(d)) return "bad d";
  if (typeof f !== "string" || f.length < 1 || f.length > 64 || !NAME.test(f)) return "bad f";
  if (f.startsWith("_") && f !== DELETE_FIELD) return "reserved f";
  if (typeof s !== "string" || [...s].length > 256) return "bad s";
  if (typeof t !== "string" || !TIMESTAMP.test(t)) return "bad t";
  if (!("v" in op) || op.v === undefined) return "missing v";
  const v = op.v as Json;
  const json = JSON.stringify(v);
  if (json === undefined) return "bad v";
  if (new TextEncoder().encode(json).length > MAX_VALUE_BYTES) return "v too large";
  if (f === DELETE_FIELD && (s !== "" || typeof v !== "boolean")) return "bad _del";
  if (k !== undefined && k !== null) {
    if (k !== "parent") return "bad k";
    if (s !== "") return "parent with s";
    if (v !== null && (typeof v !== "string" || v.length < 1 || v.length > 128 || !NAME.test(v))) {
      return "parent v isn't a doc id";
    }
    return { c, d, f, s, v, t, k };
  }
  return { c, d, f, s, v, t };
}

// -- storage ------------------------------------------------------------------------

// Added with accounts; spaces made before get it from the constructor.
const MEMBER_DEVICES = `
CREATE TABLE IF NOT EXISTS member_devices (
  member_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (member_id, device_id)
) WITHOUT ROWID;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  owner TEXT NOT NULL,
  version INTEGER NOT NULL,
  empty_since INTEGER
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  -- active | left | removed | dropped (unseen for 180 days)
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  c TEXT NOT NULL,
  d TEXT NOT NULL,
  f TEXT NOT NULL,
  s TEXT NOT NULL,
  v TEXT NOT NULL,
  t TEXT NOT NULL,
  k TEXT,
  version INTEGER NOT NULL,
  PRIMARY KEY (c, d, f, s)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS entries_version ON entries (version);
${MEMBER_DEVICES}`;

// Spaces made before files moved to R2 kept them in a `blobs` table
// (hash, type, bytes, created_at). moveFilesToR2() empties and drops it.

type Meta = {
  space_id: string;
  name: string;
  code: string;
  owner: string;
  version: number;
  empty_since: number | null;
};
type DeviceRow = { id: string; name: string; platform: string; joined_at: number; last_seen: number; state: string };
type EntryRow = { c: string; d: string; f: string; s: string; v: string; t: string; k: string | null; version: number };

/** What the space needs from the Worker's environment: the D1 database
 *  holding the code index, so a deleted space frees its code, and the
 *  bucket holding its files, so they go with it. */
export interface SpaceEnv {
  DB: D1Database;
  SPACE_FILES?: R2Bucket;
}

/** The RPC methods as a caller sees them through a stub. Workers' own stub
 *  typing recurses into `Json` too deeply for tsc, so callers can use this
 *  instead (the values cross RPC unchanged: they're plain data). */
export type SpaceRpc = {
  [K in
    | "create"
    | "join"
    | "info"
    | "leave"
    | "removeDevice"
    | "resetCode"
    | "relinkMember"
    | "preview"
    | "push"
    | "changes"
    | "moveFilesToR2"]: (
    ...args: Parameters<SpaceObject[K]>
  ) => Promise<ReturnType<SpaceObject[K]>>;
} & { fetch(request: Request): Promise<Response> };

/** Header the Worker sets on the WebSocket upgrade it forwards here, after
 *  authenticating the device. */
export const DEVICE_HEADER = "X-Space-Device";

export class SpaceObject extends DurableObject<SpaceEnv> {
  private sql: SqlStorage;
  private moving: Promise<{ moved: number }> | null = null;

  constructor(ctx: DurableObjectState, env: SpaceEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Tables are created by create(), so ids that were never a space (or
    // whose data was deleted) keep no storage. Spaces from before accounts
    // get the member_devices table here.
    if (this.meta()) this.sql.exec(MEMBER_DEVICES);
  }

  // -- membership -----------------------------------------------------------------

  /** Sets the space up with its first device as owner. */
  create(spaceId: string, name: string, code: string, device: NewDevice): Result<{ info: SpaceInfo }> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(SCHEMA);
      if (!this.meta()) {
        this.sql.exec(
          "INSERT INTO meta (id, space_id, name, code, owner, version, empty_since) VALUES (1, ?, ?, ?, ?, 0, NULL)",
          spaceId,
          name,
          code,
          device.id,
        );
        this.upsertDevice(device, now);
      }
    });
    this.seeDevice(device.id, joinedFrom(device), now);
    return { ok: true, info: this.infoFor(device.id, now) };
  }

  join(code: string, device: NewDevice): Result<{ info: SpaceInfo }> {
    const meta = this.meta();
    if (!meta || meta.code !== code) return { ok: false, error: "NOT_FOUND" };
    const now = Date.now();
    if (this.touch(device.id, now)) {
      this.seeDevice(device.id, joinedFrom(device), now);
      return { ok: true, info: this.infoFor(device.id, now) };
    }

    const full = this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE devices SET state = 'dropped' WHERE state = 'active' AND last_seen < ?",
        now - DEVICE_STALE_MS,
      );
      // A dropped owner is handed off even when the space turns out full.
      this.fixOwner();
      if (this.activeCount() >= MAX_DEVICES) return true;
      this.upsertDevice(device, now);
      if (meta.empty_since !== null) this.sql.exec("UPDATE meta SET empty_since = NULL");
      // Joining an emptied space: the first one back owns it.
      this.fixOwner();
      return false;
    });
    if (full) return { ok: false, error: "FULL" };
    if (meta.empty_since !== null) this.ctx.storage.deleteAlarm();
    this.seeDevice(device.id, joinedFrom(device), now);
    return { ok: true, info: this.infoFor(device.id, now) };
  }

  /** With `device`, also lists that device under the member (a phone the
   *  person just signed in on never joined, so this is where it shows up). */
  info(deviceId: string, device?: SeenDevice): Result<{ info: SpaceInfo }> {
    const now = Date.now();
    const denied = this.memberCheck(deviceId, now);
    if (denied) return denied;
    if (device) this.seeDevice(deviceId, device, now);
    return { ok: true, info: this.infoFor(deviceId, now) };
  }

  leave(deviceId: string): Result<{ time: number }> {
    const now = Date.now();
    const denied = this.memberCheck(deviceId, now);
    if (denied) return denied;
    this.depart(deviceId, "left", now);
    return { ok: true, time: now };
  }

  /** Owner only. Removing yourself is leaving. Removing a device that isn't
   *  an active member changes nothing. */
  removeDevice(deviceId: string, target: string): Result<{ time: number }> {
    const now = Date.now();
    const denied = this.memberCheck(deviceId, now) ?? this.ownerCheck(deviceId);
    if (denied) return denied;
    if (target === deviceId) this.depart(deviceId, "left", now);
    else if (this.isActive(target)) this.depart(target, "removed", now);
    return { ok: true, time: now };
  }

  /** Owner only. The Worker has already reserved `code` in the index and
   *  releases `previous` once this succeeds. */
  resetCode(deviceId: string, code: string): Result<{ code: string; previous: string; time: number }> {
    const now = Date.now();
    const denied = this.memberCheck(deviceId, now) ?? this.ownerCheck(deviceId);
    if (denied) return denied;
    const previous = this.meta()!.code;
    this.sql.exec("UPDATE meta SET code = ?", code);
    return { ok: true, code, previous, time: now };
  }

  /** Moves membership from `from` to `to`: an anonymous user who signed in
   *  to a real account, or a device from before accounts moving to its
   *  user. Ownership and listed devices move too. If `to` is already a
   *  member, `from` simply leaves. Nothing happens when `from` isn't an
   *  active member. */
  relinkMember(from: string, to: string): Result<{ moved: boolean }> {
    const now = Date.now();
    if (!this.meta()) return { ok: false, error: "NOT_FOUND" };
    if (from === to || !this.isActive(from)) return { ok: true, moved: false };
    this.ctx.storage.transactionSync(() => {
      if (this.isActive(to)) {
        this.sql.exec("UPDATE devices SET state = 'left' WHERE id = ?", from);
      } else {
        this.sql.exec("DELETE FROM devices WHERE id = ?", to);
        this.sql.exec("UPDATE devices SET id = ?, last_seen = ? WHERE id = ?", to, now, from);
      }
      this.sql.exec(
        `INSERT INTO member_devices (member_id, device_id, name, platform, last_seen)
         SELECT ?, device_id, name, platform, last_seen FROM member_devices WHERE member_id = ?
         ON CONFLICT (member_id, device_id) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)`,
        to,
        from,
      );
      this.sql.exec("DELETE FROM member_devices WHERE member_id = ?", from);
      if (this.meta()!.owner === from) this.sql.exec("UPDATE meta SET owner = ?", to);
      this.fixOwner();
    });
    // Its open sockets were tagged with the old id; the app reconnects.
    for (const ws of this.ctx.getWebSockets(from)) {
      try {
        ws.close(1012, "relinked");
      } catch {
        // Already closed.
      }
    }
    return { ok: true, moved: true };
  }

  // -- files ----------------------------------------------------------------------

  /** Moves the files this space kept itself, from before R2, into R2 and
   *  drops their table, so files live only in R2. Safe to call any time:
   *  it does nothing once they're gone. */
  moveFilesToR2(): Promise<{ moved: number }> {
    // R2 calls let other requests in; they share the one run.
    this.moving ??= this.moveFiles().finally(() => (this.moving = null));
    return this.moving;
  }

  private async moveFiles(): Promise<{ moved: number }> {
    const table = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blobs'").toArray();
    if (!table.length) return { moved: 0 };
    const bucket = this.env.SPACE_FILES;
    if (!bucket) throw new Error("SPACE_FILES isn't bound");
    const meta = this.meta();
    let moved = 0;
    for (;;) {
      // A few at a time: each row can be nearly 2 MB.
      const rows = this.sql
        .exec<{ hash: string; type: string; bytes: ArrayBuffer }>("SELECT hash, type, bytes FROM blobs LIMIT 8")
        .toArray();
      if (!rows.length) break;
      for (const row of rows) {
        if (meta) {
          await bucket.put(fileKey(meta.space_id, row.hash), row.bytes, {
            sha256: row.hash,
            httpMetadata: { contentType: row.type },
          });
        }
        this.sql.exec("DELETE FROM blobs WHERE hash = ?", row.hash);
        moved++;
      }
    }
    this.sql.exec("DROP TABLE IF EXISTS blobs");
    return { moved };
  }

  /** For GET /invites/{code}: anyone holding the current code may look. */
  preview(code: string): Result<{ preview: InvitePreview }> {
    const meta = this.meta();
    if (!meta || meta.code !== code) return { ok: false, error: "NOT_FOUND" };
    // A doc is deleted while its `_del` entry is true and newer than every
    // other entry in it.
    const rows = this.sql
      .exec<{ c: string; n: number }>(
        `SELECT c, COUNT(*) AS n FROM (
           SELECT c, d,
             MAX(CASE WHEN f = '${DELETE_FIELD}' THEN NULL ELSE t END) AS other_t,
             MAX(CASE WHEN f = '${DELETE_FIELD}' AND v = 'true' THEN t END) AS del_t
           FROM entries GROUP BY c, d
         )
         WHERE del_t IS NULL OR (other_t IS NOT NULL AND other_t >= del_t)
         GROUP BY c ORDER BY c`,
      )
      .toArray();
    const collections: Record<string, number> = {};
    for (const row of rows) collections[row.c] = row.n;
    return {
      ok: true,
      preview: { spaceId: meta.space_id, name: meta.name, devices: this.activeCount(), collections, time: Date.now() },
    };
  }

  // -- sync -------------------------------------------------------------------------

  push(deviceId: string, rawOps: unknown): Result<PushResult> {
    const now = Date.now();
    const denied = this.memberCheck(deviceId, now);
    if (denied) return denied;

    // Every op is checked before any is applied.
    if (!Array.isArray(rawOps)) return { ok: false, error: "INVALID_OPS", reason: "ops isn't an array" };
    if (rawOps.length > MAX_OPS_PER_PUSH) {
      return { ok: false, error: "INVALID_OPS", reason: `more than ${MAX_OPS_PER_PUSH} ops` };
    }
    const ops: Op[] = [];
    for (const [index, raw] of rawOps.entries()) {
      const op = validateOp(raw);
      if (typeof op === "string") return { ok: false, error: "INVALID_OPS", index, reason: op };
      ops.push(op);
    }

    const latest = String(now + MAX_CLOCK_SKEW_MS).padStart(15, "0");
    const { version, changed, corrections } = this.ctx.storage.transactionSync(() => {
      let version = this.meta()!.version;
      const start = version;
      const corrections: Op[] = [];
      for (const op of ops) {
        const current = this.entry(op.c, op.d, op.f, op.s);
        if (op.t.slice(0, 15) > latest || (op.k === "parent" && this.makesLoop(op))) {
          corrections.push(current ? toOp(current) : zeroOp(op));
          continue;
        }
        // At each path the strictly larger timestamp wins.
        if (current && !(op.t > current.t)) continue;
        version += 1;
        this.sql.exec(
          `INSERT INTO entries (c, d, f, s, v, t, k, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (c, d, f, s) DO UPDATE SET
             v = excluded.v, t = excluded.t, k = excluded.k, version = excluded.version`,
          op.c,
          op.d,
          op.f,
          op.s,
          JSON.stringify(op.v),
          op.t,
          op.k ?? null,
          version,
        );
      }
      if (version !== start) this.sql.exec("UPDATE meta SET version = ?", version);
      return { version, changed: version !== start, corrections };
    });

    if (changed) this.broadcast(version);
    return { ok: true, version, time: now, corrections };
  }

  changes(deviceId: string, since: number, limit: number): Result<ChangesResult> {
    const now = Date.now();
    const denied = this.memberCheck(deviceId, now);
    if (denied) return denied;
    const current = this.meta()!.version;
    const pageSize = Math.max(1, Math.min(MAX_CHANGES_PAGE, Math.floor(limit) || MAX_CHANGES_PAGE));
    // A cursor ahead of the server means the space was rebuilt: start over.
    const reset = since > current;
    const from = reset ? 0 : Math.max(0, Math.floor(since));
    const rows = this.sql
      .exec<EntryRow>(
        "SELECT c, d, f, s, v, t, k, version FROM entries WHERE version > ? ORDER BY version LIMIT ?",
        from,
        pageSize + 1,
      )
      .toArray();
    const more = rows.length > pageSize;
    const page = more ? rows.slice(0, pageSize) : rows;
    return {
      ok: true,
      ops: page.map(toOp),
      version: page.length ? page[page.length - 1].version : current,
      more,
      reset,
      time: now,
    };
  }

  // -- live updates -----------------------------------------------------------------

  /** The WebSocket upgrade, forwarded by the Worker with the authenticated
   *  device id in DEVICE_HEADER. Sends `{"version": N}` after each push that
   *  changed something; nothing else either way. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const deviceId = request.headers.get(DEVICE_HEADER) ?? "";
    if (!this.meta()) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    if (!this.touch(deviceId, Date.now())) return Response.json({ code: "NOT_MEMBER" }, { status: 403 });
    const pair = new WebSocketPair();
    // Tagged with the device, so leaving or removal closes its sockets.
    this.ctx.acceptWebSocket(pair[1], [deviceId]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override webSocketMessage() {
    // Clients send nothing; anything they do send is ignored.
  }

  override webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // Already closed.
    }
  }

  /** Deletes an emptied space's data once it has been empty long enough. */
  override async alarm() {
    const meta = this.meta();
    if (!meta || meta.empty_since === null || this.activeCount() > 0) return;
    const due = meta.empty_since + EMPTY_SPACE_TTL_MS;
    if (Date.now() < due) {
      await this.ctx.storage.setAlarm(due);
      return;
    }
    await releaseSpaceCodes(this.env.DB, meta.space_id);
    if (this.env.SPACE_FILES) await deleteFiles({ SPACE_FILES: this.env.SPACE_FILES }, meta.space_id);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // -- helpers ----------------------------------------------------------------------

  private meta(): Meta | null {
    const table = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray();
    if (!table.length) return null;
    return (
      this.sql
        .exec<Meta>("SELECT space_id, name, code, owner, version, empty_since FROM meta WHERE id = 1")
        .toArray()[0] ?? null
    );
  }

  private isActive(deviceId: string): boolean {
    return this.sql.exec("SELECT 1 FROM devices WHERE id = ? AND state = 'active'", deviceId).toArray().length > 0;
  }

  /** Marks an active member as seen. False when it isn't one. Writes at
   *  most once an hour per device: row writes are what a space costs, and
   *  `last_seen` only has to be good enough to drop devices after 180 days. */
  private touch(deviceId: string, now: number): boolean {
    if (!this.meta()) return false;
    const wrote = this.sql.exec(
      "UPDATE devices SET last_seen = ? WHERE id = ? AND state = 'active' AND last_seen <= ?",
      now,
      deviceId,
      now - SEEN_EVERY_MS,
    ).rowsWritten;
    return wrote > 0 || this.isActive(deviceId);
  }

  private memberCheck(deviceId: string, now: number): { ok: false; error: SpaceError } | null {
    if (!this.meta()) return { ok: false, error: "NOT_FOUND" };
    return this.touch(deviceId, now) ? null : { ok: false, error: "NOT_MEMBER" };
  }

  private ownerCheck(deviceId: string): { ok: false; error: SpaceError } | null {
    return this.meta()!.owner === deviceId ? null : { ok: false, error: "NOT_OWNER" };
  }

  private activeCount(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE state = 'active'").one().n;
  }

  /** (Re)joins as an active member, joined now. */
  private upsertDevice(device: NewDevice, now: number) {
    this.sql.exec(
      `INSERT INTO devices (id, name, platform, joined_at, last_seen, state) VALUES (?, ?, ?, ?, ?, 'active')
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name, platform = excluded.platform, joined_at = excluded.joined_at,
         last_seen = excluded.last_seen, state = 'active'`,
      device.id,
      device.name,
      device.platform,
      now,
      now,
    );
  }

  /** Lists `device` under `memberId`, or marks it seen. Writes at most once
   *  an hour per device unless its name changed, like touch(). */
  private seeDevice(memberId: string, device: SeenDevice | null, now: number) {
    if (!device) return;
    this.sql.exec(
      `INSERT INTO member_devices (member_id, device_id, name, platform, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (member_id, device_id) DO UPDATE SET
         name = excluded.name, platform = excluded.platform, last_seen = excluded.last_seen
       WHERE member_devices.last_seen <= ? OR member_devices.name != excluded.name`,
      memberId,
      device.id,
      device.name ?? "",
      device.platform ?? "other",
      now,
      now - SEEN_EVERY_MS,
    );
  }

  /** If the owner is no longer active, the earliest-joined active device
   *  takes over. With none, the owner stays as it was. */
  private fixOwner() {
    const meta = this.meta()!;
    if (this.isActive(meta.owner)) return;
    const next = this.sql
      .exec<{ id: string }>("SELECT id FROM devices WHERE state = 'active' ORDER BY joined_at, id LIMIT 1")
      .toArray()[0];
    if (next) this.sql.exec("UPDATE meta SET owner = ?", next.id);
  }

  private depart(deviceId: string, state: "left" | "removed", now: number) {
    const emptied = this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE devices SET state = ? WHERE id = ?", state, deviceId);
      this.fixOwner();
      if (this.activeCount() > 0) return false;
      this.sql.exec("UPDATE meta SET empty_since = ?", now);
      return true;
    });
    for (const ws of this.ctx.getWebSockets(deviceId)) {
      try {
        ws.close(1000, state);
      } catch {
        // Already closed.
      }
    }
    if (emptied) void this.ctx.storage.setAlarm(now + EMPTY_SPACE_TTL_MS);
  }

  private infoFor(deviceId: string, now: number): SpaceInfo {
    const meta = this.meta()!;
    const devices = this.sql
      .exec<DeviceRow>(
        "SELECT id, name, platform, joined_at, last_seen, state FROM devices WHERE state = 'active' ORDER BY joined_at, id",
      )
      .toArray()
      .map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform as Platform,
        joinedAt: d.joined_at,
        lastSeen: d.last_seen,
        devices: this.sql
          .exec<{ device_id: string; name: string; platform: string; last_seen: number }>(
            "SELECT device_id, name, platform, last_seen FROM member_devices WHERE member_id = ? ORDER BY last_seen DESC",
            d.id,
          )
          .toArray()
          .map((m) => ({ id: m.device_id, name: m.name, platform: m.platform as Platform, lastSeen: m.last_seen })),
      }));
    return {
      spaceId: meta.space_id,
      name: meta.name,
      code: meta.code,
      owner: meta.owner,
      you: deviceId,
      version: meta.version,
      time: now,
      devices,
    };
  }

  private entry(c: string, d: string, f: string, s: string): EntryRow | null {
    return (
      this.sql
        .exec<EntryRow>(
          "SELECT c, d, f, s, v, t, k, version FROM entries WHERE c = ? AND d = ? AND f = ? AND s = ?",
          c,
          d,
          f,
          s,
        )
        .toArray()[0] ?? null
    );
  }

  /** Whether following `op.v`'s parents (same collection and field) leads
   *  back to `op.d`. Sees ops applied earlier in the same push. */
  private makesLoop(op: Op): boolean {
    const seen = new Set<string>();
    let next: unknown = op.v;
    while (typeof next === "string") {
      if (next === op.d) return true;
      // A loop already stored that doesn't pass through op.d.
      if (seen.has(next)) return false;
      seen.add(next);
      const parent = this.entry(op.c, next, op.f, "");
      next = parent ? JSON.parse(parent.v) : null;
    }
    return false;
  }

  private broadcast(version: number) {
    const payload = JSON.stringify({ version });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Closed sockets are cleaned up by the runtime.
      }
    }
  }
}

function toOp(row: EntryRow): Op {
  const op: Op = { c: row.c, d: row.d, f: row.f, s: row.s, v: JSON.parse(row.v), t: row.t };
  if (row.k === "parent") op.k = "parent";
  return op;
}

/** The correction for a path the server has no entry at. */
function zeroOp(op: Op): Op {
  const out: Op = { c: op.c, d: op.d, f: op.f, s: op.s, v: null, t: ZERO_TIMESTAMP };
  if (op.k === "parent") out.k = "parent";
  return out;
}

/** The device a create or join came from, when it isn't the member itself. */
function joinedFrom(device: NewDevice): SeenDevice | null {
  if (!device.deviceId || device.deviceId === device.id) return null;
  return { id: device.deviceId, name: device.name, platform: device.platform };
}
