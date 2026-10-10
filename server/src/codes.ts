// Invite codes (PROTOCOL.md, "Invite codes") and the code → space index.
//
// A code is 8 characters of Crockford's base32 alphabet. The index lives in
// D1 (`space_codes`, created by the API's migrations): a space's Durable
// Object only knows its own code, so something global has to find the space
// a code belongs to.

export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 8;

const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** A fresh random code. 256 is a multiple of 32, so `byte & 31` is unbiased. */
export function newInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b & 31];
  return code;
}

/** Reads a code the way a person might type or paste it: the last path
 *  segment of a URL or the whole text, without spaces or dashes, in any
 *  case, with O read as 0 and I/L as 1. Null unless that leaves 8 alphabet
 *  characters. */
export function parseInviteCode(text: string): string | null {
  let raw = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const url = URL.parse(raw);
    if (!url) return null;
    raw = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    try {
      raw = decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  const code = raw
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return CODE_PATTERN.test(code) ? code : null;
}

/** `7KQ2M9XD` → `7KQ2-M9XD`, how codes are shown. */
export function formatInviteCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// -- the D1 index ---------------------------------------------------------------

/** Reserves a new random code for `spaceId`. Retries on the (rare) clash
 *  with another space's code. */
export async function reserveCode(db: D1Database, spaceId: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const code = newInviteCode();
    const inserted = await db
      .prepare("INSERT INTO space_codes (code, space_id, created_at) VALUES (?, ?, ?) ON CONFLICT (code) DO NOTHING")
      .bind(code, spaceId, Date.now())
      .run();
    if (inserted.meta.changes > 0) return code;
    if (attempt >= 8) throw new Error("couldn't reserve an invite code");
  }
}

export async function releaseCode(db: D1Database, code: string): Promise<void> {
  await db.prepare("DELETE FROM space_codes WHERE code = ?").bind(code).run();
}

export async function releaseSpaceCodes(db: D1Database, spaceId: string): Promise<void> {
  await db.prepare("DELETE FROM space_codes WHERE space_id = ?").bind(spaceId).run();
}

export async function lookupCode(db: D1Database, code: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT space_id FROM space_codes WHERE code = ?")
    .bind(code)
    .first<{ space_id: string }>();
  return row?.space_id ?? null;
}
