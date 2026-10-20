// Just enough X.509 to check the certificate chain Apple puts in a JWS
// header (x5c): leaf, intermediate, root, all ECDSA. No npm dependencies,
// so this reads the DER itself: each certificate's signed part, issuer,
// subject, validity, public key and which extensions it carries.

type Tlv = { tag: number; start: number; header: number; length: number; end: number };

function readTlv(der: Uint8Array, at: number): Tlv {
  const tag = der[at];
  let length = der[at + 1];
  let header = 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n === 0 || n > 4) throw new Error("DER: bad length");
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + der[at + 2 + i];
    header += n;
  }
  const end = at + header + length;
  if (end > der.length) throw new Error("DER: truncated");
  return { tag, start: at, header, length, end };
}

function children(der: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let at = parent.start + parent.header; at < parent.end; ) {
    const child = readTlv(der, at);
    out.push(child);
    at = child.end;
  }
  return out;
}

const body = (der: Uint8Array, t: Tlv) => der.subarray(t.start + t.header, t.end);
const whole = (der: Uint8Array, t: Tlv) => der.subarray(t.start, t.end);

function oid(bytes: Uint8Array): string {
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let n = 0;
  for (let i = 1; i < bytes.length; i++) {
    n = n * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) {
      parts.push(n);
      n = 0;
    }
  }
  return parts.join(".");
}

function time(der: Uint8Array, t: Tlv): number {
  const s = new TextDecoder().decode(body(der, t));
  // UTCTime YYMMDDhhmmssZ, GeneralizedTime YYYYMMDDhhmmssZ.
  const full = t.tag === 0x17 ? `${Number(s.slice(0, 2)) < 50 ? "20" : "19"}${s}` : s;
  return Date.UTC(+full.slice(0, 4), +full.slice(4, 6) - 1, +full.slice(6, 8), +full.slice(8, 10), +full.slice(10, 12), +full.slice(12, 14));
}

const SIG_HASH: Record<string, string> = { "1.2.840.10045.4.3.2": "SHA-256", "1.2.840.10045.4.3.3": "SHA-384" };
const CURVES: Record<string, { curve: string; size: number }> = {
  "1.2.840.10045.3.1.7": { curve: "P-256", size: 32 },
  "1.3.132.0.34": { curve: "P-384", size: 48 },
};

export interface Certificate {
  der: Uint8Array;
  tbs: Uint8Array<ArrayBuffer>;
  signatureHash: string;
  signature: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  spki: Uint8Array<ArrayBuffer>;
  curve: string;
  isCA: boolean;
  extensions: string[];
}

export function parseCertificate(der: Uint8Array): Certificate {
  const cert = readTlv(der, 0);
  const [tbsTlv, algTlv, sigTlv] = children(der, cert);
  const tbs = children(der, tbsTlv);
  // An explicit version ([0]) shifts every field by one.
  const f = tbs[0].tag === 0xa0 ? tbs.slice(1) : tbs;
  const [, , issuer, validity, subject, spki, ...rest] = f;
  const [notBefore, notAfter] = children(der, validity);
  const [spkiAlg] = children(der, spki);
  const [, curveOid] = children(der, spkiAlg);
  const curve = CURVES[oid(body(der, curveOid))]?.curve;
  const signatureHash = SIG_HASH[oid(body(der, children(der, algTlv)[0]))];
  if (!curve || !signatureHash) throw new Error("x509: only ECDSA P-256/P-384 certificates are supported");

  const extensions: string[] = [];
  let isCA = false;
  const extsWrapper = rest.find((t) => t.tag === 0xa3);
  if (extsWrapper) {
    for (const ext of children(der, children(der, extsWrapper)[0])) {
      const fields = children(der, ext);
      const id = oid(body(der, fields[0]));
      extensions.push(id);
      if (id === "2.5.29.19") {
        // basicConstraints: OCTET STRING { SEQUENCE { BOOLEAN cA?, ... } }
        const value = fields[fields.length - 1];
        const inner = readTlv(der, value.start + value.header);
        const items = children(der, inner);
        isCA = items.length > 0 && items[0].tag === 0x01 && der[items[0].start + items[0].header] !== 0;
      }
    }
  }
  const sigBits = body(der, sigTlv);
  return {
    der,
    tbs: new Uint8Array(whole(der, tbsTlv)),
    signatureHash,
    signature: sigBits.subarray(1), // the BIT STRING's unused-bits byte
    issuer: whole(der, issuer),
    subject: whole(der, subject),
    notBefore: time(der, notBefore),
    notAfter: time(der, notAfter),
    spki: new Uint8Array(whole(der, spki)),
    curve,
    isCA,
    extensions,
  };
}

/** DER ECDSA-Sig-Value { r, s } to WebCrypto's fixed-size r||s. */
export function ecdsaRaw(der: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const seq = readTlv(der, 0);
  const out = new Uint8Array(size * 2);
  children(der, seq).forEach((int, i) => {
    let bytes = body(der, int);
    while (bytes.length > size && bytes[0] === 0) bytes = bytes.subarray(1);
    out.set(bytes, i * size + size - bytes.length);
  });
  return out;
}

export function publicKey(cert: Certificate): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", cert.spki, { name: "ECDSA", namedCurve: cert.curve }, false, ["verify"]);
}

/** Whether `issuer`'s key signed `cert`. */
export async function signedBy(cert: Certificate, issuer: Certificate): Promise<boolean> {
  if (!equal(cert.issuer, issuer.subject)) return false;
  const size = Object.values(CURVES).find((c) => c.curve === issuer.curve)?.size ?? 0;
  const raw = ecdsaRaw(cert.signature, size);
  return crypto.subtle.verify({ name: "ECDSA", hash: cert.signatureHash }, await publicKey(issuer), raw, cert.tbs);
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
