// Test stand-ins (used by billing.test.ts only): a fake Apple certificate
// chain built here with WebCrypto, a fake Google signing key, and D1 on
// node:sqlite with the package's migrations applied.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { base64url } from "./jwt.ts";

// ---- DER, just enough to write certificates ----

function len(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}
const tlv = (tag: number, ...parts: Uint8Array[]) => {
  const body = concat(...parts);
  return concat(new Uint8Array([tag, ...len(body.length)]), body);
};
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const seq = (...p: Uint8Array[]) => tlv(0x30, ...p);
function int(bytes: Uint8Array): Uint8Array {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  return tlv(0x02, b[0] & 0x80 ? concat(new Uint8Array([0]), b) : b);
}
function oid(dotted: string): Uint8Array {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [a * 40 + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, new Uint8Array(out));
}
const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
const name = (cn: string) => seq(tlv(0x31, seq(oid("2.5.4.3"), utf8(cn))));
function utcTime(ms: number): Uint8Array {
  const d = new Date(ms).toISOString().replace(/[-:T]/g, "").slice(2, 14);
  return tlv(0x17, new TextEncoder().encode(`${d}Z`));
}

const ALG = { "P-256": "1.2.840.10045.4.3.2", "P-384": "1.2.840.10045.4.3.3" } as const;
const HASH = { "P-256": "SHA-256", "P-384": "SHA-384" } as const;
const SIZE = { "P-256": 32, "P-384": 48 } as const;
type Curve = keyof typeof ALG;

function derSignature(raw: Uint8Array, size: number): Uint8Array {
  return seq(int(raw.subarray(0, size)), int(raw.subarray(size)));
}

export type Issued = { der: Uint8Array; keys: CryptoKeyPair; subject: string; curve: Curve };

const DAY = 24 * 60 * 60 * 1000;

export async function issue(opts: {
  subject: string;
  curve: Curve;
  issuer?: Issued; // self-signed without
  ca?: boolean;
  markers?: string[];
  notBefore?: number;
  notAfter?: number;
}): Promise<Issued> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: opts.curve }, true, ["sign", "verify"])) as CryptoKeyPair;
  const signer = opts.issuer ?? { keys, subject: opts.subject, curve: opts.curve };
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const exts: Uint8Array[] = [];
  if (opts.ca) exts.push(seq(oid("2.5.29.19"), tlv(0x01, new Uint8Array([0xff])), tlv(0x04, seq(tlv(0x01, new Uint8Array([0xff]))))));
  for (const m of opts.markers ?? []) exts.push(seq(oid(m), tlv(0x04, new Uint8Array([0x05, 0x00]))));
  const tbs = seq(
    tlv(0xa0, int(new Uint8Array([2]))),
    int(crypto.getRandomValues(new Uint8Array(8))),
    seq(oid(ALG[signer.curve])),
    name(signer.subject),
    seq(utcTime(opts.notBefore ?? Date.now() - DAY), utcTime(opts.notAfter ?? Date.now() + 365 * DAY)),
    name(opts.subject),
    spki,
    ...(exts.length ? [tlv(0xa3, seq(...exts))] : []),
  );
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: HASH[signer.curve] }, signer.keys.privateKey, tbs as Uint8Array<ArrayBuffer>));
  const der = seq(tbs, seq(oid(ALG[signer.curve])), tlv(0x03, concat(new Uint8Array([0]), derSignature(raw, SIZE[signer.curve]))));
  return { der, keys, subject: opts.subject, curve: opts.curve };
}

export const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

export type FakeApple = { root: Issued; intermediate: Issued; leaf: Issued; roots: string[]; sign: (payload: object) => Promise<string> };

/** A chain shaped like Apple's: P-384 root and intermediate, P-256 leaf,
 *  with Apple's marker extensions. */
export async function fakeApple(overrides: { leafMarkers?: string[]; leafNotAfter?: number } = {}): Promise<FakeApple> {
  const root = await issue({ subject: "Test Apple Root CA - G3", curve: "P-384", ca: true });
  const intermediate = await issue({ subject: "Test Apple WWDR CA", curve: "P-384", issuer: root, ca: true, markers: ["1.2.840.113635.100.6.2.1"] });
  const leaf = await issue({
    subject: "Test Prod ECC Mac App Store and iTunes Store Receipt Signing",
    curve: "P-256",
    issuer: intermediate,
    markers: overrides.leafMarkers ?? ["1.2.840.113635.100.6.11.1"],
    notAfter: overrides.leafNotAfter,
  });
  const x5c = [leaf, intermediate, root].map((c) => b64(c.der));
  const sign = async (payload: object) => {
    const input = `${base64url(JSON.stringify({ alg: "ES256", x5c }))}.${base64url(JSON.stringify(payload))}`;
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, leaf.keys.privateKey, new TextEncoder().encode(input));
    return `${input}.${base64url(new Uint8Array(sig))}`;
  };
  return { root, intermediate, leaf, roots: [b64(root.der)], sign };
}

// ---- Google ----

export async function pkcs8Pem(key: CryptoKey): Promise<string> {
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key));
  return `-----BEGIN PRIVATE KEY-----\n${b64(der).match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

export async function rsaKeys(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

export async function signRs256(key: CryptoKey, kid: string, claims: object): Promise<string> {
  const input = `${base64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(sig))}`;
}

// ---- D1 on node:sqlite ----

class Statement {
  private db: DatabaseSync;
  private sql: string;
  private params: unknown[];
  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params: unknown[]) {
    return new Statement(this.db, this.sql, params);
  }
  private stmt() {
    return this.db.prepare(this.sql);
  }
  async run() {
    const r = this.stmt().run(...(this.params as never[]));
    return { success: true, meta: { changes: Number(r.changes) } };
  }
  async all<T>() {
    return { results: this.stmt().all(...(this.params as never[])) as T[], success: true };
  }
  async first<T>() {
    return (this.stmt().get(...(this.params as never[])) as T | undefined) ?? null;
  }
}

export function fakeD1(): D1Database & { sqlite: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/billing.sql", import.meta.url), "utf8"));
  db.exec("CREATE TABLE space_members (member_id TEXT NOT NULL, space_id TEXT NOT NULL, PRIMARY KEY (member_id, space_id))");
  const d1 = {
    sqlite: db,
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (stmts: Statement[]) => Promise.all(stmts.map((s) => s.run())),
  };
  return d1 as unknown as D1Database & { sqlite: DatabaseSync };
}
