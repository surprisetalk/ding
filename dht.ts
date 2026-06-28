//// DHT: signed, content-addressed rows ////////////////////////////////////////
// Shared by server.tsx, ding.ts (CLI), node.tsx, and tests. The canonical bytes
// defined here are LOAD-BEARING: server, CLI, and node must hash byte-identically
// or dedup and gap-fill break silently. Golden vectors live in server.test.ts.

const enc = new TextEncoder();
const dec = new TextDecoder();

// A row the node refuses (bad sig / hash / shape / policy). Distinguishes a
// per-row drop from an infrastructure error that should surface as a 5xx.
export class DhtReject extends Error {}

export const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (s: string) => {
  if (!/^[0-9a-f]*$/.test(s) || s.length % 2) throw new Error(`bad hex: ${s.slice(0, 16)}…`);
  return new Uint8Array(s.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
};
export const sha256hex = async (b: Uint8Array) => {
  const buf = new ArrayBuffer(b.byteLength);
  new Uint8Array(buf).set(b);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)));
};

// Deterministic serialization: sorted object keys, no floats, no unsafe ints.
// canon([kind, pubkey, ts, payload]) IS the signed/hashed string (positional outer
// array kills key-order ambiguity; kind+pubkey are inside the signed bytes).
export const canon = (v: unknown): string => {
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`canon: floats forbidden (${v}); use integer epoch-seconds`);
    if (!Number.isSafeInteger(v)) throw new Error(`canon: unsafe integer ${v}`);
    return String(v);
  }
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (typeof v === "object") {
    return "{" + Object.keys(v as object).sort()
      .map((k) => JSON.stringify(k) + ":" + canon((v as Record<string, unknown>)[k]))
      .join(",") +
      "}";
  }
  throw new Error(`canon: unserializable ${typeof v}`);
};

//// LABELS (shared by server.tsx + ding.ts so both build identical msg payloads) //

export type Labels = { tag: string[]; org: string[]; usr: string[]; www: string[]; text: string };
export const PFX: Record<string, keyof Labels> = { "#": "tag", "*": "org", "@": "usr", "~": "www" };

export const parseLabels = (input: string): Labels => {
  const labels: Labels = { tag: [], org: [], usr: [], www: [], text: "" };
  input.split(/\s+/).filter(Boolean).forEach((t) => {
    const k = PFX[t[0]];
    if (k) (labels[k] as string[]).push(k === "usr" ? t.slice(1) : t.slice(1).toLowerCase());
    else labels.text = labels.text ? labels.text + " " + t : t;
  });
  return labels;
};

export type Kind = "peer" | "usr" | "org" | "msg" | "flag" | "mark";
export const KINDS: Kind[] = ["peer", "usr", "org", "msg", "flag", "mark"];
export type Row = { k: string; kind: Kind; pubkey: string; ts: number; sig: string; [field: string]: unknown };

const bytesOf = (kind: Kind, pubkey: string, ts: number, payload: unknown) =>
  enc.encode(canon([kind, pubkey, ts, payload]));

export const idOf = (pubkeyHex: string) => sha256hex(unhex(pubkeyHex));

// set semantics: lowercased, deduped, sorted — so ["b","a"] ≡ ["a","b"] when signed
export const normLabels = (xs: string[] = []) => [...new Set(xs.map((s) => s.toLowerCase()))].sort();

export const buildMsg = (p: { parent?: string; tags?: string[]; orgs?: string[]; usrs?: string[]; body: string }) => {
  const payload: Record<string, unknown> = {
    tags: normLabels(p.tags),
    orgs: normLabels(p.orgs),
    usrs: normLabels(p.usrs),
    body: p.body,
  };
  if (p.parent) payload.parent = p.parent;
  return payload;
};

// A checkmark: issuer (the signer) endorses `subject` (an id) with a TTL'd claim.
export const buildMark = (subject: string, claim: string, exp: number) => ({ subject, mark: { v: claim, exp } });

//// KEYS ////////////////////////////////////////////////////////////////////////

export const genKey = () =>
  crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
export const pubHexOf = async (kp: CryptoKeyPair) =>
  hex(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
export const exportJwk = (kp: CryptoKeyPair) => crypto.subtle.exportKey("jwk", kp.privateKey);
export const importPriv = (jwk: JsonWebKey) => crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["sign"]);
const importPub = (pubkeyHex: string) =>
  crypto.subtle.importKey("raw", unhex(pubkeyHex), { name: "Ed25519" }, false, ["verify"]);

// Verify an Ed25519 signature over an arbitrary string (e.g. a node-auth challenge nonce).
export const verifyBytes = async (pubkeyHex: string, sigHex: string, msg: string): Promise<boolean> => {
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, await importPub(pubkeyHex), unhex(sigHex), enc.encode(msg));
  } catch {
    return false;
  }
};

//// SIGN / VERIFY ////////////////////////////////////////////////////////////////

export const signRow = async (
  kind: Kind,
  ts: number,
  payload: Record<string, unknown>,
  priv: CryptoKey,
  pubkey: string,
): Promise<Row> => {
  const bytes = bytesOf(kind, pubkey, ts, payload);
  const sig = hex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, priv, bytes)));
  const k = await sha256hex(bytes);
  return { k, kind, pubkey, ts, sig, ...payload };
};

// Strict: throws Elm-style on any mismatch (let it crash). Returns {kind,pubkey,ts,payload}.
export const verifyRow = async (row: Row) => {
  const { k, kind, pubkey, ts, sig, ...payload } = row;
  if (!KINDS.includes(kind)) throw new Error(`unknown kind "${kind}". expected one of ${KINDS.join(", ")}.`);
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error(`row ${String(k).slice(0, 8)}: pubkey must be 64 hex chars.`);
  if (!/^[0-9a-f]{128}$/.test(sig)) throw new Error(`row ${String(k).slice(0, 8)}: sig must be 128 hex chars.`);
  if (!Number.isSafeInteger(ts) || ts <= 0)
    throw new Error(`row ${String(k).slice(0, 8)}: ts must be a positive integer (unix seconds), got ${ts}.`);
  const bytes = bytesOf(kind, pubkey, ts, payload);
  const expect = await sha256hex(bytes);
  if (expect !== k) {
    throw new Error(
      `row ${String(k).slice(0, 8)}…: content-hash mismatch. k claims ${String(k).slice(0, 8)}… ` +
        `but body hashes to ${expect.slice(0, 8)}…. k must equal sha256 of the canonical signed bytes.`,
    );
  }
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, await importPub(pubkey), unhex(sig), bytes)))
    throw new Error(`row ${k.slice(0, 8)}…: bad signature from ${pubkey.slice(0, 8)}…. signed by the wrong key?`);
  return { k, kind, pubkey, ts, payload: payload as Record<string, unknown> };
};

//// CUSTODIAL KEY WRAP (AES-256-GCM, one env secret, random IV per row) //////////

const aesKey = async (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", enc.encode(secret)),
    { name: "AES-GCM" },
    false,
    [
      "encrypt",
      "decrypt",
    ],
  );

export const wrapSecret = async (plaintext: string, secret: string) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plaintext)),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
};

export const unwrapSecret = async (buf: Uint8Array, secret: string) => {
  const b = new Uint8Array(buf);
  try {
    return dec.decode(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, await aesKey(secret), b.slice(12)),
    );
  } catch {
    throw new Error(
      "custodial key decrypt failed — KEY_WRAP_SECRET is wrong/rotated or seckey_enc is corrupt; " +
        "the key cannot be recovered without the original KEY_WRAP_SECRET.",
    );
  }
};
