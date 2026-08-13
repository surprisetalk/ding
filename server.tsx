//// IMPORTS ///////////////////////////////////////////////////////////////////

import { Context, Hono } from "@hono/hono";
import { Fragment } from "@hono/hono/jsx";
import { HTTPException } from "@hono/hono/http-exception";
import { some } from "@hono/hono/combine";
import { createMiddleware } from "@hono/hono/factory";
import { logger } from "@hono/hono/logger";
import { basicAuth } from "@hono/hono/basic-auth";
import { html, raw } from "@hono/hono/html";
import { deleteCookie, getSignedCookie, setSignedCookie } from "@hono/hono/cookie";
import { serveStatic, upgradeWebSocket } from "@hono/hono/deno";
import type { HtmlEscapedString } from "@hono/hono/utils/html";
import pg from "postgres";
import { Resend } from "resend";
export const resend = new Resend(Deno.env.get("RESEND_API_KEY") ?? "");
import Stripe from "stripe";
import { type Api, uploadToR2 } from "./bots.ts";
import { BOTS } from "./bots/mod.ts";
export const r2 = { uploadToR2 };
import { runCheckmark } from "./bots/checkmark.ts";
import {
  buildMsg,
  DhtReject,
  ensureCustodialKey,
  hex,
  idOf,
  type Kind,
  KINDS,
  type Labels,
  nowSec,
  parseLabels,
  PFX,
  type Row,
  signRow,
  unwrapSecret,
  verifyBytes,
  verifyRow,
} from "./dht.ts";
export { parseLabels };
export type { Labels };

declare module "@hono/hono" {
  interface ContextRenderer {
    (
      content: string | HtmlEscapedString | Promise<string | HtmlEscapedString>,
      props?: { title?: string },
    ): Response | Promise<Response>;
  }
}

//// TYPES /////////////////////////////////////////////////////////////////////

export type Usr = {
  name: string;
  email: string;
  password: string | null;
  bio: string;
  email_verified_at: Date | null;
  invited_by: string;
  orgs_r: string[];
  orgs_w: string[];
  last_seen_at: Date;
  created_at: Date;
  ok?: boolean;
  post_count?: number;
};

export type TagStat = { tag: string; posts: number; ups: number };

// A profile's follow state. `vote` is the VIEWER's ▲/▼ on this profile (null = no vote,
// and -1 only ever reaches the viewer's own render — a mute is private). `followers`
// counts ▲ only, so a downvote is invisible in every count.
export type Follow = { vote: number | null; followers: number; following: number; follows_me: boolean };

export type ChildCom = {
  cid: number;
  parent_cid: number | null;
  body: string;
  created_by: string | null; // null for foreign (dht) authors — render by short hash
  hash?: string | null;
  created_at: string;
  tags?: string[];
  orgs?: string[];
  usrs?: string[];
  c_flags: number;
  comments: number;
  reaction_counts: Record<string, number>;
  user_reactions: string[];
  child_comments?: ChildCom[];
};

export type Com = {
  cid: number;
  parent_cid: number | null;
  created_by: string;
  author_id?: string | null;
  hash?: string | null;
  checked?: boolean;
  tags: string[];
  orgs: string[];
  usrs: string[];
  mentions: string[];
  body: string;
  links: number[];
  thumb: string | null;
  created_at: string;
  c_comments: number;
  c_reactions: Record<string, string>;
  c_flags: number;
  flaggers: string[];
  domains: string[];
  score: string;
  comments?: number;
  reaction_count?: number;
  reaction_counts?: Record<string, number>;
  user_reactions?: string[];
  child_comments?: ChildCom[];
  unread?: boolean;
  kind?: "mention" | "reply";
};

//// CONSTANTS & HELPERS ///////////////////////////////////////////////////////

const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (m) => `&${({ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos" })[m]};`);
const extractFirstUrl = (b: string) => b.match(/https?:\/\/[^\s]+/)?.[0] || null;
export const extractLinks = (b: string) => [...b.matchAll(/https:\/\/ding\.bar\/c\/(\d+)/g)].map((m) => parseInt(m[1]));
export const extractMentions = (b: string) => [
  ...new Set(
    [...b.matchAll(/@([0-9a-zA-Z_]{4,32})/g)].map((m) => m[1].toLowerCase()),
  ),
];
export const extractImageUrl = (b: string) =>
  b.match(/https?:\/\/[^\s]+\.(?:jpe?g|png|gif|webp|svg)(?:\?[^\s]*)?/i)?.[0] ||
  null;

// `com.domains` holds bare lowercase hostnames with `www.` stripped, so every path that
// compares against it — the ?www= filter, a ~domain pref — must speak the same form or it
// silently matches nothing. normHost is that single definition; HOST_RE is what it accepts.
export const normHost = (h: string) => h.trim().toLowerCase().replace(/^www\./, "");
export const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const extractDomains = (b: string): string[] => {
  const out = new Set<string>();
  for (const m of b.matchAll(/https?:\/\/[^\s]+/g)) {
    try {
      out.add(normHost(new URL(m[0]).hostname));
    } catch {
      /**/
    }
  }
  return [...out];
};

// `links @> array[..]` (not `= any(links)`) so the gin index on links can serve it.
// Never throws: callers run it AFTER the write has committed, so a failure here (statement
// timeout as `com` grows, say) must not report the post as failed. Stale ranking is the
// right degradation; the next write on the same cid refreshes it.
const refreshScores = (pid: string | number) =>
  sql`select refresh_score(array(
    select cid from com where cid = ${pid} or links @> array[${pid}::int]
  ))`.then(() => {}, (err) => console.error(`refresh_score failed for cid=${pid}:`, err));

// stat_tag is materialized, so it needs a hand. CONCURRENTLY keeps readers on the old
// snapshot for the duration instead of locking them out — it needs the unique index on
// (tag) and cannot run inside a transaction. Exported so tests refresh the way the cron
// does rather than reaching for their own SQL.
export const refreshStats = () => sql`refresh materialized view concurrently stat_tag`;

const FLAG_THRESHOLD = 3;

const resolveThumbnail = async (url: string) => {
  if (/\.(?:jpe?g|png|gif|webp|svg)(?:\?|$)/i.test(url)) return url;
  // never fetch video files as text — fall straight to the favicon
  if (/\.(?:mp4|webm)(?:\?|$)/i.test(url))
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=128`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "ding/1.0" },
      signal: AbortSignal.timeout(3000),
    });
    const og = (await res.text()).match(
      /<meta[^>]+(?:property="og:image"|name="twitter:image")[^>]+content="([^"]+)"/i,
    )?.[1];
    if (og) return new URL(og, url).href;
  } catch {
    /* ignore */
  }
  return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=128`;
};

// Everything com derives from a body: mentions/links/domains, plus (root posts only)
// a thumbnail — which may fetch the first URL, so call OUTSIDE any transaction.
const deriveBody = async (body: string, isRoot: boolean) => ({
  mentions: extractMentions(body),
  links: extractLinks(body),
  domains: extractDomains(body),
  thumb: !isRoot ? null : extractImageUrl(body) ||
    (extractFirstUrl(body) ? await resolveThumbnail(extractFirstUrl(body)!) : null),
});

//// LABEL PARSING /////////////////////////////////////////////////////////////
// parseLabels / Labels / PFX live in dht.ts (shared with the CLI); re-exported above.

const SYM: Record<string, string> = { tag: "#", org: "*", usr: "@", www: "~" };

export const encodeLabels = (l: Labels) => {
  const p = new URLSearchParams();
  Object.entries(l).forEach(([k, v]) => Array.isArray(v) ? v.forEach((x) => p.append(k, x)) : v && p.set("q", v));
  return p;
};

export const decodeLabels = (p: URLSearchParams) => {
  const res: string[] = [];
  Object.entries(PFX).forEach(([sym, k]) => p.getAll(k).forEach((v) => res.push(sym + v)));
  p.getAll("mention").forEach((v) => res.push(`mention:${v}`));
  ["replies_to", "reactions", "comments", "q"].forEach((k) => {
    const v = p.get(k);
    if (v) {
      res.push(
        k === "q" ? v : k === "reactions" || k === "comments" ? v === "1" ? k : "" : `${k}:${v}`,
      );
    }
  });
  return res.filter(Boolean).join(" ");
};

export const formatLabels = (c: {
  tags?: string[];
  orgs?: string[];
  usrs?: string[];
  domains?: string[];
}) => [
  ...(c.tags || []).map((t) => `#${t}`),
  ...(c.orgs || []).map((t) => `*${t}`),
  ...(c.usrs || []).map((t) => `@${t}`),
  ...(c.domains || []).map((t) => `~${t}`),
];

const buildFilterTitle = (p: URLSearchParams) =>
  Object.entries(PFX)
    .filter(([_, k]) => k !== "www")
    .flatMap(([sym, k]) => p.getAll(k).map((v) => sym + v))
    .join(" ");

const buildAdditiveLink = (
  p: URLSearchParams | undefined,
  k: string,
  v: string,
) => {
  const n = new URLSearchParams(p);
  if (!n.getAll(k).includes(v)) n.append(k, v);
  n.delete("p");
  return `/?${n}`;
};

//// EMAIL TOKEN ///////////////////////////////////////////////////////////////

const SECRET = Deno.env.get("EMAIL_TOKEN_SECRET") ??
  (() => {
    throw new Error("EMAIL_TOKEN_SECRET required");
  })();

export const emailToken = async (ts: Date, email: string) => {
  const epoch = Math.floor(ts.getTime() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${epoch}:${email}`),
  );
  return `${epoch}:${
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32)
  }`;
};

const validateEmailToken = async (
  token: string,
  email: string,
  maxAge = 172800000,
) => {
  const [epoch] = token.split(":"),
    ts = parseInt(epoch) * 1000;
  return (
    ts &&
    Date.now() - ts < maxAge &&
    token === (await emailToken(new Date(ts), email))
  );
};

//// POSTGRES //////////////////////////////////////////////////////////////////

type Sql = ReturnType<typeof pg>;
export let sql: Sql = pg(
  Deno.env.get(`DATABASE_URL`)?.replace(/flycast/, "internal")!,
  // Every Deno Deploy isolate opens its own pool, so keep it small and let idle
  // connections go. statement_timeout stops one pathological query pinning a slot.
  // prepare:false is REQUIRED — DATABASE_URL points at Neon's `-pooler` endpoint, which is
  // transaction-mode. There, named prepared statements outlive the client that made them and
  // are handed to the next one, so any DDL that changes a result type ("alter table com drop
  // column ...") makes every reused plan fail with `cached plan must not change result type`
  // until the pooled backends recycle. That took the whole site down once; do not re-enable.
  {
    database: "ding",
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    connection: { statement_timeout: 15_000 },
  },
);
export const setSql = (s: Sql) => (sql = s);

//// DHT ////////////////////////////////////////////////////////////////////////

const KEY_WRAP_SECRET = Deno.env.get("KEY_WRAP_SECRET") ?? (() => {
  throw new Error("KEY_WRAP_SECRET required (stable; custodial private keys are encrypted under it)");
})();

// The default trust root: marks signed by this pubkey render a verified ✓. Optional —
// without it, no checkmarks show (the network still works). The matching secret key
// lives ONLY on the checkmark cron, never here.
const DING_ORG_PK = Deno.env.get("DING_ORG_PK") ?? null;

// Verified handles (local names with a live trust-root identity mark), cached ~60s so a ✓ can
// render beside a username anywhere without a per-render query. Refreshed in the "*" middleware.
export const verified = { at: 0, names: new Set<string>() };
// Runs in the middleware on every HTML request, so it is on the critical path for the whole
// site. Two rules follow from that, and both were learned the hard way:
//   - Stamp `at` BEFORE the query, not after. On failure the old code left `at` untouched, so
//     every subsequent request retried immediately — a thundering herd against a database
//     that was already struggling, with each request blocking on its own attempt.
//   - Fail OPEN. A stale (or empty) checkmark set is a cosmetic loss; a throwing or hanging
//     middleware is the entire site down, including routes that need no database at all.
const refreshVerified = async () => {
  if (!DING_ORG_PK || Date.now() - verified.at < 60_000) return;
  verified.at = Date.now();
  try {
    const rows = await sql<{ name: string }[]>`
      select u.name from usr u where exists(
        select 1 from dht m where m.kind = 'mark' and m.target = u.id and m.pubkey = ${DING_ORG_PK}
          and m.val->'mark'->>'v' in ('email','payment','human')
          and (m.val->'mark'->>'exp')::bigint > extract(epoch from now()))`;
    verified.names = new Set(rows.map((r) => r.name.toLowerCase())); // names are citext
  } catch (e) {
    console.error(`refreshVerified failed; serving the previous set: ${e instanceof Error ? e.message : e}`);
  }
};

// Custodial signer for a local user (see ensureCustodialKey in dht.ts).
const ensureKey = async (name: string): Promise<{ priv: CryptoKey; pub: string }> => {
  const key = await ensureCustodialKey(sql, name, KEY_WRAP_SECRET);
  if (!key) {
    throw new HTTPException(409, {
      message: `@${name} is self-custody (server holds no key). Post with the ding CLI instead.`,
    });
  }
  return key;
};

// A new child bumps its parent's denormalized counters: reactions land in the
// c_reactions hstore, real comments in c_comments.
const bumpCounts = (db: pg.ISql, cid: number | string, body: string) =>
  isReaction(body)
    ? db`update com set c_reactions = c_reactions || hstore(${body}, (coalesce((c_reactions->${body})::int,0)+1)::text) where cid = ${cid}`
    : db`update com set c_comments = c_comments + 1 where cid = ${cid}`;

// Store a signed row in the dht log and project it: msg -> com; flag -> the target's
// distinct-flagger count. dht is the source of truth, com the rebuildable projection —
// so the log insert + projection share ONE transaction (a partial failure rolls back
// the dht row, so replay re-ingests cleanly). on-conflict-do-nothing makes a genuine
// replay a no-op. PUBLIC posts only: msg rows scoped to *org or @usr are rejected so
// private bodies never enter the log.
export const ingestMsg = async (
  row: Row,
  opts: { verify?: boolean; parentCid?: number | null; gate?: (pubkey: string) => void; comTags?: string[] } = {},
): Promise<{ cid: number | null; isNew: boolean }> => {
  if (opts.verify) {
    try {
      await verifyRow(row);
      if (row.ts > nowSec() + 3600) {
        throw new DhtReject(
          `row ${String(row.k).slice(0, 8)}…: ts ${row.ts} is more than 1h in the future — clock skew or forgery.`,
        );
      }
    } catch (e) {
      throw e instanceof DhtReject ? e : new DhtReject(e instanceof Error ? e.message : String(e));
    }
  }
  opts.gate?.(row.pubkey); // post-verify policy hook (rate-limit); throws DhtReject to drop the row
  const { k, kind, pubkey, ts, sig, ...payload } = row;
  const tags = (payload.tags as string[]) ?? [];
  const orgs = (payload.orgs as string[]) ?? [];
  const usrs = (payload.usrs as string[]) ?? [];
  const target = (payload.target as string) ?? (payload.subject as string) ?? null;
  if (kind === "msg") {
    // Private *org / @recipients are ids (names aren't key-bound, so couldn't be auth-gated).
    if (orgs.some((o) => !/^[0-9a-f]{64}$/.test(o)))
      throw new DhtReject(`row ${String(k).slice(0, 8)}…: *org recipients must be 64-hex ids, not names. refusing.`);
    if (usrs.some((u) => !/^[0-9a-f]{64}$/.test(u))) {
      throw new DhtReject(
        `row ${String(k).slice(0, 8)}…: private @recipients must be 64-hex ids, not names. refusing.`,
      );
    }
  }
  if (kind === "mark") {
    // exp/v must be well-typed or the feed's `(val->'mark'->>'exp')::bigint` cast would throw.
    const m = payload.mark as { v?: unknown; exp?: unknown } | undefined;
    if (typeof payload.subject !== "string" || !m || typeof m.v !== "string" || !Number.isSafeInteger(m.exp))
      throw new DhtReject(`row ${String(k).slice(0, 8)}…: mark needs {subject, mark:{v:string, exp:int}}. refusing.`);
  }

  // Derivations (incl. the network thumbnail fetch) happen OUTSIDE the transaction.
  const body = kind === "msg" ? (payload.body as string) ?? "" : "";
  // dht.tags stays sorted (canonical); com.tags keeps submission order so the rendered feed
  // is byte-for-byte unchanged for existing users (the local /c path passes the original order).
  const comTags = opts.comTags ?? tags;
  const parentHash = (payload.parent as string) ?? null;
  // Independent lookups — serialized, this was four round trips before the transaction.
  const [author, usrNames, parentCid, author_id] = await Promise.all([
    kind === "msg" ? sql`select name from usr where pubkey = ${pubkey}`.then((r) => r[0]) : null,
    // dht.usrs stays id-scoped (for auth-gated delivery); com.usrs resolves to local names
    // (for the existing name-based feed ACL + rendering). CRITICAL: a DM (usrs non-empty)
    // must NEVER project to com.usrs='{}', or the feed ACL would render it PUBLICLY — so when
    // no recipient is local, fall back to the raw ids (non-empty, matches no local viewer).
    kind === "msg" && usrs.length
      ? sql<{ name: string }[]>`select name from usr where id = any(${usrs})`.then((r) => r.map((x) => x.name))
      : [],
    kind !== "msg"
      ? null
      : opts.parentCid !== undefined
      ? opts.parentCid
      : parentHash
      ? sql`select cid from com where hash = ${parentHash}`.then((r) => r[0]?.cid ?? null)
      : null,
    kind === "msg" ? idOf(pubkey) : null,
  ]);
  const comUsrs = usrNames.length ? usrNames : usrs;
  const { mentions, links, domains, thumb } = await deriveBody(body, kind === "msg" && parentCid == null);

  // delivery scope (orgs/usrs) is meaningful only on msg rows; force '{}' elsewhere so a
  // signed non-msg row can't craft a value that games the drain's visibility gate.
  const dhtOrgs = kind === "msg" ? orgs : [];
  const dhtUsrs = kind === "msg" ? usrs : [];
  const rowId = kind === "usr" || kind === "org" || kind === "peer" ? await idOf(pubkey) : null;
  const members = kind === "org" ? (payload.members as string[]) ?? [] : []; // org register: member ids
  const res = await sql.begin(async (tx) => {
    const [stored] = await tx`
      insert into dht (k, kind, pubkey, id, ts, sig, val, tags, orgs, usrs, members, target)
      values (${k}, ${kind}, ${pubkey}, ${rowId}, ${ts}, ${sig}, ${
      sql.json(payload as pg.JSONValue)
    }, ${tags}, ${dhtOrgs}, ${dhtUsrs}, ${members}, ${target})
      on conflict (k) do nothing returning k`;
    if (!stored) {
      const [c] = kind === "msg" ? await tx`select cid from com where hash = ${k}` : [];
      return { cid: c?.cid ?? null, isNew: false, scoreTarget: null as number | null };
    }
    await tx`select pg_notify('dht', ${k})`; // wake any live WS subscriber (fires on commit)
    if (kind === "flag" && target) {
      // count DISTINCT flagger pubkeys (replay-/sybil-resistant), mirror onto the
      // projected com row's c_flags, and mark the target row at the threshold.
      const [{ n }] =
        await tx`select count(distinct pubkey)::int as n from dht where kind = 'flag' and target = ${target}`;
      await tx`update com set c_flags = ${n} where hash = ${target}`;
      if (n >= FLAG_THRESHOLD) await tx`update dht set flagged = true where k = ${target}`;
    }
    if (kind !== "msg") return { cid: null, isNew: true, scoreTarget: null as number | null };
    // *org content is dht-only for now (the web org UI stays on the local name-based ACL).
    if (orgs.length) return { cid: null, isNew: true, scoreTarget: null as number | null };
    const [cm] = await tx`
      insert into com (parent_cid, created_by, hash, author_id, sig, parent_hash, t, body, tags, orgs, usrs, mentions, links, thumb, domains)
      values (${parentCid}, ${
      author?.name ?? null
    }, ${k}, ${author_id}, ${sig}, ${parentHash}, ${ts}, ${body}, ${comTags}, ${orgs}, ${comUsrs}, ${mentions}, ${links}, ${thumb}, ${domains})
      returning cid`;
    // Backfill suppression from any flag rows that arrived before this msg (out-of-order ingest).
    const [{ fn }] = await tx`select count(distinct pubkey)::int as fn from dht where kind = 'flag' and target = ${k}`;
    if (fn > 0) await tx`update com set c_flags = ${fn} where cid = ${cm.cid}`;
    if (fn >= FLAG_THRESHOLD) await tx`update dht set flagged = true where k = ${k}`;
    if (parentCid != null) await bumpCounts(tx, parentCid, body);
    return { cid: cm.cid, isNew: true, scoreTarget: parentCid ?? cm.cid };
  });
  if (res.isNew && res.scoreTarget != null) await refreshScores(res.scoreTarget);
  return { cid: res.cid, isNew: res.isNew };
};

// ?t=YYYYMMDDhhmmss is a coarse "since this UTC time" filter on seen_at (human/manual
// drains). The precise, resumable replication cursor is ?after=<seq> (a strictly
// increasing local arrival counter) — immune to clock skew and same-second collisions.
const parseT = (t: string | null): string =>
  t && /^\d{14}$/.test(t)
    ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}`
    : "1970-01-01 00:00:00";

// q = "$msg #lol" | "mark @gwern" | "$peer" → { kind, tags, orgs, usrs }. Free text rejected.
const parseQ = (q: string) => {
  const parts = q.trim().split(/\s+/).filter(Boolean);
  const kind = (parts[0] ?? "").replace(/^\$/, "");
  if (!KINDS.includes(kind as Kind)) {
    throw new HTTPException(400, {
      message: `bad q "${q}": first token must be a kind (${KINDS.map((k) => "$" + k).join(", ")}).`,
    });
  }
  const l = parseLabels(parts.slice(1).join(" "));
  if (l.text) throw new HTTPException(400, { message: `bad q "${q}": free text not allowed; use #tag/*org/@usr.` });
  return { kind, tags: l.tag, orgs: l.org, usrs: l.usr };
};

const dhtWhere = (qs: ReturnType<typeof parseQ>[]) =>
  qs.length
    ? qs
      .map((q) =>
        sql`(kind = ${q.kind}${q.tags.length ? sql` and tags @> ${q.tags}::text[]` : sql``}${
          q.orgs.length ? sql` and orgs @> ${q.orgs}::text[]` : sql``
        }${q.usrs.length ? sql` and usrs @> ${q.usrs}::text[]` : sql``})`
      )
      .reduce((a, b) => sql`${a} or ${b}`)
    : sql`true`;

// Shared per-isolate live-tail: ONE sql.listen('dht') for the whole isolate, fanned out in
// memory to every WS subscriber — instead of one DB connection per subscriber. On NOTIFY the
// row is fetched ONCE, then matched against each subscriber's q-filters in memory (matchesQ
// mirrors dhtWhere's `kind = … and tags/orgs/usrs @> …` containment). Public rows only.
type DhtFull = {
  k: string;
  seq: string;
  kind: Kind;
  pubkey: string;
  ts: number;
  sig: string;
  val: Record<string, unknown>;
  tags: string[];
  orgs: string[];
  usrs: string[];
};
type WsSub = { qs: ReturnType<typeof parseQ>[]; onRow: (r: DhtFull) => void };
const wsSubs = new Set<WsSub>();
// The on-the-wire NDJSON row shape. The WS live-tail and the HTTP drain MUST emit
// byte-identical rows (subscribers dedup by k across both paths).
const wireRow = (r: Pick<DhtFull, "k" | "kind" | "pubkey" | "ts" | "sig" | "val">) =>
  JSON.stringify({ k: r.k, kind: r.kind, pubkey: r.pubkey, ts: Number(r.ts), sig: r.sig, ...r.val });

// postgres.js infers bigint as int8 at runtime, but its Serializable type omits it.
const int8 = (n: bigint) => n as unknown as number;

// One page of the PUBLIC live-tail drain (WS history sweep + post-subscribe catch-up).
const drainPage = (after: bigint, qs: ReturnType<typeof parseQ>[]) =>
  sql<DhtFull[]>`
    select k, seq, kind, pubkey, ts, sig, val, tags, orgs, usrs from dht
    where seq > ${int8(after)} and orgs = '{}' and usrs = '{}' and (${dhtWhere(qs)})
    order by seq asc limit 1000`;
const supersetOf = (have: string[], need: string[]) => need.every((n) => have.includes(n));
export const matchesQ = (r: Pick<DhtFull, "kind" | "tags" | "orgs" | "usrs">, qs: WsSub["qs"]) =>
  qs.length === 0 ||
  qs.some((q) =>
    r.kind === q.kind && supersetOf(r.tags, q.tags) && supersetOf(r.orgs, q.orgs) && supersetOf(r.usrs, q.usrs)
  );

let listenerHandle: { unlisten: () => Promise<void> } | null = null;
let listenerStarting: Promise<{ unlisten: () => Promise<void> }> | null = null;
const startDhtListener = async () => {
  if (listenerHandle) return;
  if (!listenerStarting) {
    listenerStarting = sql.listen("dht", async (k: string) => {
      if (wsSubs.size === 0) return;
      const [r] = await sql`
        select k, seq, kind, pubkey, ts, sig, val, tags, orgs, usrs from dht
        where k = ${k} and orgs = '{}' and usrs = '{}'` as unknown as DhtFull[];
      if (!r) return; // private/missing → never fans out over WS
      for (const sub of wsSubs) if (matchesQ(r, sub.qs)) sub.onRow(r);
      // A rejected promise must not be cached — otherwise one DB blip kills live-tail for
      // the whole isolate, since listenerHandle never becomes truthy to clear it.
    }).catch((e) => {
      listenerStarting = null;
      throw e;
    });
  }
  listenerHandle = await listenerStarting;
};
const stopDhtListenerIfIdle = async () => {
  if (wsSubs.size === 0 && listenerHandle) {
    const h = listenerHandle;
    listenerHandle = null;
    listenerStarting = null;
    await h.unlisten();
  }
};

// Stateless node-auth challenge: nonce = "<exp>:<salt>:<hmac>". The salt makes every
// nonce unique (even within a second), so single-use doesn't collide. A subscriber
// proves an identity by signing the nonce; the drain then ALSO serves that id's private rows.
const nonceHmac = async (body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`nonce:${body}`))));
};
const nodeChallenge = async () => {
  const now = nowSec();
  await sql`delete from used_nonce where exp < ${now}`; // GC spent nonces
  const body = `${now + 60}:${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
  return `${body}:${await nonceHmac(body)}`;
};
const nonceValid = async (nonce: string) => {
  const [expStr, salt, h] = nonce.split(":");
  const exp = parseInt(expStr);
  return !!exp && !!salt && !!h && exp > nowSec() && h === await nonceHmac(`${expStr}:${salt}`);
};
// Authorization: `Ding <pubkey> <nonce> <sig>`  (sig = Ed25519(pubkey, nonce)). Returns
// the authenticated id, or "" (which sees only public rows). Nonces are single-use.
const drainAuthId = async (c: Context): Promise<string> => {
  const a = c.req.header("authorization");
  if (!a?.startsWith("Ding ")) return "";
  const [pubkey, nonce, sig] = a.slice(5).split(" ");
  if (!/^[0-9a-f]{64}$/.test(pubkey ?? "") || !nonce || !sig || !(await nonceValid(nonce))) return "";
  if (!(await verifyBytes(pubkey, sig, nonce))) return "";
  const [claimed] = await sql`insert into used_nonce (nonce, exp) values (${nonce}, ${
    parseInt(nonce.split(":")[0])
  }) on conflict do nothing returning nonce`;
  return claimed ? await idOf(pubkey) : ""; // already used → reject
};

// Pull-based replication: drain a bootstrap node's log from `cursor` onward, verify +
// store each row locally, and return the advanced cursor. The dull, Deno-Deploy-friendly
// mirror of the WS live-tail; a node polls this on an interval.
export const replicate = async (bootstrap: string, queries: string[], cursor: string): Promise<string> => {
  const qp = queries.map((q) => `q=${encodeURIComponent(q)}`).join("&");
  const res = await fetch(`${bootstrap}/?after=${cursor}&${qp}`);
  if (!res.ok) throw new Error(`replicate: GET ${bootstrap} → ${res.status} ${await res.text()}`);
  for (const line of (await res.text()).split("\n").map((l) => l.trim()).filter(Boolean)) {
    let row: Row;
    try {
      row = JSON.parse(line) as Row;
    } catch {
      console.error(`replicate drop: not valid JSON from ${bootstrap}`);
      continue;
    }
    try {
      await ingestMsg(row, { verify: true });
    } catch (e) {
      if (!(e instanceof DhtReject)) throw e; // infra error → keep the old cursor, retry next tick
      console.error(`replicate drop: ${e.message}`);
    }
  }
  return res.headers.get("x-ding-cursor") ?? cursor;
};

// Gossip discovery: read peer rows from a node to learn other nodes' dialable origins.
export const discoverPeers = async (bootstrap: string): Promise<{ ips: string[]; serves: string[] }[]> => {
  const res = await fetch(`${bootstrap}/?q=$peer`);
  if (!res.ok) return [];
  return (await res.text()).split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const r = JSON.parse(l);
    return { ips: (r.ips ?? []) as string[], serves: (r.serves ?? []) as string[] };
  });
};

// Announce this node's dialable origins + the queries it serves, so others can find us.
export const publishPeer = async (bootstrap: string, ips: string[], serves: string[], priv: CryptoKey, pub: string) => {
  const row = await signRow("peer", nowSec(), { ips, serves }, priv, pub);
  await fetch(bootstrap, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: JSON.stringify(row),
  });
};

// Resolve a self-asserted @name to a canonical id when multiple usr registers claim it:
// prefer the one with the most live trust-root marks, then the earliest seen (first-come).
// Returns null if no register claims the name. (Names aren't key-bound; marks break ties.)
export const resolveName = async (name: string): Promise<string | null> => {
  const [best] = await sql`
    select u.id from (
      select distinct on (pubkey) id, seq from dht where kind = 'usr' and val->>'name' = ${name} order by pubkey, seq asc
    ) u
    order by (
      select count(*) from dht m
      where m.kind = 'mark' and m.target = u.id and m.pubkey = ${DING_ORG_PK ?? ""}
        and (m.val->'mark'->>'exp')::bigint > extract(epoch from now())
    ) desc, u.seq asc
    limit 1`;
  return best?.id ?? null;
};

//// RESEND ///////////////////////////////////////////////////////////////////

if (!Deno.env.get(`RESEND_API_KEY`)) {
  console.warn(
    "RESEND_API_KEY is missing. Verification + password reset emails will fail.",
  );
}

const logEmailFailure = (where: string, email: string, err: unknown) =>
  console.error(
    `${where} email_failed for ${email}:`,
    (err as { response?: { body?: unknown } })?.response?.body ?? err,
  );

const VERIFY_COOLDOWN = `5 minutes`;

const sendVerify = async (email: string) => {
  if (!Deno.env.get(`RESEND_API_KEY`)) {
    throw new Error(
      `RESEND_API_KEY missing — cannot send verification email to ${email}`,
    );
  }
  const claimed = await sql`
    update usr set verify_sent_at = now()
    where email = ${email}
      and (verify_sent_at is null or verify_sent_at < now() - ${VERIFY_COOLDOWN}::interval)
    returning email
  `;
  if (claimed.length === 0) {
    console.log(`sendVerify skipped (cooldown) for ${email}`);
    return;
  }
  const token = await emailToken(new Date(), email);
  const { error } = await resend.emails.send({
    to: email,
    from: Deno.env.get("RESEND_FROM_EMAIL") ?? "noreply@ding.bar",
    subject: "Verify your email",
    text: `Welcome to ding.\n\nPlease verify your email: https://ding.bar/password?email=${
      encodeURIComponent(
        email,
      )
    }&token=${encodeURIComponent(token)}`,
  });
  if (error) {
    console.error(`Could not send verification email to ${email}:`, error);
    throw new Error(`resend send failed: ${error.message}`);
  }
};

// Known throwaway/temp-mail domains, vendored (deploys with the code; readable on Deno Deploy).
export const disposableDomains = new Set(
  Deno.readTextFileSync(new URL("./disposable-domains.txt", import.meta.url))
    .split("\n").map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#")),
);

// A domain can receive mail if it has an MX record, or (SMTP fallback) an A record. Deno throws
// NotFound for both NXDOMAIN and "exists but no such record"; any OTHER error is transient → fail
// open so a flaky resolver never blocks real signups.
const hasMailExchange = async (domain: string): Promise<boolean> => {
  for (const kind of ["MX", "A"] as const) {
    try {
      if ((await Deno.resolveDns(domain, kind)).length > 0) return true;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) return true;
    }
  }
  return false;
};

// Signup email gate: reject known disposable domains and domains that can't receive mail.
// Returns a user-facing reason when the email should be rejected, else null.
export const badSignupEmail = async (email: string): Promise<string | null> => {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return "that email address looks malformed.";
  if (disposableDomains.has(domain)) return "please sign up with a different email provider.";
  if (!(await hasMailExchange(domain))) return "that email domain can't receive mail.";
  return null;
};

//// STRIPE ////////////////////////////////////////////////////////////////////

const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const isStripeConfigured = stripeKey.startsWith("sk_");

if (!isStripeConfigured) {
  console.warn(
    "STRIPE_SECRET_KEY is missing, invalid, or still a placeholder. org features will fail.",
  );
}

export const stripe = new Stripe(
  isStripeConfigured ? stripeKey : "sk_test_placeholder",
  {
    httpClient: Stripe.createFetchHttpClient(),
  },
);

//// COMPONENTS ////////////////////////////////////////////////////////////////

// A gray ✓ rendered BEFORE a handle when that name is verified (live trust-root mark).
const isVerified = (name?: string | null | false) => !!name && verified.names.has(name.toLowerCase());
const checkSpan = () => <span class="check" title="verified">✓</span>;
const Check = (name?: string | null) => isVerified(name) ? checkSpan() : null;

const User = (u: Usr, viewerName?: string, tags: TagStat[] = [], follow?: Follow) => {
  const isOwner = viewerName && viewerName == u.name;
  const mutual = follow && follow.vote === 1 && follow.follows_me;
  return (
    <section class="user">
      <h2>{Check(u.name)}@{u.name}</h2>
      {
        /* LabelVote is a <form>, so it can live in neither the <h2> nor a <p>. It is gated on
          a viewer the way /c's InfoBlocks are — an anonymous click would bounce through
          login and silently discard the vote. */
      }
      {follow && (
        <div class="follow-line">
          {viewerName && !isOwner && <LabelVote label={`@${u.name}`} vote={follow.vote} ups={follow.followers} />}
          <span class="note-sm">
            {follow.followers} follower{follow.followers === 1 ? "" : "s"} · {follow.following} following
            {mutual ? " · mutual" : follow.follows_me ? " · follows you" : ""}
          </span>
        </div>
      )}
      <div class="user-links">
        {u.name !== u.invited_by || <a href={`/u/${u.invited_by}`}>invited by {Check(u.invited_by)}@{u.invited_by}</a>}
        <a href={`/c?usr=${u.name}`}>posts</a>
        <a href={`/c?usr=${u.name}&comments=1`}>comments</a>
        {isOwner && (
          <>
            <a href={`/c?mention=${u.name}`}>mentions</a>
            <a href={`/c?replies_to=${u.name}`}>replies</a>
            <a href={`/c?usr=${u.name}&reactions=1`}>reactions</a>
          </>
        )}
      </div>
      {tags.length > 0 && (
        <div class="tag-presets">
          {tags.map((t) => (
            <a key={t.tag} href={`/c?tag=${encodeURIComponent(t.tag)}`} class="tag-preset">
              #{t.tag}
              {t.ups > 0 && <span class="tag-preset__count">▲{t.ups}</span>}
            </a>
          ))}
        </div>
      )}
      <pre>{u.bio}</pre>
    </section>
  );
};

const isReaction = (body: string): boolean => !!body && [...body].length === 1; // Single grapheme (handles emoji)

const SortToggle = ({
  sort,
  baseHref,
  title,
}: {
  sort: string;
  baseHref: string;
  title: string;
}) => {
  const base = new URL(baseHref, "http://x");
  const href = (s: string) => {
    const p = new URLSearchParams(base.search);
    s === "hot" ? p.delete("sort") : p.set("sort", s);
    p.delete("p");
    return `${base.pathname}?${p}`;
  };
  return (
    <nav class="sort-toggle" aria-label="sort">
      <span>{title}</span>
      <span class="sort-toggle__options">
        {["hot", "new", "top"].map((s, i) => (
          <Fragment key={s}>
            {i > 0 && " • "}
            {sort === s ? s : <a href={href(s)}>{s}</a>}
          </Fragment>
        ))}
      </span>
    </nav>
  );
};

// The #tag / *org / @user / ~domain header above a filtered feed: same skeleton, different
// subject. `vote` is its own slot rather than part of `head`/`note` because LabelVote is a
// <form>, which is valid in neither an <h2> nor a <p>.
const InfoBlock = (
  { head, note, postTo, vote }: { head: BodyNode; note: BodyNode; postTo: BodyNode; vote?: BodyNode },
) => (
  <div class="info-block">
    <div class="follow-line">
      <h2>{head}</h2>
      {vote}
    </div>
    <p class="note">{note}</p>
    <p class="note-sm">{postTo}</p>
  </div>
);

// The draw + attach pair, identical in the frontpage compose form and the reply form.
const ComposeTools = () => (
  <>
    <button type="button" class="upload-btn" data-draw>draw</button>
    <label class="upload-btn">
      attach
      <input type="file" multiple accept="image/*,video/mp4,video/webm,.pdf" data-upload hidden />
    </label>
  </>
);

const Pagination = ({ base, cur, p, more }: { base: string; cur: URLSearchParams; p: number; more: boolean }) => {
  // set, not append: the current URL already carries p past page 0, and c.req.query reads the
  // FIRST value — appending makes every prev/next a self-link.
  const href = (to: number) => {
    const n = new URLSearchParams(cur);
    n.set("p", String(to));
    return `${base}?${n}`;
  };
  return (
    <section>
      <div class="pagination">
        {p > 0 ? <a href={href(p - 1)}>prev</a> : <span />}
        {more && <a href={href(p + 1)}>next</a>}
      </div>
    </section>
  );
};

const ActiveFilters = ({
  params,
  basePath = "/c",
}: {
  params: URLSearchParams;
  basePath?: string;
}) => {
  const f: { label: string; param: string; value: string }[] = [];
  ["tag", "org", "usr", "www", "mention"].forEach((k) =>
    params
      .getAll(k)
      .forEach((v) => f.push({ label: (SYM[k] ?? `${k}:`) + v, param: k, value: v }))
  );
  ["replies_to", "reactions", "comments"].forEach(
    (k) =>
      params.get(k) &&
      f.push({
        label: k === "reactions" || k === "comments" ? k : `${k}:${params.get(k)}`,
        param: k,
        value: params.get(k)!,
      }),
  );

  return f.length > 0
    ? (
      <div class="active-filters">
        {f.map((x) => {
          const n = new URLSearchParams(params);
          n.delete(x.param);
          params
            .getAll(x.param)
            .filter((v) => v !== x.value)
            .forEach((v) => n.append(x.param, v));
          n.delete("p");
          return (
            <a
              key={`${x.param}:${x.value}`}
              href={`${basePath}?${n}`}
              class="filter-pill"
            >
              {x.param === "usr" ? Check(x.value) : null}
              {x.label} x
            </a>
          );
        })}
      </div>
    )
    : <div class="active-filters" />;
};

const Reactions = (c: Com | ChildCom, votesOnly?: boolean) =>
  Object.entries({
    "▲": 0,
    "▼": 0,
    ...(votesOnly ? {} : c.reaction_counts || {}),
  }).map(([k, v]) => (
    <form
      key={k}
      method="post"
      action={`/c/${c.cid}`}
      class={`reaction${(c.user_reactions || []).includes(k) ? " reacted" : ""}`}
    >
      <input type="hidden" name="body" value={k} />
      <button type="submit" aria-label={k === "▲" ? "upvote" : k === "▼" ? "downvote" : `react ${k}`}>
        {k} {v}
      </button>
    </form>
  ));

// The ▲/▼ pair for a label (#tag / @usr / ~www), deliberately the same markup and classes
// as Reactions so a vote looks like a vote everywhere. `ups` is the public follower count;
// the ▼ count is never rendered — a downvote is private to the voter.
const LabelVote = (
  { label, vote, ups }: { label: string; vote: number | null; ups: number },
) => (
  <span class="reactions-group">
    {[1, -1].map((v) => (
      <form key={v} method="post" action="/p" class={`reaction${vote === v ? " reacted" : ""}`}>
        <input type="hidden" name="label" value={label} />
        <input type="hidden" name="vote" value={String(v)} />
        <button
          type="submit"
          aria-label={`${v === 1 ? "upvote" : "downvote"} ${label}${vote === v ? " (undo)" : ""}`}
        >
          {v === 1 ? `▲ ${ups}` : "▼"}
        </button>
      </form>
    ))}
  </span>
);

// deno-lint-ignore no-explicit-any
type BodyNode = any;

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^\n*]+\*\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/(?:[^\s<()]+|\([^\s<()]*\))+)/g;

const isImageUrl = (u: string) => /\.(?:jpe?g|png|gif|webp|svg)(?:\?[^\s]*)?$/i.test(u);

const isVideoUrl = (u: string) => /\.(?:mp4|webm)(?:\?[^\s]*)?$/i.test(u);
const videoEl = (u: string) => (
  <video class="pre-img" src={u} muted loop autoplay playsinline preload="metadata"></video>
);

const inlineFmt = (s: string): BodyNode[] => {
  const out: BodyNode[] = [];
  let i = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    const idx = m.index!;
    if (idx > i) out.push(s.slice(i, idx));
    const [full, code, bold, italic, link, url, bareUrl] = m;
    if (code) out.push(<code>{code}</code>);
    else if (bold)
      out.push(<strong>**{inlineFmt(bold.slice(2, -2))}**</strong>);
    else if (italic) out.push(<em>_{inlineFmt(italic.slice(1, -1))}_</em>);
    else if (link) {
      const innerText = link.slice(1, link.indexOf("]("));
      if (isImageUrl(url))
        out.push(<img class="pre-img" src={url} loading="lazy" />);
      if (isVideoUrl(url)) out.push(videoEl(url));
      out.push(
        <a href={url}>
          <span class="md-syntax">[</span>
          {innerText}
          <span class="md-syntax">]({url})</span>
        </a>,
      );
    } else if (bareUrl) {
      const trail = bareUrl.match(/[.,!?;:]+$/)?.[0] ?? "";
      const clean = trail ? bareUrl.slice(0, -trail.length) : bareUrl;
      if (isImageUrl(clean))
        out.push(<img class="pre-img" src={clean} loading="lazy" />);
      if (isVideoUrl(clean)) out.push(videoEl(clean));
      out.push(<a href={clean}>{clean}</a>);
      if (trail) out.push(trail);
    }
    i = idx + full.length;
  }
  if (i < s.length) out.push(s.slice(i));
  return out;
};

export const formatBody = (body: string): BodyNode[] => {
  const out: BodyNode[] = [];
  const parts = body.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    if (part.startsWith("```") && part.endsWith("```") && part.length >= 6) {
      out.push(<pre>{part}</pre>);
      continue;
    }
    const lines = part.split("\n");
    let i = 0;
    while (i < lines.length) {
      const ln = lines[i];
      if (/^(?: {4}|\t)/.test(ln)) {
        const block: string[] = [];
        while (
          i < lines.length &&
          (/^(?: {4}|\t)/.test(lines[i]) || lines[i] === "")
        ) {
          block.push(lines[i]);
          i++;
        }
        while (block.length && block[block.length - 1] === "") block.pop();
        out.push(<pre>{block.join("\n")}</pre>);
        continue;
      }
      if (/^\s*(?:[-*]|\d+\.)\s+/.test(ln)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i]);
          i++;
        }
        // deno-lint-ignore jsx-key
        const lis = items.map((it) => <li>{inlineFmt(it)}</li>);
        out.push(<ul class="body-list">{lis}</ul>);
        continue;
      }
      if (/^>\s?/.test(ln)) {
        const qs: string[] = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          qs.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        out.push(<blockquote>{formatBody(qs.join("\n"))}</blockquote>);
        continue;
      }
      const hm = ln.match(/^(#{1,6})\s+/);
      if (hm) {
        out.push(
          hm[1].length === 1
            ? <h3>{inlineFmt(ln)}</h3>
            : hm[1].length === 2
            ? <h4>{inlineFmt(ln)}</h4>
            : <h5>{inlineFmt(ln)}</h5>,
        );
        i++;
        continue;
      }
      const para: string[] = [];
      while (
        i < lines.length &&
        lines[i] !== "" &&
        !/^(?: {4}|\t)/.test(lines[i]) &&
        !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^#{1,6}\s+/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) out.push(<p>{inlineFmt(para.join("\n"))}</p>);
      if (i < lines.length && lines[i] === "") i++;
    }
  }
  return out;
};

const Meta = (
  c: Com | ChildCom,
  user?: string,
  labelHref?: (l: string) => string,
  votesOnly?: boolean,
) => {
  const lh = labelHref ?? ((l: string) => `/c?${PFX[l[0]] ?? "tag"}=${l.slice(1)}`);
  return (
    <div class="meta">
      {c.created_at && (
        <a class="meta-date" href={`/c/${c.cid}`}>
          {new Date(c.created_at).toLocaleDateString()}
        </a>
      )}
      <span class="reactions-group">
        <span class="reaction">
          <a href={`/c/${c.cid}`}>» {c.comments || 0}</a>
        </span>
        {Reactions(c, votesOnly)}
      </span>
      {c.parent_cid && <a href={`/c/${c.parent_cid}`}>parent</a>}
      {c.created_by ? Check(c.created_by) : (c as Com).checked && checkSpan()}
      {c.created_by
        ? <a href={`/u/${c.created_by}`}>@{c.created_by}</a>
        : <span class="author-foreign">@{((c as Com).author_id ?? "").slice(0, 8) || "anon"}</span>}
      {c.body && user == c.created_by && <a href={`/c/${c.cid}/delete`}>delete</a>}
      {formatLabels(c).map((l) => (
        <a key={l} href={lh(l)}>
          {l[0] === "@" ? Check(l.slice(1)) : null}
          {l}
        </a>
      ))}
    </div>
  );
};

const Comment = (c: Com | ChildCom, user?: string, asPost?: boolean) => {
  const flagged = c.c_flags >= FLAG_THRESHOLD && user !== c.created_by;
  let title: BodyNode[] | null = null;
  let rest = c.body;
  if (asPost && rest && !flagged) {
    const nl = rest.indexOf("\n");
    const firstLine = (nl >= 0 ? rest.slice(0, nl) : rest).trim();
    if (firstLine) {
      title = inlineFmt(firstLine);
      rest = nl >= 0 ? rest.slice(nl + 1).replace(/^\n+/, "") : "";
    }
  }
  return (
    <div key={c.cid} class="comment" id={String(c.cid)}>
      {Meta(c, user)}
      {title && <h1 class="post-title">{title}</h1>}
      <div class={asPost ? "body body-full" : "body"}>
        {flagged ? "[flagged]" : c.body ? rest ? formatBody(rest) : null : "[deleted by author]"}
      </div>
      <div class="children">
        {(c as Com).child_comments?.map((ch) => Comment(ch, user))}
      </div>
    </div>
  );
};

// Read-only rendering for the /embed iframe: no vote forms, no delete links, absolute hrefs.
const EmbedComment = (p: Com) => (
  <div key={p.cid} class="comment">
    <div class="body">
      {p.c_flags >= FLAG_THRESHOLD ? "[flagged]" : formatBody(p.body)}
    </div>
    <p class="note-sm">
      @{p.created_by ?? p.hash?.slice(0, 8)} · ▲{p.reaction_counts?.["▲"] ?? 0} · {p.comments} comments ·{" "}
      <a href={`https://ding.bar/c/${p.cid}`}>discuss on ding</a>
    </p>
    <div class="children">
      {(p.child_comments || []).map((ch) => (
        <div key={ch.cid} class="comment">
          <div class="body">{ch.c_flags >= FLAG_THRESHOLD ? "[flagged]" : formatBody(ch.body)}</div>
          <p class="note-sm">@{ch.created_by ?? ch.hash?.slice(0, 8)}</p>
        </div>
      ))}
    </div>
  </div>
);

const defaultThumb =
  "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 1 1%27%3E%3Crect fill=%27%23333%27 width=%271%27 height=%271%27/%3E%3C/svg%3E";

const Post = (c: Com, user?: string, p?: URLSearchParams) => {
  const linkUrl = (c.body && extractFirstUrl(c.body)) || null;
  const labelHref = (l: string) => buildAdditiveLink(p, PFX[l[0]] ?? "tag", l.slice(1));
  return (
    <>
      <a
        href={linkUrl ?? `/c/${c.cid}`}
        class="thumb"
        {...(linkUrl ? { target: "_blank", rel: "noopener" } : {})}
      >
        <img
          src={c.thumb
            ? c.thumb.startsWith("https://i.ding.bar/") ? c.thumb : `/img?url=${encodeURIComponent(c.thumb)}`
            : defaultThumb}
          loading="lazy"
          onerror={`this.onerror=null;this.src='${defaultThumb}'`}
        />
      </a>
      <div class="post-content">
        <a href={`/c/${c.cid}`}>
          {c.body ? c.body.trim().split("\n")[0] : "[deleted by author]"}
        </a>
        {Meta(c, user, labelHref, true)}
      </div>
    </>
  );
};

//// HONO //////////////////////////////////////////////////////////////////////

const cookieSecret = Deno.env.get("COOKIE_SECRET") ?? (() => {
  throw new Error("COOKIE_SECRET required (a stable value, or sessions die on every restart)");
})();
const cookieOpts = { maxAge: 60 * 60 * 24 * 365, path: "/", httpOnly: true, sameSite: "Lax" as const };
const notFound = () => {
  throw new HTTPException(404, { message: "Not found." });
};
const form = async (c: Context) => {
  const ct = c.req.header("content-type") || "";
  if (!ct.includes("form") && !ct.includes("multipart")) {
    throw new HTTPException(400, {
      message: `Expected form content-type, got "${ct || "none"}"`,
    });
  }
  return Object.fromEntries(
    [...(await c.req.formData()).entries()].map(([k, v]) => [k, v.toString()]),
  );
};
const host = (c: Context) => {
  const src = c.req.header("host") ?? (() => {
    try {
      return new URL(c.req.url).host;
    } catch {
      return "";
    }
  })();
  const h = src?.match(/^(?:https?:\/\/)?(?:www\.)?([^\/]+)\.([^\/]+)\./)?.[1];
  if (h) return h;
  const a = c.req.header("accept") || "",
    t = c.req.header("content-type") || "";
  if (a.includes("json") || t.includes("json")) return "api";
  if (a.includes("html")) return undefined;
  if (a.includes("xml")) return "rss";
  return undefined;
};
const ok = (c: Context) => host(c) === "api" ? c.body(null, 204) : c.redirect("/u");

const basicAuthName = async (c: Context): Promise<string | null> => {
  const a = c.req.header("Authorization");
  if (!a?.startsWith("Basic ")) return null;
  try {
    const [u, ...rest] = atob(a.slice(6)).split(":");
    const [usr] = await sql`select name from usr where (email=${u} or name=${u}) and password=crypt(${
      rest.join(
        ":",
      )
    }, password)`;
    return usr?.name ?? null;
  } catch {
    return null;
  }
};

// Optionally-authed viewer: session cookie if present, else Basic auth, else anonymous.
const viewer = async (c: Context): Promise<string | undefined> =>
  c.get("name") ?? (await basicAuthName(c)) ?? undefined;

const threadUrl = (parent: number | string | null | undefined, cid: number | string) =>
  parent ? `/c/${parent}#${cid}` : `/c/${cid}`;

const getOrg = async (c: Context) => {
  const [org] = await sql`select * from org where name = ${c.req.param("name") ?? ""}`;
  if (!org) notFound();
  return org;
};

// Bump the org subscription's seat count by ±1 (never below 1); returns the new count.
const subQty = async (subId: string, delta: 1 | -1) => {
  const sub = await stripe.subscriptions.retrieve(subId);
  const qty = sub.items.data[0].quantity! + delta;
  if (qty >= 1) await stripe.subscriptions.update(subId, { items: [{ id: sub.items.data[0].id, quantity: qty }] });
  return qty;
};

const authed = some(
  createMiddleware<{ Variables: { name: string } }>(async (c, next) => {
    const n = await getSignedCookie(c, cookieSecret, "name");
    if (!n) throw new HTTPException(401);
    c.set("name", n);
    await next();
  }),
  basicAuth({
    verifyUser: async (u, p, c) => {
      const [usr] =
        await sql`select name, (password = crypt(${p}, password)) as ok from usr where email=${u} or name=${u}`;
      if (!usr?.ok) return false;
      await setSignedCookie(c, "name", usr.name, cookieSecret, cookieOpts);
      c.set("name", usr.name);
      return true;
    },
  }),
);

const app = new Hono<{ Variables: { name: string } }>();
app.use(logger());
app.notFound(notFound);

const IMG_EXT_RE = /^([A-Za-z0-9]{8})\.(jpe?g|png|gif|webp|pdf|mp4|webm)$/;
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
};
// Mirrored in public/client.js (pre-flight check + user-facing copy) — change both.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Static client-side JS (uploads, drawing pad, search box, compose autosave). The
// per-login notification poller is appended per-request in the "*" middleware.

app.use("*", async (c, next) => {
  if (host(c) !== "i") return next();
  const seg = c.req.path.replace(/^\//, "");
  if (!IMG_EXT_RE.test(seg)) throw new HTTPException(404);
  const r2Url = Deno.env.get("R2_PUBLIC_URL");
  if (!r2Url) throw new HTTPException(500, { message: "R2_PUBLIC_URL unset" });
  const res = await fetch(`${r2Url}/i/${seg}`);
  if (!res.ok) {
    throw new HTTPException((res.status === 404 ? 404 : 502) as 404 | 502, {
      message: res.status === 404 ? "Image not found." : `Image upstream failed (status ${res.status}).`,
    });
  }
  return new Response(res.body, {
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

// Trusted-ish client IP: Cloudflare's CF-Connecting-IP first (unspoofable behind CF), else the
// first x-forwarded-for hop, else a shared "unknown" bucket. Used by every per-IP rate limiter.
export const clientIp = (c: Context): string =>
  c.req.header("cf-connecting-ip")?.trim() ||
  (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim() ||
  "unknown";

// Sliding-window limiter over a Map of timestamps. Returns false when `k` is already at `max`
// within `windowMs` (caller rejects); otherwise records the hit and returns true.
// Keys are caller-supplied (IPs, pubkeys, names), so the map must not grow forever. One sweep
// per window drops fully-expired keys; that bounds memory at "keys seen in the last window".
const lastSweep = new WeakMap<Map<string, number[]>, number>();
const rateHit = (m: Map<string, number[]>, k: string, max: number, windowMs: number): boolean => {
  const now = Date.now();
  if (now - (lastSweep.get(m) ?? 0) > windowMs) {
    lastSweep.set(m, now);
    for (const [key, ts] of m) if (ts.every((t) => now - t >= windowMs)) m.delete(key);
  }
  const fresh = (m.get(k) ?? []).filter((t) => now - t < windowMs);
  m.set(k, fresh);
  if (fresh.length >= max) return false;
  fresh.push(now);
  return true;
};

// Per-IP signup/verify-email throttle (in-memory, per-isolate like postRate). Caps how many
// accounts a single source can mint and how hard it can drive our outbound mail (mailbomb vector).
export const signupRate = { ip: new Map<string, number[]>(), perHour: 5, windowMs: 3_600_000 };
const signupThrottle = (c: Context) => {
  if (!rateHit(signupRate.ip, clientIp(c), signupRate.perHour, signupRate.windowMs))
    throw new HTTPException(429, { message: "too many attempts — try again later." });
};

// Public POST /db ingest rate limits (in-memory, per-isolate like postRate — tune for prod).
// `ip` bounds a single source (incl. sybil key-minting + verify-CPU); `key` bounds per-identity
// DHT bloat. Per-pubkey alone is sybil-bypassable (keys are free) — a future "require a checkmark
// to gossip" closes that. Limits live on the object so they're tunable / overridable in tests.
export const dbIngestRate = {
  ip: new Map<string, number[]>(),
  key: new Map<string, number[]>(),
  reqPerMin: 300,
  rowsPerKeyPerMin: 120,
  windowMs: 60_000,
};
const rateBump = (m: Map<string, number[]>, k: string, max: number): boolean =>
  rateHit(m, k, max, dbIngestRate.windowMs);

// db.ding.bar node endpoint: POST ingests signed rows (per-row verify + rate-limit, drop bad);
// GET drains the dht log oldest->newest by local seen_at, filtered by q=.
app.use("*", async (c, next) => {
  if (host(c) !== "db") return next();
  if (c.req.method === "POST") {
    const ip = clientIp(c);
    if (!rateBump(dbIngestRate.ip, ip, dbIngestRate.reqPerMin))
      throw new HTTPException(429, { message: "ingest rate limit — slow down." });
    if (+(c.req.header("content-length") ?? 0) > 8_000_000)
      throw new HTTPException(413, { message: "ingest body too large (max 8MB per request)." });
    const lines = (await c.req.text()).split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 10_000) throw new HTTPException(413, { message: "too many rows (max 10000 per request)." });
    const gate = (pubkey: string) => {
      if (!rateBump(dbIngestRate.key, pubkey, dbIngestRate.rowsPerKeyPerMin)) {
        throw new DhtReject(
          `row from ${pubkey.slice(0, 8)}…: rate limit ${dbIngestRate.rowsPerKeyPerMin} rows/min/pubkey.`,
        );
      }
    };
    let okN = 0;
    const errors: string[] = [];
    for (const line of lines) {
      // Per-row drops (bad json / bad sig / policy) are collected; infrastructure
      // errors (DB down, etc.) propagate to a real 5xx so peers retry.
      let row: Row;
      try {
        row = JSON.parse(line) as Row;
      } catch {
        errors.push("row: not valid JSON.");
        continue;
      }
      try {
        await ingestMsg(row, { verify: true, gate });
        okN++;
      } catch (e) {
        if (!(e instanceof DhtReject)) throw e;
        errors.push(e.message);
        console.error(`dht ingest drop: ${e.message}`);
      }
    }
    return c.json({ ok: okN, bad: errors.length, errors });
  }
  // WebSocket live-tail (optional, low-latency). Runs on Deno Deploy: WS is supported and
  // Postgres LISTEN/NOTIFY coordinates cross-isolate (the POST that fires pg_notify and the
  // shared sql.listen needn't share a process). Each subscriber registers in `wsSubs` and is
  // fed by ONE per-isolate listener (see startDhtListener) — no DB connection per subscriber.
  // PUBLIC rows only; auth-gated private delivery stays on the HTTP drain.
  // Drain history → {hb:<seq>} → live-tail via NOTIFY.
  if (c.req.method === "GET" && (c.req.header("upgrade") ?? "").toLowerCase() === "websocket") {
    const url = new URL(c.req.url);
    const qs = url.searchParams.getAll("q").map(parseQ);
    let after = /^\d+$/.test(url.searchParams.get("after") ?? "") ? BigInt(url.searchParams.get("after")!) : 0n;
    let mySub: WsSub | undefined;
    let hb: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    return upgradeWebSocket(() => ({
      async onOpen(_e: Event, ws: { send: (s: string) => void }) {
        const push = (r: DhtFull) => {
          ws.send(wireRow(r));
          after = BigInt(r.seq);
        };
        for (;;) { // drain public history oldest→newest
          if (closed) return;
          const rows = await drainPage(after, qs);
          if (!rows.length) break;
          rows.forEach(push);
        }
        if (closed) return;
        ws.send(JSON.stringify({ hb: String(after) }));
        // register with the shared per-isolate listener (no per-subscriber DB connection)
        mySub = { qs, onRow: push };
        wsSubs.add(mySub);
        await startDhtListener();
        // catch-up: any rows ingested between the history drain and registration (client
        // dedups by k, so a row caught by both the sweep and the live listener is harmless).
        (await drainPage(after, qs)).forEach(push);
        hb = setInterval(() => ws.send(JSON.stringify({ hb: String(after) })), 60_000);
      },
      async onClose() {
        closed = true;
        if (hb !== undefined) clearInterval(hb);
        if (mySub) wsSubs.delete(mySub);
        await stopDhtListenerIfIdle(); // last subscriber out → release the shared connection
      },
    }))(c, async () => {});
  }
  if (c.req.method === "GET") {
    const url = new URL(c.req.url);
    if (url.pathname === "/challenge") return c.json({ nonce: await nodeChallenge() });
    const qs = url.searchParams.getAll("q").map(parseQ);
    const afterRaw = url.searchParams.get("after") ?? "0";
    const after = /^\d+$/.test(afterRaw) ? BigInt(afterRaw) : 0n;
    // DEFAULT-DENY: serve only public rows, plus — for an authenticated identity — that
    // id's private DMs and the *org rows of orgs whose current register lists it as a member.
    const me = await drainAuthId(c);
    const myOrgs = me
      ? (await sql<
        { id: string }[]
      >`select id from (select distinct on (pubkey) id, members from dht where kind = 'org' order by pubkey, ts desc) o where ${me}::text = any(o.members)`)
        .map((r) => r.id)
      : [];
    type DhtRow = {
      k: string;
      seq: string;
      kind: Kind;
      pubkey: string;
      ts: number;
      sig: string;
      val: Record<string, unknown>;
    };
    const rows = await sql<DhtRow[]>`
      select k, seq, kind, pubkey, ts, sig, val from dht
      where seq > ${int8(after)} and seen_at > (${parseT(url.searchParams.get("t"))})::timestamp at time zone 'UTC'
        and (orgs = '{}' or orgs && ${myOrgs}::text[]) and (usrs = '{}' or ${me}::text = any(usrs))
        and (${dhtWhere(qs)})
      order by seq asc limit 10000`;
    const body = rows.map(wireRow).join("\n");
    const headers: Record<string, string> = { "content-type": "application/x-ndjson" };
    if (rows.length) headers["x-ding-cursor"] = String(rows[rows.length - 1].seq);
    return c.body(body, 200, headers);
  }
  throw new HTTPException(405, { message: `db.ding.bar accepts GET (drain) and POST (ingest), not ${c.req.method}.` });
});

// Search-engine-ish crawlers. These are welcome on content URLs but not on the infinite
// filter space, so they get a 403 only when the request carries a query string.
const botRe = /bot|crawl|spider|slurp|bing|facebook|google|yandex|baidu|duck|sogou|semrush|ahref/i;

// Training scrapers. robots.txt is advisory and the heaviest of these ignore it, so the same
// policy is enforced in the middleware. Kept as UA substrings that actually appear in the
// wild — `Google-Extended` and `Applebot-Extended` are robots.txt tokens, not real UAs, so
// they belong in ROBOTS only. Nothing here may overlap a search engine: a 403 to Googlebot
// delists the site. Order matters — this is a hard block, botRe's is query-string-only.
export const AI_CRAWLERS = [
  "GPTBot",
  "ClaudeBot",
  "anthropic-ai",
  "CCBot",
  "PerplexityBot",
  "Bytespider",
  "Amazonbot",
  "ImagesiftBot",
  "Diffbot",
  "Omgilibot",
  "cohere-ai",
  "YouBot",
  "Timpibot",
  "meta-externalagent",
];
const aiBotRe = new RegExp(AI_CRAWLERS.join("|"), "i");

// Static assets need no cookie, no verified-set refresh, no unread count and no renderer.
// `txt` is in here for /robots.txt and /sitemap.txt: both are constants, and routing them
// through the middleware made a plain string response depend on the database — during a
// database wobble even robots.txt hung, which is how a partial outage became a total one.
const assetRe = /\.(css|js|ico|png|svg|webmanifest|txt)$/;

// style.css and client.js carry no content hash in their path, so a long max-age would serve
// stale JS after a deploy. Version the URL instead: DENO_DEPLOYMENT_ID changes every deploy,
// so `?v=` is a new URL and the old one is never asked for again — which makes `immutable`
// safe. Unset locally, where we then version nothing and cache nothing, so edits show up.
export let assetV = Deno.env.get("DENO_DEPLOYMENT_ID") ?? "";
export const setAssetV = (v: string) => (assetV = v); // tests only, like setSql
const assetUrl = (p: string) => (assetV ? `${p}?v=${assetV}` : p);

app.use("*", async (c, next) => {
  const url = new URL(c.req.url),
    ua = c.req.header("User-Agent") || "";
  if (assetRe.test(c.req.path)) {
    await next();
    // Only the versioned URL is immutable — a bare /client.js must stay revalidated, or a
    // client that guessed the path would pin this deploy's copy for a year.
    if (assetV && c.req.query("v") === assetV && c.res.ok)
      c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
    return;
  }
  // Training scrapers are refused everywhere, matching what robots.txt asks of them.
  if (aiBotRe.test(ua)) return c.text("Forbidden", 403);
  if (url.searchParams.getAll("tag").length > 3)
    throw new HTTPException(400, { message: "Too many tags. Use 3 or fewer." });
  if (url.search && botRe.test(ua)) return c.text("Forbidden", 403);
  const n = await getSignedCookie(c, cookieSecret, "name");
  if (n) c.set("name", n);
  else if (n === false) deleteCookie(c, "name", { path: "/" }); // stale cookie (e.g. COOKIE_SECRET rotated) → clear it
  if (!host(c)) await refreshVerified(); // keep the verified-handle set warm for HTML renders
  let unread = 0;
  // /n/unread runs the same count itself and renders no nav, so counting here would double it.
  if (n && !host(c) && c.req.path !== "/n/unread") {
    const [row] = await sql`
      select count(*)::int as c from com
      where ${notifWhere(n, sql`(select orgs_r from usr where name = ${n})::text[]`)}
        and created_at > (select last_seen_at from usr where name = ${n})
    `;
    unread = row?.c || 0;
  }
  const path = c.req.path;
  const cur = (p: string) => (path === p ? raw(' aria-current="page"') : "");
  c.setRenderer((content, props) =>
    c.html(html`
      <!DOCTYPE html>
      <html>
        <head>
          <title>${props?.title ? "ding | " + props.title : "ding"}</title>
          <meta charset="UTF-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          />

          <link rel="stylesheet" href="${assetUrl("/style.css")}" />
        </head>
        <body ${n ? raw(`data-unread="${unread}"`) : ""}>
          <header>
            <section>
              <a href="/" class="brand"><span>✦</span>ding</a>
              <nav aria-label="site">
                <a href="/u" ${cur("/u")}>${raw(
                  isVerified(n) ? '<span class="check" title="verified">✓</span>' : "",
                )}${n ? `@${n}` : "account"}</a>
                ${n
                  ? html`
                    <a href="/n" ${cur("/n")}>inbox${unread ? ` (${unread})` : ""}</a>
                  `
                  : ""}
                <a href="/c" ${cur("/c")}>search</a>
                <a href="/c/496">help</a>
              </nav>
            </section>
          </header>
          <main>${content}</main>
          ${n
            ? html`
              <dialog id="draw-dialog" class="draw-dialog">
                <div class="draw-toolbar">
                  <button type="button" data-tool="pen" aria-pressed="true">
                    pen
                  </button>
                  <button type="button" data-tool="eraser">eraser</button>
                  <button type="button" data-size="2">·</button>
                  <button type="button" data-size="4" aria-pressed="true">
                    •
                  </button>
                  <button type="button" data-size="8">●</button>
                  <button type="button" data-clear>clear</button>
                  <span class="spacer"></span>
                  <button type="button" data-cancel>cancel</button>
                  <button type="button" data-insert>insert</button>
                </div>
                <canvas id="draw-canvas" width="480" height="320"></canvas>
              </dialog>
            `
            : ""}
          <script src="${assetUrl("/client.js")}" defer></script>
        </body>
      </html>
    `)
  );
  await next();
});

// Built from an array and joined, because this file was a single string with "\\n" in it —
// which emits a LITERAL backslash-n, so every crawler saw one unparseable line and ding had
// no robots rules at all. Any edit here must keep real newlines; check with `curl | od -c`.
const ROBOTS = [
  // Filtered/search feeds are an infinite crawl space: every tag/sort/page combination is a
  // distinct URL over the same posts. The middleware already 403s these for known crawlers.
  "User-agent: *",
  "Disallow: /*?",
  "Crawl-delay: 10",
  "",
  // Training scrapers, refused outright. Search engines are deliberately NOT in this list —
  // blocking them would delist ding. Drop this block to opt back in.
  ...AI_CRAWLERS.flatMap((ua) => [`User-agent: ${ua}`, "Disallow: /", ""]),
  "Sitemap: https://ding.bar/sitemap.txt",
  "",
].join("\n");

app.get("/robots.txt", (c) => c.text(ROBOTS));
app.get("/sitemap.txt", (c) => c.text("https://ding.bar/"));

const errCopy: Record<number, string> = {
  400: "That request didn't look right. Check the form and try again.",
  401: "You need to log in to do that.",
  403: "You don't have access to that.",
  404: "That page doesn't exist.",
  429: "Too many requests. Try again in a minute.",
  500: "Something broke on our end. Try again in a moment, or email support@ding.bar.",
};

app.onError((err, c) => {
  const h = host(c), http = err instanceof HTTPException, status = http ? err.status : 500;
  if (!http) console.error(err);
  if (http && h) return err.getResponse();
  if (h === "api") return c.json({ error: errCopy[500] }, 500);
  if (h === "rss") return c.text(errCopy[500], 500);
  c.status(status);
  return c.render(
    <section>
      <p>{(http && err.message) || errCopy[status] || errCopy[500]}</p>
      <p>
        <a href={status === 401 ? "/u" : "/"}>{status === 401 ? "log in" : "home"}</a>
      </p>
    </section>,
    { title: `error ${status}` },
  );
});

// Feed-query fragments, shared by GET / and GET /c so the two feeds can't drift.
// Builders are FUNCTIONS (fragments must read the live `sql` — tests swap it via setSql).
// The feed ACL: post is visible if its orgs are within the viewer's readable orgs AND
// it's not a DM — unless the viewer is a recipient or the author.
// Both branches exist to keep the anonymous case indexable. gin's `<@` can't seek, so it
// scans the whole orgs index — plain `orgs = '{}'` is exact. And a disjunct can't satisfy
// com_feed_idx's predicate, so an anonymous viewer (me = "", which no usrs entry or
// created_by can ever equal) gets `usrs = '{}'` as a top-level conjunct instead of an OR.
const visibleTo = (rT: string[], me: string) =>
  sql`${rT.length ? sql`orgs <@ ${rT}::text[]` : sql`orgs = '{}'`} and ${
    me ? sql`(usrs = '{}' or ${me}::text = any(usrs) or created_by = ${me})` : sql`usrs = '{}'`
  }`;

type Frag = ReturnType<typeof visibleTo>;

// A notification is someone else's post, inside my readable orgs, that either @-mentions me or
// replies to something I wrote. Shared by the nav badge, GET /n and GET /n/unread — they each
// had their own copy, and the badge's had already drifted to a correlated orgs_r subselect.
// Columns are unqualified, so the /n cross-join's subquery must expose ONLY last_seen_at —
// adding created_by/orgs/usrs/parent_cid to it would make this ambiguous at runtime.
const notifWhere = (me: string, orgs: Frag) =>
  sql`created_by != ${me} and orgs <@ ${orgs}
      and (${me}::text = any(usrs) or parent_cid in (select cid from com where created_by = ${me}))`;

// "top" sorts on the denormalized c_reactions hstore, not the reaction_count alias. Both are
// per-row subqueries, but an alias in ORDER BY is evaluated for every candidate row rather
// than the 25 returned — and reaction_count's subquery hits `com` while this one only reads
// an hstore already on the row. Same counter refresh_score ranks on.
const orderBy = (s: string) =>
  s === "new"
    ? sql`created_at desc`
    : s === "top"
    ? sql`(select coalesce(sum(v::int), 0) from each(c_reactions) as e(k, v)) desc, created_at desc`
    : sql`score desc`;

// Per-row aggregates (comment count / reaction tallies / the viewer's own reactions),
// repeated at every nesting level; `a` is the row alias at that level.
const aggComments = (a: string) =>
  sql`(select count(*) from com x where x.parent_cid = ${sql(a)}.cid and char_length(x.body) > 1)`;
const aggReactionCounts = (a: string) =>
  sql`(select coalesce(jsonb_object_agg(body, cnt), '{}') from (select body, count(*) as cnt from com where parent_cid = ${
    sql(a)
  }.cid and char_length(body) = 1 group by body) r)`;
const aggUserReactions = (a: string, me: string) =>
  sql`array(select body from com where parent_cid = ${sql(a)}.cid and char_length(body) = 1 and created_by = ${me})`;
const aggCols = (a: string, me: string) =>
  sql`${aggComments(a)} as comments,
      (select count(*) from com x where x.parent_cid = ${sql(a)}.cid and char_length(x.body) = 1) as reaction_count,
      ${aggReactionCounts(a)} as reaction_counts,
      ${aggUserReactions(a, me)} as user_reactions`;
const aggPairs = (a: string, me: string) =>
  sql`'comments', ${aggComments(a)},
      'reaction_counts', ${aggReactionCounts(a)},
      'user_reactions', ${aggUserReactions(a, me)}`;

// What a user is known for, ranked by upvotes received. Profiles are world-readable, so
// `visibleTo` can't gate this — hard-filter to public root posts instead.
const topTags = (who: string) =>
  sql<TagStat[]>`
    select t.tag, count(distinct t.cid)::int as posts,
           count(*) filter (where r.body = '▲')::int as ups
      from (select unnest(tags) as tag, cid from com
             where created_by = ${who} and parent_cid is null
               and orgs = '{}' and usrs = '{}' and tags <> '{}') t
      left join com r on r.parent_cid = t.cid and char_length(r.body) = 1
     group by t.tag order by ups desc, posts desc, t.tag limit 12`;

// Both feeds paginate by OFFSET, which postgres cannot skip — it walks and discards every
// row before the window, so ?p=99999999 is a request to scan the whole table. Bound the
// offset rather than the page number so the cap means the same thing at any ?limit=, and
// say so plainly instead of silently serving a different page than the one asked for.
// Pagination hides "next" at the cap, so a browser can never walk into this.
// On an object so tests can shrink it, like signupRate/dbIngestRate — proving the cap
// suppresses a "next" link otherwise needs 5000 seeded rows.
export const paging = { maxOffset: 5000 };
const pageParam = (raw: string | undefined, lim: number) => {
  // Garbage and negatives still coerce to page 0, matching ?limit= and the behaviour the
  // routes test pins. Only the cap throws: a page past it cannot be answered honestly, and
  // clamping would serve one page under a URL claiming another.
  const p = Math.max(0, Math.trunc(+(raw || 0)) || 0);
  if (p * lim > paging.maxOffset) {
    throw new HTTPException(400, {
      message: `page ${p} is past the last reachable page (${
        Math.floor(paging.maxOffset / lim)
      }). Narrow the feed with a #tag, @user or search rather than paging deeper.`,
    });
  }
  return p;
};

// The ONE definition of the /c feed read. GET /c parses a query string into this; the bot
// fleet calls it directly, skipping HTTP, routing, middleware and a bcrypt auth per request.
// Everything that gates visibility lives here (visibleTo at every nesting level), so a caller
// cannot opt out of the ACL by not going through the route.
export type FeedQuery = {
  cid?: string | number | null;
  viewer?: string; // "" = anonymous; drives visibleTo and user_reactions
  orgsR?: string[];
  tags?: string[];
  orgs?: string[];
  usrs?: string[]; // AUTHORS, not dm recipients — matches ?usr= on /c, unlike ?usr= on /
  mentions?: string[];
  www?: string[];
  q?: string;
  repliesTo?: string;
  reactionsOnly?: boolean;
  commentsOnly?: boolean;
  sort?: string;
  limit?: number;
  offset?: number;
};

export const feedPosts = (o: FeedQuery) => {
  const me = o.viewer ?? "",
    rT = o.orgsR ?? [],
    tags = o.tags ?? [],
    orgs = o.orgs ?? [],
    usrs = o.usrs ?? [],
    mens = o.mentions ?? [],
    www = (o.www ?? []).map(normHost);
  return sql<Com[]>`
    select c.*, ${
    DING_ORG_PK
      ? sql`exists(select 1 from dht m where m.kind='mark' and m.target = c.author_id and m.pubkey = ${DING_ORG_PK} and m.val->'mark'->>'v' in ('email','payment','human') and (m.val->'mark'->>'exp')::bigint > extract(epoch from now()))`
      : sql`false`
  } as checked,
      ${aggCols("c", me)},
      array(select jsonb_build_object('body', ch.body, 'created_by', ch.created_by, 'cid', ch.cid, 'parent_cid', ch.parent_cid, 'created_at', ch.created_at, 'tags', ch.tags, 'orgs', ch.orgs, 'usrs', ch.usrs, 'c_flags', ch.c_flags,
        ${aggPairs("ch", me)},
        'child_comments', array(select jsonb_build_object('body', gc.body, 'created_by', gc.created_by, 'cid', gc.cid, 'parent_cid', gc.parent_cid, 'created_at', gc.created_at, 'tags', gc.tags, 'orgs', gc.orgs, 'usrs', gc.usrs, 'c_flags', gc.c_flags,
          ${aggPairs("gc", me)}
        ) from com gc where gc.parent_cid = ch.cid and char_length(gc.body) > 1 and ${
    visibleTo(rT, me)
  } order by gc.created_at desc)
      ) from com ch where ch.parent_cid = c.cid and char_length(ch.body) > 1 and ${
    visibleTo(rT, me)
  } order by ch.created_at desc) as child_comments
    from com c where ${
    o.cid
      ? sql`cid = ${o.cid}`
      : o.reactionsOnly || o.repliesTo || o.commentsOnly
      ? sql`parent_cid is not null`
      : sql`parent_cid is null`
  }
    ${usrs.length ? sql`and created_by = any(${usrs}::citext[])` : sql``}
    and tags @> ${tags}::text[] and ${visibleTo(rT, me)}
    ${orgs.length ? sql`and orgs && ${orgs}::text[]` : sql``}
    ${
    mens.length ? sql`and (usrs && ${mens}::text[] or mentions && ${mens.map((m) => m.toLowerCase())}::text[])` : sql``
  }
    ${www.length ? sql`and domains && ${www}::text[]` : sql``}
    ${o.repliesTo ? sql`and parent_cid in (select cid from com where created_by = ${o.repliesTo})` : sql``}
    ${o.reactionsOnly ? sql`and char_length(body) = 1` : sql``}
    ${o.commentsOnly ? sql`and char_length(body) > 1` : sql``}
    ${o.q ? sql`and to_tsvector('english', body) @@ plainto_tsquery('english', ${o.q})` : sql``}
    order by ${orderBy(o.sort ?? "hot")}
    offset ${o.offset ?? 0} limit ${o.limit ?? 25}
  `;
};

// The viewer's own vote on a label plus its public ▲ count. The ▼ count is deliberately
// absent: a downvote is private, so it must have no read path off the voter's own pages.
const prefStat = (me: string, kind: string, val: string) =>
  sql<{ vote: number | null; ups: number }[]>`
    select (select vote from pref where uid = ${me} and kind = ${kind} and val = ${val}) as vote,
           (select count(*)::int from pref where kind = ${kind} and val = ${val} and vote = 1) as ups`;

// The personalized window. A page must never straddle it, so it is a multiple of the 25-row
// page size: pages inside it are a slice of the re-ranked window, pages past it are a slice
// of the global order, and the two meet exactly on a page boundary.
const PREF_WINDOW = 300;

app.get("/", async (c) => {
  const q = c.req.query(),
    p = pageParam(q.p, 25),
    // Normalized once, because orderBy treats any unknown sort as "hot" — reading q.sort
    // raw here would let `?sort=HOT` silently take a different branch than it orders by.
    s = q.sort === "new" || q.sort === "top" ? q.sort : "hot",
    name = c.get("name");
  const [viewer] = name ? await sql`select orgs_r, orgs_w from usr where name = ${name}` : [{ orgs_r: [], orgs_w: [] }];
  const rT = viewer?.orgs_r || [],
    wT = viewer?.orgs_w || [];
  const tags = c.req.queries("tag") || [],
    orgs = c.req.queries("org") || [],
    usrs = c.req.queries("usr") || [];

  const me = name || "";
  // One definition of "what this feed selects", shared by the global and personalized
  // branches below so the two can't drift.
  const feedWhere = sql`parent_cid is null and char_length(c.body) > 0 and ${visibleTo(rT, me)}
    ${tags.length ? sql`and tags @> ${tags}::text[]` : sql``}
    ${orgs.length ? sql`and orgs @> ${orgs}::text[]` : sql``}
    ${usrs.length ? sql`and usrs @> ${usrs}::text[]` : sql``}`;
  // Only rendered inside the logged-in compose form, so anonymous hits must not pay for it.
  const [presets, items] = await Promise.all([
    !name ? [] : sql<{ tag: string }[]>`
    with
    own as (
      select unnest(tags) as t, '#' as p, max(created_at) as recency
        from com where created_by = ${me} and parent_cid is null group by 1
      union all
      select unnest(orgs), '*', max(created_at)
        from com where created_by = ${me} and parent_cid is null group by 1
      union all
      select unnest(usrs), '@', max(created_at)
        from com where created_by = ${me} and parent_cid is null group by 1
    ),
    affinity as (
      select unnest(p.tags) as t, '#' as p, max(r.created_at) as recency
        from com r join com p on p.cid = r.parent_cid
        where r.created_by = ${me} and r.body = '▲' and p.parent_cid is null
        group by 1
    ),
    -- An explicit ▲ on the tag itself, which outranks both implicit signals: own infers
    -- interest from having posted, affinity from having upvoted a post that carried the
    -- tag, but this is the user naming the tag. It gets its own priority tier so it wins
    -- the scarce top_mine slots rather than tying with everything you ever posted.
    picked as (
      select val::text as t, '#' as p, created_at as recency
        from pref where uid = ${me} and kind = 'tag' and vote = 1
    ),
    -- A ▼ is "less of this", so a muted tag must not come back as a chip through any of the
    -- other three paths, nor through discovery.
    muted as (select val::text as t from pref where uid = ${me} and kind = 'tag' and vote = -1),
    mine as (
      select distinct on (tag) tag, pri, recency from (
        select '*' || unnest(${wT}::text[]) as tag, 1 as pri, now() as recency
        union all select p || t, 2, recency from picked
        union all select p || t, 3, recency from own
        union all select p || t, 3, recency from affinity
      ) m
      where not exists (select 1 from muted x where m.tag = '#' || x.t)
      order by tag, pri, recency desc
    ),
    top_mine as (select tag, pri, recency from mine order by pri, recency desc limit 12),
    disco as (
      select '#' || tag as tag,
        row_number() over (
          order by -ln(greatest(random(), 1e-9)) / greatest(ups_received::float / ln(posts_count + 2), 0.05)
        ) as rnd
      from stat_tag
      where posts_count >= 3
        and not exists (select 1 from top_mine m where m.tag = '#' || stat_tag.tag)
        and not exists (select 1 from muted x where x.t = stat_tag.tag)
      order by rnd limit 8
    )
    select tag from (
      select tag, 0 as ord, pri, recency, 0::bigint as rnd from top_mine
      union all select tag, 1, 0, now(), rnd from disco
    ) t order by ord, pri, recency desc, rnd
  `,
    !me || s !== "hot" || (p + 1) * 25 > PREF_WINDOW
      // Anonymous, an explicit chronological/most-voted sort, or a page past the window:
      // one global ranking. Keeps com_feed_idx driving the anonymous case exactly as before.
      ? sql<Com[]>`
        select c.*, ${aggCols("c", me)}
        from com c where ${feedWhere}
        order by ${orderBy(s)}
        offset ${p * 25} limit 25
      `
      // Personalized "hot": take a FIXED window of the global ranking, then re-sort it by
      // the viewer's label prefs. `cand` still orders on bare score, so the same index
      // drives it and only the window is re-sorted.
      //
      // The window must not depend on `p`. A growing window is not a stable ordered list:
      // a row that first enters at page p sorts to the top of that page's window, into a
      // slot page p-1 already emitted — so it appears on no page at all, and the row it
      // displaced appears on two. `cid desc` breaks score ties for the same reason: without
      // it, window membership at the boundary varies between requests.
      //
      // Weights mirror refresh_score's asymmetry — a ▼ weighs ~3x a ▲ — and `&&`/`= any`
      // against a null array is null, so a viewer with no prefs (or none of one kind)
      // scores exactly as the global ranking does.
      : sql<Com[]>`
        with mine as (
          select array_agg(val::text)   filter (where kind = 'tag' and vote =  1) as up_tag,
                 array_agg(val::text)   filter (where kind = 'tag' and vote = -1) as dn_tag,
                 array_agg(val::citext) filter (where kind = 'usr' and vote =  1) as up_usr,
                 array_agg(val::citext) filter (where kind = 'usr' and vote = -1) as dn_usr,
                 array_agg(val::text)   filter (where kind = 'www' and vote =  1) as up_www,
                 array_agg(val::text)   filter (where kind = 'www' and vote = -1) as dn_www
            from pref where uid = ${me}
        ),
        cand as (
          select cid, score, tags, domains, created_by from com c where ${feedWhere}
          order by score desc, cid desc limit ${PREF_WINDOW}
        ),
        pick as (
          select cand.cid, cand.score
            + interval '8 hours'  * (case when cand.tags       && m.up_tag        then 1 else 0 end)
            - interval '24 hours' * (case when cand.tags       && m.dn_tag        then 1 else 0 end)
            + interval '12 hours' * (case when cand.created_by = any(m.up_usr)    then 1 else 0 end)
            - interval '36 hours' * (case when cand.created_by = any(m.dn_usr)    then 1 else 0 end)
            + interval '4 hours'  * (case when cand.domains    && m.up_www        then 1 else 0 end)
            - interval '12 hours' * (case when cand.domains    && m.dn_www        then 1 else 0 end) as pscore
          from cand cross join mine m
          order by pscore desc, cand.cid desc offset ${p * 25} limit 25
        )
        -- aggCols is three correlated subqueries per row, so it must sit above the window:
        -- selecting it inside pick would run them for every candidate, not the 25 returned.
        select c.*, ${aggCols("c", me)} from com c join pick on pick.cid = c.cid
        order by pick.pscore desc, c.cid desc
      `,
  ]);

  const cur = new URL(c.req.url).searchParams,
    meta = buildFilterTitle(cur);
  return c.render(
    <>
      <section>
        {name && (
          <form method="post" action="/c" class="upload-form">
            <textarea
              aria-label="post"
              required
              name="body"
              rows={10}
              minlength={1}
              maxlength={4096}
            >
              {cur.get("body") ?? ""}
            </textarea>
            <div class="post-form__row">
              <input
                type="text"
                name="tags"
                aria-label="labels"
                required
                pattern={String.raw`.*(?:^|\s)[#*@]\S+.*`}
                title="Add at least one #tag, *org, or @user before publishing"
                value={decodeLabels(cur)}
              />
              <ComposeTools />
              <button type="submit">publish</button>
            </div>
            {presets.length > 0 && (
              <div class="tag-presets">
                {presets.map((t: { tag: string }) => (
                  <a
                    key={t.tag}
                    href={buildAdditiveLink(
                      cur,
                      t.tag[0] === "*" ? "org" : t.tag[0] === "@" ? "usr" : "tag",
                      t.tag.slice(1),
                    )}
                    class="tag-preset"
                  >
                    {t.tag}
                  </a>
                ))}
              </div>
            )}
            <ActiveFilters params={cur} basePath="/" />
          </form>
        )}
      </section>
      <section>
        {!items.length
          ? <p class="empty">no posts yet.</p>
          : <div class="posts">{items.map((i) => Post(i, name, cur))}</div>}
      </section>
      <Pagination base="/" cur={cur} p={p} more={items.length === 25 && (p + 1) * 25 <= paging.maxOffset} />
    </>,
    { title: meta || undefined },
  );
});

app.post("/login", async (c) => {
  const { email, password } = await form(c);
  const [u] =
    await sql`select name, email, email_verified_at, (password = crypt(${password}, password)) as ok from usr where email=${email}`;
  if (!u) {
    return c.redirect(
      `/signup?error=email_not_found&email=${encodeURIComponent(email)}`,
    );
  }
  const next = c.req.query("next");
  const nextQs = next ? `&next=${encodeURIComponent(next)}` : "";
  if (!u.ok) {
    return c.redirect(
      `/u?error=bad_login&email=${encodeURIComponent(email)}${nextQs}`,
    );
  }
  let resendFailed = false;
  if (
    !u.email_verified_at &&
    !(await getSignedCookie(c, cookieSecret, "name"))
  ) {
    try {
      await sendVerify(u.email);
    } catch (err) {
      console.error(
        `/login resend failed for ${u.email}:`,
        (err as { response?: { body?: unknown } })?.response?.body || err,
      );
      resendFailed = true;
    }
  }
  await setSignedCookie(c, "name", u.name, cookieSecret, cookieOpts);
  if (resendFailed) return c.redirect("/u?error=verify_resend_failed");
  return c.redirect(
    c.req.query("next")?.startsWith("/") ? c.req.query("next")! : "/u",
  );
});

app.get("/logout", (c) => (deleteCookie(c, "name"), c.redirect("/")));
app.post("/logout", (c) => (deleteCookie(c, "name"), ok(c)));

app.get("/verify", async (c) => {
  const e = c.req.query("email"),
    t = c.req.query("token");
  if (!e || !t || !(await validateEmailToken(t, e))) {
    throw new HTTPException(400, {
      message: "Verification link is invalid or expired. Request a new one from /forgot.",
    });
  }
  await sql`update usr set email_verified_at = now() where email_verified_at is null and email = ${e}`;
  return ok(c);
});

app.get("/forgot", (c) =>
  c.render(
    <section>
      {c.req.query("error") === "send_failed" && (
        <p class="error">
          we couldn't send the reset email right now. try again, or email support@ding.bar.
        </p>
      )}
      {c.req.query("sent") !== undefined
        ? (
          <>
            <p>
              Check your email for a link to set your password. (Wait 5m if it hasn't arrived.)
            </p>
            <a href="/u">back</a>
          </>
        )
        : (
          <form method="post" action="/forgot">
            <label>
              email <input required name="email" type="email" />
            </label>
            <button type="submit">send</button>
          </form>
        )}
    </section>,
    { title: "forgot" },
  ));
app.post("/forgot", async (c) => {
  signupThrottle(c);
  const { email } = await form(c),
    [u] = await sql`select email from usr where email = ${email}`;
  if (u) {
    try {
      await sendVerify(u.email);
    } catch (err) {
      logEmailFailure("/forgot", u.email, err);
      return c.redirect("/forgot?error=send_failed");
    }
  }
  return c.redirect("/forgot?sent=1");
});

app.get("/password", async (c) => {
  const email = c.req.query("email"),
    token = c.req.query("token");
  if (!email || !token || !(await validateEmailToken(token, email))) {
    return c.render(
      <section>
        <p>This verification link is invalid or expired.</p>
        <p>
          <a href="/forgot">Request a new one</a>
        </p>
      </section>,
      { title: "expired link" },
    );
  }
  return c.render(
    <section>
      <form method="post" action="/password">
        <input name="token" value={token} type="hidden" />
        <label>
          email <input name="email" value={email} readonly />
        </label>
        <label>
          new password <input name="password" type="password" required />
        </label>
        <button type="submit">set</button>
      </form>
    </section>,
    { title: "password" },
  );
});
app.post("/password", async (c) => {
  const { email, token, password } = await form(c);
  if (!(await validateEmailToken(token, email))) {
    throw new HTTPException(400, {
      message: "Verification link is invalid or expired. Request a new one.",
    });
  }
  const [u] =
    await sql`update usr set password = crypt(${password}, gen_salt('bf', 8)), email_verified_at = coalesce(email_verified_at, now()) where email = ${email} returning name`;
  if (u) await setSignedCookie(c, "name", u.name, cookieSecret, cookieOpts);
  return ok(c);
});

app.post("/invite", authed, async (c) => {
  const e = (await form(c)).email,
    n = Math.random().toString(36).slice(2);
  if (
    (
      // exclude the self-row (root users have invited_by = name) — it isn't an invite
      await sql`select count(*) from usr where invited_by = ${c.get("name")!} and name != ${c.get("name")!}`
    )[0].count >= 4
  ) {
    throw new HTTPException(429, {
      message: "You've used all 4 invites. Email support@ding.bar for more.",
    });
  }
  const [u] = await sql`insert into usr (name, email, bio, invited_by) values (${n}, ${e}, '...', ${c.get(
    "name",
  )!}) on conflict do nothing returning email`;
  if (!u) return c.redirect("/u?error=already_invited");
  try {
    await sendVerify(u.email);
  } catch (err) {
    logEmailFailure("/invite", u.email, err);
    throw new HTTPException(502, {
      message: "Invite created, but the email failed to send. Try /invite again in a moment.",
    });
  }
  return ok(c);
});

app.get("/signup", (c) => {
  const err = c.req.query("error"),
    prefillEmail = c.req.query("email") ?? "";
  const messages: Record<
    string,
    HtmlEscapedString | Promise<HtmlEscapedString>
  > = {
    name_taken: <p>That username is already taken. Pick another.</p>,
    already_verified: (
      <p>
        That email is already registered. <a href="/forgot">Forgot your password?</a>
      </p>
    ),
    email_failed: (
      <p>
        Account created, but the verification email failed to send. Try resending in a moment, or contact support.
      </p>
    ),
    conflict: <p>Username or email already taken.</p>,
    email_not_found: <p>No account with that email — sign up below.</p>,
    bad_email: <p>please sign up with a different email address.</p>,
  };
  return c.render(
    <section>
      <h2>sign up</h2>
      {c.req.query("ok") !== undefined && <p>Check your email for a verification link.</p>}
      {c.req.query("resent") !== undefined && <p>Sent another verification email — check your inbox.</p>}
      {err && messages[err]}
      <form method="post">
        <label>
          username
          <input
            type="text"
            name="name"
            pattern="^[0-9a-zA-Z_]{4,32}$"
            required
          />
        </label>
        <label>
          email
          <input type="email" name="email" value={prefillEmail} required />
        </label>
        <input type="text" name="url" tabindex={-1} autocomplete="off" class="hp" aria-hidden="true" />
        <button type="submit">create account</button>
      </form>
      {(err === "email_failed" || err === "conflict") && prefillEmail && (
        <form method="post" action="/signup/resend">
          <input type="hidden" name="email" value={prefillEmail} />
          <button type="submit">resend verification email</button>
        </form>
      )}
    </section>,
    { title: "signup" },
  );
});

// Three signup paths send the same verification mail and share one failure branch.
const sendOrFail = async (c: Context, email: string, okUrl: string, where: string, qs: string) => {
  try {
    await sendVerify(email);
    return c.redirect(okUrl);
  } catch (err) {
    logEmailFailure(where, email, err);
    return c.redirect(`/signup?error=email_failed${qs}`);
  }
};

app.post("/signup", async (c) => {
  const formData = await form(c);
  const email = formData.email,
    name = formData.name;
  const qs = `&email=${encodeURIComponent(email)}`;

  // Honeypot: real users never see/fill the hidden `url` field. Bots do — pretend success so
  // they can't learn the trap, but create nothing and send nothing.
  if (formData.url) return c.redirect("/signup?ok");
  signupThrottle(c);
  if (await badSignupEmail(email)) return c.redirect(`/signup?error=bad_email${qs}`);

  const [existingByEmail] = await sql`select name, email_verified_at from usr where email = ${email}`;
  if (existingByEmail) {
    if (existingByEmail.email_verified_at)
      return c.redirect(`/signup?error=already_verified${qs}`);
    // Unverified: idempotent resend so user isn't stuck.
    return sendOrFail(c, email, "/signup?ok", "/signup", qs);
  }

  const [existingByName] = await sql`select name from usr where name = ${name}`;
  if (existingByName) return c.redirect(`/signup?error=name_taken${qs}`);

  const usr = {
    name,
    email,
    bio: `hello, my name is @${name}`,
    password: null,
    invited_by: name,
  };
  const [newUsr] = await sql`
    with usr_ as (insert into usr ${sql(usr)} on conflict do nothing returning *)
    select name, email from usr_
  `;
  if (!newUsr?.email) return c.redirect(`/signup?error=conflict${qs}`); // race: someone grabbed it between checks
  return sendOrFail(c, newUsr.email, "/signup?ok", "/signup", qs);
});

app.post("/signup/resend", async (c) => {
  signupThrottle(c);
  const { email } = await form(c);
  const qs = `&email=${encodeURIComponent(email)}`;
  const [u] = await sql`select email, email_verified_at from usr where email = ${email}`;
  if (!u) return c.redirect(`/signup?error=conflict${qs}`); // pretend-success would mislead — ask them to sign up
  if (u.email_verified_at)
    return c.redirect(`/signup?error=already_verified${qs}`);
  return sendOrFail(c, u.email, "/signup?resent", "/signup/resend", qs);
});

// Error copy for GET /u, shared by the logged-out login form and the account hub.
const uErrMsg: Record<string, BodyNode> = {
  bad_login: (
    <>
      wrong email or password — try again or <a href="/forgot">reset your password</a>.
    </>
  ),
  verify_resend_failed: "we couldn't resend your verification email. try again, or email support@ding.bar.",
  already_invited: "that email already has an account or a pending invite.",
};

app.get("/u", async (c) => {
  // Not viewer(c): a bad Basic header must 401 here, not fall through to the login page.
  const name: string | undefined = c.get("name") ??
    (c.req.header("Authorization")?.startsWith("Basic ")
      ? (await basicAuthName(c)) ?? (() => {
        throw new HTTPException(401, { message: "Invalid credentials." });
      })()
      : undefined);
  if (name) c.set("name", name);

  const next = c.req.query("next") ?? "";

  if (!name) {
    const action = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
    const err = c.req.query("error");
    const prefillEmail = c.req.query("email") ?? "";
    return c.render(
      <section>
        <h2>login</h2>
        {err && uErrMsg[err] && <p class="error">{uErrMsg[err]}</p>}
        <form method="post" action={action}>
          <label>
            email <input type="email" name="email" value={prefillEmail} required />
          </label>
          <label>
            password <input type="password" name="password" required />
          </label>
          <button type="submit">login</button>
        </form>
        <p class="login-links">
          <a href="/forgot">forgot password?</a>
          {" • "}
          <a href="/signup">sign up</a>
        </p>
      </section>,
      { title: "login" },
    );
  }

  // THREE queries, not six: the pool is `max: 3` per isolate, so a wider Promise.all doesn't
  // fan out — it queues into a second round trip. The invite list rides along with the usr
  // row (same table), and the three pref reads collapse into one pass over the same rows.
  const [[usr], tags, prefRows] = await Promise.all([
    sql`
      select u.name, u.bio, u.invited_by, u.password, u.orgs_r, u.orgs_w, u.pubkey,
             (u.seckey_enc is not null) as custodial,
             coalesce((
               select json_agg(json_build_object('name', i.name, 'verified', i.email_verified_at is not null)
                               order by i.created_at desc)
                 from usr i where i.invited_by = u.name and i.name <> u.name
             ), '[]'::json) as invited
      from usr u where u.name = ${name}
    `,
    topTags(name),
    // Your prefs (the only page where a ▼ of yours is visible), each flagged mutual, plus the
    // two counts. `counts left join mine on true` always yields a row, so the counts survive
    // a user with no prefs of their own but followers of their own.
    sql<
      { followers: number; following: number; kind: string | null; val: string | null; vote: number; mutual: boolean }[]
    >`
      with mine as (select kind, val, vote, created_at from pref where uid = ${name}),
      counts as (
        select (select count(*)::int from pref where kind = 'usr' and val = ${name} and vote = 1) as followers,
               (select count(*)::int from pref where uid = ${name} and kind = 'usr' and vote = 1) as following
      )
      select c.followers, c.following, m.kind, m.val::text, m.vote,
             coalesce(m.kind = 'usr' and m.vote = 1 and exists(
               select 1 from pref q
                where q.uid = m.val and q.val = ${name} and q.kind = 'usr' and q.vote = 1), false) as mutual
        from counts c left join mine m on true
       order by m.vote desc nulls last, m.kind, m.val`,
  ]);
  if (!usr) return notFound();
  const invited = usr.invited as { name: string; verified: boolean }[];
  // The left join emits one all-null pref row when you have none; drop it and the rest are whole.
  const prefs = prefRows.filter((r) => r.kind) as { kind: string; val: string; vote: number; mutual: boolean }[];
  const mutuals = prefs.filter((r) => r.mutual).map((r) => ({ name: r.val }));
  const follow: Follow = {
    vote: null,
    follows_me: false,
    followers: prefRows[0].followers,
    following: prefRows[0].following,
  };
  if (!usr.password) return c.redirect("/password");
  const accountErr = uErrMsg[c.req.query("error") ?? ""];
  return c.render(
    <>
      {accountErr && (
        <section>
          <p class="error">{accountErr}</p>
        </section>
      )}
      <section>{User(usr as unknown as Usr, name, tags, follow)}</section>
      <section>
        <h2>bio</h2>
        <form method="post" action="/u">
          <textarea name="bio" rows={6} aria-label="bio">
            {usr.bio}
          </textarea>
          <button type="submit">save</button>
        </form>
      </section>
      <section>
        <h2>people</h2>
        {mutuals.length === 0
          ? <p class="note-sm">no mutuals yet — upvote someone from their profile to follow them.</p>
          : (
            <div class="user-links">
              {mutuals.map((m) => <a key={m.name} href={`/u/${m.name}`}>{Check(m.name)}@{m.name}</a>)}
            </div>
          )}
      </section>
      <section>
        <h2>interests</h2>
        {prefs.length === 0
          ? <p class="note-sm">no prefs yet — upvote a #tag, @user or ~domain to weight your frontpage.</p>
          : (
            <div class="tag-presets">
              {prefs.map((x) => {
                const label = SYM[x.kind] + x.val;
                return (
                  <form key={label} method="post" action="/p">
                    <input type="hidden" name="label" value={label} />
                    <input type="hidden" name="vote" value={String(x.vote)} />
                    <button
                      type="submit"
                      class="tag-preset"
                      aria-label={`remove ${x.vote === 1 ? "▲" : "▼"} ${label}`}
                    >
                      {x.vote === 1 ? "▲" : "▼"} {label} x
                    </button>
                  </form>
                );
              })}
            </div>
          )}
      </section>
      <section>
        <h2>orgs</h2>
        {usr.orgs_r.length === 0 ? <p class="note-sm">no orgs yet.</p> : (
          <div class="user-links">
            {usr.orgs_r.map((o: string) => (
              <a key={o} href={`/o/${o}`}>*{o}{usr.orgs_w.includes(o) ? "" : " (read-only)"}</a>
            ))}
          </div>
        )}
        <p class="note-sm">
          <a href="/o/new">+ new org ($1/member/mo)</a>
        </p>
      </section>
      <section>
        <h2>invites</h2>
        {invited.length >= 4
          ? <p class="note-sm">all 4 invites used — email support@ding.bar for more.</p>
          : (
            <form method="post" action="/invite" class="form-inline">
              <input
                type="email"
                name="email"
                placeholder="friend@example.com"
                aria-label="invite email"
                required
                class="grow"
              />
              <button type="submit">invite</button>
            </form>
          )}
        <p class="note-sm">{invited.length} of 4 used</p>
        {invited.length > 0 && (
          <div class="user-links">
            {invited.map((i) => <a key={i.name} href={`/u/${i.name}`}>@{i.name}{i.verified ? "" : " (pending)"}</a>)}
          </div>
        )}
      </section>
      <section>
        <h2>account</h2>
        <div class="account-actions">
          <form method="post" action="/logout">
            <button type="submit" class="btn-sm">logout</button>
          </form>
          {usr.custodial ? <a href="/key">download key (ding-key.json)</a> : (
            <span class="note-sm">
              self-custody key{usr.pubkey && (
                <>
                  {" · "}
                  <code title={usr.pubkey}>{usr.pubkey.slice(0, 8)}…</code>
                </>
              )}
            </span>
          )}
        </div>
        {usr.custodial && (
          <details class="danger">
            <summary>switch to self-custody…</summary>
            <p class="note-sm">
              deletes the server's copy of your key. irreversible — download your key first or it's gone.
            </p>
            <form method="post" action="/key/delete">
              <button type="submit">delete server copy</button>
            </form>
          </details>
        )}
      </section>
    </>,
    { title: "your account" },
  );
});

app.post("/u", authed, async (c) => {
  const data = await form(c);
  await sql`update usr set bio = ${data.bio} where name = ${c.get("name")!}`;
  return c.redirect("/u");
});

const notifQuery = (name: string, orgs_r: string[]) =>
  sql<Com[]>`
  select c.*, (c.created_at > u.last_seen_at) as unread,
    case when ${name}::text = any(c.usrs) then 'mention' else 'reply' end as kind
  from com c
  cross join (select last_seen_at from usr where name = ${name}) u
  where ${notifWhere(name, sql`${orgs_r}::text[]`)}
  order by c.created_at desc
  limit 100
`;

app.get("/n", authed, async (c) => {
  const name = c.get("name");
  const [usr] = await sql`select orgs_r from usr where name = ${name}`;
  // Sequential on purpose: notifQuery reads last_seen_at to mark rows unread, so the
  // "mark read" update must land after it.
  const items = await notifQuery(name, usr?.orgs_r || []);
  await sql`update usr set last_seen_at = now() where name = ${name}`;
  if (host(c) === "api") return c.json(items);
  return c.render(
    <>
      <section>
        <h2>notifications</h2>
        <p class="note-sm">
          mentions and replies. unread items are highlighted.
        </p>
      </section>
      <section>
        {items.length === 0
          ? (
            <p class="empty">
              no notifications yet. mentions (@you) and replies to your posts show up here.
            </p>
          )
          : (
            items.map((i) => (
              <div key={i.cid} class={`notif${i.unread ? " notif--unread" : ""}`}>
                <div class="notif__kind">{i.kind}</div>
                {Comment(i, name)}
              </div>
            ))
          )}
      </section>
    </>,
    { title: "notifications" },
  );
});

app.get("/n/unread", authed, async (c) => {
  const name = c.get("name");
  const [usr] = await sql`select orgs_r, last_seen_at from usr where name = ${name}`;
  const rT = usr?.orgs_r || [];
  const rows = await sql<Pick<Com, "cid" | "body" | "created_by" | "parent_cid">[]>`
    select cid, body, created_by, parent_cid
    from com c
    where ${notifWhere(name, sql`${rT}::text[]`)} and c.created_at > ${usr.last_seen_at}
    order by created_at desc limit 10
  `;
  return c.json({
    count: rows.length,
    latest: rows.map((r) => ({
      title: `@${r.created_by}: ${(r.body || "").trim().slice(0, 80)}`,
      url: `/c/${r.parent_cid || r.cid}#${r.cid}`,
    })),
  });
});

app.get("/u/:name", async (c) => {
  const profileName = c.req.param("name");
  const viewerName = await viewer(c);
  if (viewerName) c.set("name", viewerName);
  const isOwner = viewerName && viewerName == profileName;
  const me = viewerName || "";
  const [[usr], tags, [follow]] = await Promise.all([
    sql`
      select name, bio, invited_by
        ${isOwner ? sql`, orgs_r, orgs_w` : sql``}
      from usr where name = ${profileName}
    `,
    topTags(profileName),
    sql<Follow[]>`
      select (select vote from pref where uid = ${me} and kind = 'usr' and val = ${profileName}) as vote,
             (select count(*)::int from pref where kind = 'usr' and val = ${profileName} and vote = 1) as followers,
             (select count(*)::int from pref where uid = ${profileName} and kind = 'usr' and vote = 1) as following,
             exists(select 1 from pref where uid = ${profileName} and kind = 'usr' and val = ${me} and vote = 1) as follows_me`,
  ]);
  if (!usr) return notFound();
  if (host(c) === "api") return c.json(usr, 200);
  return c.render(
    <>
      <section>{User(usr as Usr, viewerName, tags, follow)}</section>
      {isOwner && (
        <section>
          <p class="note-sm">
            <a href="/u">← your account</a> — this is your public profile
          </p>
        </section>
      )}
    </>,
    { title: usr.name },
  );
});

app.get("/us", async (c) => {
  const limit = Math.min(+(c.req.query("limit") || 100), 500);
  const us = await sql`
    select name, created_at from usr
    where email_verified_at is not null
    order by created_at desc limit ${limit}
  `;
  return c.json(us, 200);
});

app.get("/o/new", authed, (c) =>
  c.render(
    <section>
      <h2>create an organization</h2>
      <p class="note">
        create a private organization for your team. access control is managed via the <code>*org</code> tag.
      </p>
      <p class="note">cost: $1/member/month.</p>
      <form method="post" action="/o/new" class="form-inline">
        <input
          required
          pattern="^[0-9a-zA-Z_]{4,32}$"
          name="name"
          aria-label="org name"
          placeholder="org_name"
          class="grow"
        />
        <button type="submit">create & subscribe</button>
      </form>
      <p class="note-sm">
        <a href="/u">← back to account</a>
      </p>
    </section>,
    { title: "new org" },
  ));

app.post("/o/new", authed, async (c) => {
  const { name } = await form(c);
  if (!name.match(/^[0-9a-zA-Z_]{4,32}$/))
    throw new HTTPException(400, { message: "Invalid name" });

  const [existing] = await sql`select name from org where name = ${name}`;
  if (existing) {
    throw new HTTPException(409, {
      message: `Org name "${name}" is already taken.`,
    });
  }

  const session = await stripe.checkout.sessions.create({
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `Ding Organization: ${name}`,
          },
          unit_amount: 100,
          recurring: {
            interval: "month",
          },
        },
        quantity: 1,
      },
    ],
    mode: "subscription",
    success_url: `${new URL(c.req.url).origin}/o/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${new URL(c.req.url).origin}/o/new`,
    metadata: {
      orgName: name,
      creatorName: c.get("name")!,
    },
  });

  return c.redirect(session.url!);
});

const createOrg = async (
  orgName: string,
  creatorName: string,
  subId: string,
) => {
  const inserted = await sql`
    insert into org ${sql({ name: orgName, created_by: creatorName, stripe_sub_id: subId })}
    on conflict (name) do nothing
    returning name
  `;
  if (!inserted.length) {
    const [existing] = await sql`select created_by, stripe_sub_id from org where name = ${orgName}`;
    if (existing?.stripe_sub_id === subId) return; // idempotent retry, already created
    console.error(
      `createOrg collision: wanted "${orgName}" for ${creatorName} (sub=${subId}) but exists for ${existing?.created_by} (sub=${existing?.stripe_sub_id}). Manual reconciliation required.`,
    );
    throw new HTTPException(409, {
      message: `Org "${orgName}" already exists. Your subscription ${subId} needs manual reconciliation.`,
    });
  }
  await sql`
    update usr
    set orgs_r = array_append(orgs_r, ${orgName}),
        orgs_w = array_append(orgs_w, ${orgName})
    where name = ${creatorName}
  `;
};

app.get("/o/success", authed, async (c) => {
  const sessionId = c.req.query("session_id");
  if (!sessionId) {
    throw new HTTPException(400, {
      message: "Missing checkout session. Start a new org from /o/new.",
    });
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.status !== "complete")
    throw new HTTPException(400, { message: "Payment not complete" });

  const { orgName, creatorName } = session.metadata!;
  await createOrg(orgName, creatorName, session.subscription as string);

  return c.redirect(`/o/${orgName}`);
});

app.get("/o/:name", async (c) => {
  const [org, hasAccess, members] = await Promise.all([
    getOrg(c),
    sql<{ exists: boolean }[]>`select true from usr where true and name = ${c.get("name") ?? ""} and ${
      c.req.param("name") ?? ""
    } = any(orgs_r)`
      .then((r) => r[0]),
    sql<{ name: string }[]>`select name from usr where ${c.req.param("name") ?? ""} = any(orgs_r)`,
  ]);
  if (!hasAccess) throw new HTTPException(403, { message: "Access denied" });

  const viewer = c.get("name") ?? "";
  return c.render(
    <section>
      <h2>*{org.name}</h2>
      <p class="note-sm">
        created by {Check(org.created_by)}@{org.created_by} on {new Date(org.created_at).toLocaleDateString()}.
      </p>
      <div class="stack stack--loose">
        <div>
          <h3>members ({members.length})</h3>
          <div class="stack">
            {members.map((m) => (
              <div class="member-row">
                <a href={`/u/${m.name}`}>{Check(m.name)}@{m.name}</a>
                {(org.created_by === viewer ? m.name !== viewer : m.name === viewer) && (
                  <form method="post" action={`/o/${org.name}/remove`} class="form-inline">
                    <input type="hidden" name="name" value={m.name} />
                    <button type="submit" class="btn-sm">{org.created_by === viewer ? "remove" : "leave"}</button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </div>
        {org.created_by === viewer && (
          <div class="section-divider">
            <h3>invite member</h3>
            <form
              method="post"
              action={`/o/${org.name}/invite`}
              class="form-inline"
            >
              <input
                required
                type="email"
                name="email"
                aria-label="email"
                placeholder="email"
                class="grow"
              />
              <button type="submit">invite ($1/mo)</button>
            </form>
          </div>
        )}
      </div>
    </section>,
    { title: org.name },
  );
});

app.post("/o/:name/invite", authed, async (c) => {
  const [org, { email }] = await Promise.all([getOrg(c), form(c)]);
  if (org.created_by !== c.get("name"))
    throw new HTTPException(403, { message: "Only owner can invite" });
  if (!email || !email.includes("@") || email.length < 4 || email.length > 64)
    throw new HTTPException(400, { message: "Invalid email" });

  const [existing] = await sql`select name, orgs_r from usr where email = ${email}`;
  if (existing?.orgs_r.includes(org.name)) return c.redirect(`/o/${org.name}`);

  const newQty = await subQty(org.stripe_sub_id, 1);
  try {
    if (existing)
      await sql`update usr set orgs_r = array_append(orgs_r, ${org.name}), orgs_w = array_append(orgs_w, ${org.name}) where name = ${existing.name}`;
    else {
      const newName = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      await sql`insert into usr (name, email, bio, invited_by, orgs_r, orgs_w) values (${newName}, ${email}, '...', ${c
        .get(
          "name",
        )!}, ${[org.name]}, ${[org.name]})`;
      await sendVerify(email);
    }
  } catch (err) {
    console.error(
      `DRIFT invite: bumped ${org.stripe_sub_id} to qty=${newQty} but SQL write for ${email} in ${org.name} failed.`,
      err,
    );
    throw err;
  }
  return c.redirect(`/o/${org.name}`);
});

app.post("/o/:name/remove", authed, async (c) => {
  const [org, { name: paramName }] = await Promise.all([getOrg(c), form(c)]);
  const me = c.get("name");
  const isOwner = org.created_by === me;
  const isSelfLeave = paramName === me;
  if (isOwner && isSelfLeave) {
    throw new HTTPException(400, {
      message: "Owner cannot leave their own org — transfer or delete it first",
    });
  }
  if (!isOwner && !isSelfLeave)
    throw new HTTPException(403, { message: "Only owner or self can remove" });

  const [member] = await sql`select name from usr where name = ${paramName} and ${org.name} = any(orgs_r)`;
  if (!member) {
    throw new HTTPException(404, {
      message: `${paramName} is not a member of ${org.name}`,
    });
  }

  const newQty = await subQty(org.stripe_sub_id, -1);
  try {
    await sql`update usr set orgs_r = array_remove(orgs_r, ${org.name}), orgs_w = array_remove(orgs_w, ${org.name}) where name = ${paramName}`;
  } catch (err) {
    console.error(
      `DRIFT remove: decremented ${org.stripe_sub_id} to qty=${newQty} but SQL update for ${paramName} in ${org.name} failed.`,
      err,
    );
    throw err;
  }
  return c.redirect(`/o/${org.name}`);
});

app.post("/api/stripe-webhook", async (c) => {
  const sig = c.req.header("stripe-signature");
  const body = await c.req.text();
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig!,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
    );
  } catch (_err) {
    throw new HTTPException(400, { message: `Webhook Error` });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { orgName, creatorName } = session.metadata ?? {};
    if (!orgName || !creatorName || !session.subscription) {
      throw new HTTPException(400, {
        message: "checkout.session.completed missing orgName/creatorName/subscription",
      });
    }
    await createOrg(orgName, creatorName, session.subscription as string);
  } else if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const [org] = await sql`select name from org where stripe_sub_id = ${sub.id}`;
    if (org) {
      await sql.begin(async (tx) => {
        const sql = tx;
        await sql`update usr set orgs_r = array_remove(orgs_r, ${org.name}), orgs_w = array_remove(orgs_w, ${org.name})`;
        await sql`delete from org where name = ${org.name}`;
      });
    }
  }
  return c.text("Received", 200);
});

app.get("/c/:cid/delete", authed, async (c) => {
  const [cm] = await sql`select body from com where cid = ${c.req.param("cid")} and created_by = ${c.get("name")!}`;
  if (!cm) return notFound();
  return c.render(
    <section>
      <h2>Delete?</h2>
      <pre>{cm.body.slice(0, 200)}</pre>
      <form method="post">
        <button type="submit">confirm</button> <a href={`/c/${c.req.param("cid")}`}>cancel</a>
      </form>
    </section>,
    { title: "delete" },
  );
});

app.post("/c/:cid/delete", authed, async (c) => {
  const [cm] = await sql`update com set body = '' where cid = ${c.req.param("cid")} and created_by = ${c.get(
    "name",
  )!} returning parent_cid`;
  return c.redirect(cm?.parent_cid ? `/c/${cm.parent_cid}` : "/");
});

app.get("/key", authed, async (c) => {
  const [u] = await sql`select seckey_enc from usr where name = ${c.get("name")!}`;
  if (!u?.seckey_enc)
    throw new HTTPException(404, { message: "No custodial key to download — you're already self-custody." });
  return c.body(await unwrapSecret(u.seckey_enc, KEY_WRAP_SECRET), 200, {
    "content-type": "application/json",
    "content-disposition": `attachment; filename="ding-key.json"`,
  });
});

app.post("/key/delete", authed, async (c) => {
  await sql`update usr set seckey_enc = null where name = ${c.get("name")!}`;
  return ok(c);
});

export const postRate = new Map<string, number[]>();
const POST_RATE_MAX = 10,
  POST_RATE_MS = 60_000;

// Where a form POST sends the browser back to. Same-host only — an attacker-supplied
// Referer must not turn our 302 into an open redirect. A leading `//` is rejected too:
// `https://ding.bar//evil.com` passes the host check but its pathname is a
// protocol-relative URL, and browsers follow that off-site.
const refBack = (c: Context): string | null => {
  const ref = c.req.header("referer");
  if (!ref) return null;
  try {
    const u = new URL(ref);
    if (u.host !== c.req.header("host") || u.pathname.startsWith("//")) return null;
    return u.pathname + u.search;
  } catch {
    return null;
  }
};

// The ONE definition of "someone posts something". POST /c parses a form into this; the bot
// fleet calls it directly, skipping HTTP, routing, middleware and a bcrypt auth per request.
// Every check the route used to do lives here — rate limit, parent ACL, org write permission,
// self-react/self-flag, reaction toggle, dht signing — so calling it directly cannot bypass
// one. Outcomes are returned rather than redirected: the route turns them into redirects, the
// bots turn them into a boolean.
export type PostOutcome =
  | { kind: "created"; cid: number; parentCid: number | null; grandparent: number | null }
  | { kind: "unreacted"; parentCid: number; grandparent: number | null }
  | { kind: "flagged"; parentCid: number; grandparent: number | null }
  | { kind: "self"; what: "react" | "flag"; parentCid: number; grandparent: number | null };

export const createPost = async (
  author: string,
  body: string,
  opts: { parentCid?: number | string | null; labels?: string } = {},
): Promise<PostOutcome> => {
  const pid = opts.parentCid ?? null;
  if (!rateHit(postRate, author, POST_RATE_MAX, POST_RATE_MS))
    throw new HTTPException(429, { message: "slow down. try again in a minute." });

  const [usr] = await sql`select orgs_w, orgs_r from usr where name = ${author}`;
  if (!usr) throw new HTTPException(401, { message: `no such user @${author}.` });
  let tags: string[], orgs: string[], usrs: string[];
  type Prm = {
    tags: string[];
    orgs: string[];
    usrs: string[];
    created_by: string;
    prm_parent: number | null;
    prm_hash: string | null;
    domains: string[];
    flaggers: string[];
  };
  let prm: Prm | undefined;

  if (pid) {
    [prm] = await sql<
      Prm[]
    >`select tags, orgs, usrs, created_by, parent_cid as prm_parent, hash as prm_hash, domains, flaggers from com where cid = ${pid}`;
    if (!prm) throw new HTTPException(404, { message: "Parent post not found." });
    if (
      !prm.orgs.every((t) => usr.orgs_r.includes(t)) ||
      (prm.usrs.length && !prm.usrs.includes(author) && prm.created_by !== author)
    ) {
      throw new HTTPException(403, { message: "You don't have access to that thread." });
    }
    tags = prm.tags;
    orgs = prm.orgs;
    usrs = prm.usrs;

    if (isReaction(body)) {
      if (prm.created_by === author)
        return { kind: "self", what: "react", parentCid: +pid, grandparent: prm.prm_parent };
      const [existing] =
        await sql`select cid from com where parent_cid = ${pid} and created_by = ${author} and body = ${body} and char_length(body) = 1 limit 1`;
      if (existing) {
        await sql.begin((tx) => {
          const sql = tx;
          return Promise.all([
            sql`delete from com where cid = ${existing.cid}`,
            sql`update com set c_reactions = c_reactions || hstore(${body}, greatest(coalesce((c_reactions->${body})::int,0)-1, 0)::text) where cid = ${pid}`,
          ]);
        });
        await refreshScores(pid);
        return { kind: "unreacted", parentCid: +pid, grandparent: prm.prm_parent };
      }
    }
  } else {
    const l = parseLabels(opts.labels ?? "");
    if (!l.tag.length && !l.usr.length && !l.org.length)
      throw new HTTPException(400, { message: "post needs at least one #tag, *org, or @user recipient" });
    const badOrg = l.org.find((t) => !usr.orgs_w.includes(t));
    if (badOrg) throw new HTTPException(403, { message: `you cannot write to org *${badOrg}` });
    tags = l.tag;
    orgs = l.org;
    usrs = l.usr;
  }

  if (pid && prm && body === "flag") {
    if (prm.created_by === author)
      return { kind: "self", what: "flag", parentCid: +pid, grandparent: prm.prm_parent };
    if (prm.prm_hash) {
      // signed post -> sign a flag row; ingestMsg recomputes c_flags from distinct flaggers
      const key = await ensureKey(author);
      await ingestMsg(await signRow("flag", nowSec(), { target: prm.prm_hash }, key.priv, key.pub));
    } else if (!prm.flaggers.includes(author)) {
      await sql`update com set c_flags = c_flags + 1, flaggers = array_append(flaggers, ${author}) where cid = ${pid}`;
    }
    return { kind: "flagged", parentCid: +pid, grandparent: prm.prm_parent };
  }

  // Sign PUBLIC root posts and public replies-to-signed-parents into the dht log.
  // Reactions, *org / @usr (private) posts, and replies-to-legacy-posts stay on the
  // unsigned com path so private bodies never enter the public log (Phase 1 scope).
  const parentHash = pid ? prm?.prm_hash ?? null : null;
  let cm: { cid: number };
  if (!isReaction(body) && !orgs.length && !usrs.length && (!pid || parentHash)) {
    const key = await ensureKey(author);
    const payload = buildMsg({ parent: parentHash ?? undefined, tags, orgs, usrs, body });
    const row = await signRow("msg", nowSec(), payload, key.priv, key.pub);
    const { cid } = await ingestMsg(row, { parentCid: pid ? +pid : null, comTags: tags });
    if (cid == null) throw new HTTPException(500, { message: "post was logged but its com projection is missing." });
    cm = { cid };
  } else {
    const { mentions, links, domains, thumb } = await deriveBody(body, !pid);
    [cm] =
      await sql`insert into com (parent_cid, created_by, body, tags, orgs, usrs, mentions, links, thumb, domains) values (${pid}, ${author}, ${body}, ${tags}, ${orgs}, ${usrs}, ${mentions}, ${links}, ${thumb}, ${domains}) returning cid`;
    if (pid) {
      await bumpCounts(sql, pid, body);
      await refreshScores(pid);
    } else {
      await refreshScores(cm.cid);
    }
  }
  return { kind: "created", cid: cm.cid, parentCid: pid ? +pid : null, grandparent: prm?.prm_parent ?? null };
};

app.post("/c/:p?", async (c) => {
  const pid = c.req.param("p") || null;
  const n = await viewer(c);
  if (!n)
    return c.redirect(`/u?next=${encodeURIComponent(pid ? `/c/${pid}` : "/")}`);

  const f = await c.req.formData();
  const r = await createPost(n, f.get("body")?.toString() || "", {
    parentCid: pid,
    labels: f.get("tags")?.toString() || "",
  });

  // Redirect shapes are unchanged from when this logic lived inline; only their inputs
  // now come from the outcome instead of local state.
  const thread = () => threadUrl(r.grandparent, String(r.parentCid));
  if (r.kind === "self") return c.redirect(`${thread()}?err=self-${r.what}`);
  if (r.kind === "flagged") return c.redirect(thread());
  if (r.kind === "unreacted") {
    const ref = refBack(c);
    return c.redirect(ref ? `${ref}#${r.parentCid}` : thread());
  }
  if (r.parentCid === null) return c.redirect(`/c/${r.cid}`);
  if (isReaction(f.get("body")?.toString() || "")) {
    const ref = refBack(c);
    if (ref) return c.redirect(`${ref}#${r.parentCid}`);
  }
  return c.redirect(r.grandparent ? thread() : `/c/${r.parentCid}#${r.cid}`);
});

// Tuning a row of chips is a handful of clicks, so postRate's 10/min would break it.
export const prefRate = new Map<string, number[]>();
const PREF_RATE_MAX = 60,
  PREF_RATE_MS = 60_000;

// The one write path for prefs. A pref is a label plus a vote, so the form carries the
// label as a sigil string (`#humor`, `@jane_doe`, `~arxiv.org`) and parseLabels does the
// parsing — same vocabulary the feed and search box already speak. `*org` is rejected:
// org access is orgs_r/orgs_w membership, not a preference.
app.post("/p", async (c) => {
  const n = await viewer(c);
  const back = refBack(c) ?? "/";
  if (!n) return c.redirect(`/u?next=${encodeURIComponent(back)}`);
  if (!rateHit(prefRate, n, PREF_RATE_MAX, PREF_RATE_MS))
    throw new HTTPException(429, { message: "slow down. try again in a minute." });

  const f = await form(c),
    raw = (f.label ?? "").trim(),
    vote = f.vote === "1" ? 1 : f.vote === "-1" ? -1 : null;
  if (vote === null) {
    throw new HTTPException(400, {
      message: `vote must be "1" (▲) or "-1" (▼), got "${f.vote ?? ""}".`,
    });
  }
  // Postgres text cannot hold a NUL; without this the driver raises and the user gets an
  // opaque 500 instead of the one thing they could act on.
  if (raw.includes("\0"))
    throw new HTTPException(400, { message: "label contains a NUL byte." });

  const l = parseLabels(raw),
    picked = (["tag", "usr", "www"] as const).filter((k) => l[k].length);
  if (l.text || l.org.length || picked.length !== 1 || l[picked[0]].length !== 1) {
    throw new HTTPException(400, {
      message:
        `cannot vote on "${raw}" — send exactly one label: #tag, @user, or ~domain. (*org is not votable: org access is membership.)`,
    });
  }
  const kind = picked[0];
  let val = kind === "www" ? normHost(l.www[0]) : l[kind][0];
  if (!val) throw new HTTPException(400, { message: `"${raw}" has a sigil but no label after it.` });

  // ~domain has a closed vocabulary — extractDomains only ever produces bare hostnames — so
  // anything else is a pref that could never match a post. #tag is free-form by design.
  if (kind === "www" && !HOST_RE.test(val)) {
    throw new HTTPException(400, {
      message: `~${val} is not a hostname. Use the bare host, e.g. ~arxiv.org — not a URL, path, or scheme.`,
    });
  }

  if (kind === "usr") {
    // LabelVote is never rendered on your own profile, so reaching here means a hand-made
    // request. Say so plainly rather than redirecting to a page that renders no error.
    if (val.toLowerCase() === n.toLowerCase())
      throw new HTTPException(400, { message: `you cannot follow or mute yourself (@${n}).` });
    // Only validate when this will INSERT. pref.val has no FK (a partial one isn't
    // expressible), so a followed account that is later deleted leaves the row behind —
    // and rejecting the removal too would strand it on /u forever.
    const [have] = await sql`select 1 from pref where uid = ${n} and kind = 'usr' and val = ${val}`;
    if (!have) {
      const [u] = await sql<{ name: string }[]>`select name from usr where name = ${val}`;
      if (!u) throw new HTTPException(404, { message: `no user named @${val}.` });
      val = u.name; // store the canonical casing, not whatever the form carried
    }
  }

  // Toggle in one statement: re-sending the same vote clears it, the opposite vote
  // replaces it. `del` is a data-modifying CTE, so postgres runs it to completion even
  // when the insert is skipped, and the primary key makes a concurrent double-click safe.
  await sql`
    with del as (delete from pref where uid = ${n} and kind = ${kind} and val = ${val} and vote = ${vote} returning 1)
    insert into pref (uid, kind, val, vote)
    select ${n}, ${kind}, ${val}, ${vote} where not exists (select 1 from del)
    on conflict (uid, kind, val) do update set vote = excluded.vote, created_at = current_timestamp`;
  return c.redirect(back);
});

app.get("/c/:cid?", async (c) => {
  const q = c.req.query(),
    cid = c.req.param("cid"),
    n = await viewer(c),
    s = q.sort || "hot",
    lim = Math.min(100, Math.max(1, Math.trunc(+(q.limit || 25)) || 25)),
    p = pageParam(q.p, lim);
  const [u] = n ? await sql`select orgs_r from usr where name = ${n}` : [{ orgs_r: [] }];
  const rT = u?.orgs_r || [],
    tags = c.req.queries("tag") || [],
    orgs = c.req.queries("org") || [],
    usrs = c.req.queries("usr") || [],
    mens = c.req.queries("mention") || [],
    // com.domains holds bare hosts, so ?www=www.arxiv.org matched nothing. Normalizing here
    // fixes the filter and keeps the ~domain vote button reading the same key POST /p writes.
    www = (c.req.queries("www") || []).map(normHost);

  const items = await feedPosts({
    cid,
    viewer: n || "",
    orgsR: rT,
    tags,
    orgs,
    usrs,
    mentions: mens,
    www,
    q: q.q,
    repliesTo: q.replies_to,
    reactionsOnly: !!q.reactions,
    commentsOnly: !!q.comments,
    sort: s,
    limit: lim,
    offset: p * lim,
  });

  if (host(c) === "api") return c.json(items);
  if (host(c) === "rss") {
    return c.text(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>ding</title><link>https://ding.bar/</link>${
        items
          .map(
            (i) =>
              `<item><title>${escapeXml(i.body.slice(0, 60))}</title><link>https://ding.bar/c/${i.cid}</link><pubDate>${
                new Date(
                  i.created_at,
                ).toUTCString()
              }</pubDate></item>`,
          )
          .join("")
      }</channel></rss>`,
      200,
      { "Content-Type": "application/rss+xml" },
    );
  }

  if (!cid) {
    const cur = new URL(c.req.url).searchParams,
      meta = buildFilterTitle(cur);
    // An InfoBlock describes ONE subject, so it only renders when exactly one label filter
    // is active and nothing else narrows the feed. www joins tag/org/usr here — it used to
    // be part of the "nothing else" set, so ?www= had no header at all.
    const onlyFilter = !mens.length && !q.q && !q.reactions && !q.replies_to && !q.comments &&
      tags.length + orgs.length + usrs.length + www.length === 1;
    const singleTag = onlyFilter && tags.length === 1 ? tags[0] : null;
    const singleOrg = onlyFilter && orgs.length === 1 ? orgs[0] : null;
    const singleUsr = onlyFilter && usrs.length === 1 ? usrs[0] : null;
    // A hostname the feed could actually hold — otherwise the block would present an
    // attacker-chosen `?www=` value as "the domain this page is about", link to it, and
    // offer follow buttons for something that can never match a post.
    const singleWww = onlyFilter && www.length === 1 && HOST_RE.test(www[0]) ? www[0] : null;
    // The viewer's ▲/▼ on whichever single label this page is about (tags/users/domains
    // only — *org access is membership, not a preference). Every consumer is gated on a
    // logged-in viewer, so anonymous hits — i.e. crawlers — must not pay for this.
    const [labelPref] = n && (singleTag || singleUsr || singleWww)
      ? await prefStat(n, singleTag ? "tag" : singleUsr ? "usr" : "www", (singleTag || singleUsr || singleWww)!)
      : [null];
    const tagCount = singleTag
      ? (
        await sql`select count(*)::int as count from com where ${singleTag} = any(tags) and ${visibleTo(rT, n || "")}`
      )[0].count
      : null;
    const orgInfo = singleOrg
      ? (
        await sql`select (select count(*)::int from usr where ${singleOrg} = any(orgs_r)) as member_count, (select created_by from org where name = ${singleOrg}) as created_by`
      )[0]
      : null;
    const usrRow = singleUsr
      ? (
        await sql`select u.name, u.bio, (select count(*)::int from com where created_by = ${singleUsr} and parent_cid is null and orgs <@ ${rT}::text[]) as post_count from usr u where u.name = ${singleUsr}`
      )[0]
      : null;
    const userMatches = q.q
      ? await sql<{ name: string }[]>`select name from usr
                   where name ilike ${"%" + q.q + "%"} or bio ilike ${"%" + q.q + "%"}
                   order by (name ilike ${q.q + "%"}) desc, length(name) asc
                   limit 5`
      : [];
    return c.render(
      <>
        <section>
          <form id="search-form" method="get" action="/c" class="search-form">
            <input
              name="search"
              aria-label="search"
              value={decodeLabels(cur)}
            />
            <button type="submit">search</button>
          </form>
          <ActiveFilters params={cur} />
          {singleTag && (
            <InfoBlock
              head={<>#{singleTag}</>}
              vote={n && labelPref && <LabelVote label={`#${singleTag}`} vote={labelPref.vote} ups={labelPref.ups} />}
              note={<>{tagCount} post{tagCount === 1 ? "" : "s"}</>}
              postTo={<a href={`/?tag=${singleTag}`}>post to #{singleTag}</a>}
            />
          )}
          {singleOrg && (
            <InfoBlock
              head={<>*{singleOrg}</>}
              note={
                <>
                  {orgInfo?.member_count} member{orgInfo?.member_count === 1 ? "" : "s"}
                  {orgInfo?.created_by && (
                    <>
                      {" · "}created by{" "}
                      <a href={`/u/${orgInfo.created_by}`}>{Check(orgInfo.created_by)}@{orgInfo.created_by}</a>
                      {" · "}
                      <a href={`/o/${singleOrg}`}>settings</a>
                    </>
                  )}
                </>
              }
              postTo={<a href={`/?org=${singleOrg}`}>post to *{singleOrg}</a>}
            />
          )}
          {singleUsr && usrRow && (
            <InfoBlock
              head={<>{Check(singleUsr)}@{singleUsr}</>}
              vote={n && labelPref && n.toLowerCase() !== singleUsr.toLowerCase() && (
                <LabelVote label={`@${singleUsr}`} vote={labelPref.vote} ups={labelPref.ups} />
              )}
              note={
                <>
                  {usrRow.post_count} post{usrRow.post_count === 1 ? "" : "s"}
                  {" · "}
                  <a href={`/u/${singleUsr}`}>profile</a>
                </>
              }
              postTo={<a href={`/?usr=${singleUsr}`}>post to {Check(singleUsr)}@{singleUsr}</a>}
            />
          )}
          {singleWww && (
            <InfoBlock
              head={<>~{singleWww}</>}
              vote={n && labelPref && <LabelVote label={`~${singleWww}`} vote={labelPref.vote} ups={labelPref.ups} />}
              note={<a href={`https://${singleWww}`} rel="noopener nofollow">{singleWww}</a>}
              postTo={<a href={`/?body=https://${singleWww}/`}>post a {singleWww} link</a>}
            />
          )}
          {!singleTag && !singleOrg && !singleUsr && !singleWww && meta && <h2>{meta}</h2>}
          {q.q && userMatches.length > 0 && (
            <div class="user-matches">
              {userMatches.map((u) => (
                <a key={u.name} href={`/c?usr=${u.name}`}>
                  {Check(u.name)}@{u.name}
                </a>
              ))}
            </div>
          )}
          <SortToggle sort={s} baseHref={`/c?${cur}`} title="results" />
        </section>
        <section>
          {items.length === 0
            ? (
              <p class="empty">
                no results. <a href="/c">clear filters</a> or <a href="/">back to home</a>.
              </p>
            )
            : <div class="posts">{items.map((i) => Post(i, n, cur))}</div>}
        </section>
        <Pagination base="/c" cur={cur} p={p} more={items.length === lim && (p + 1) * lim <= paging.maxOffset} />
      </>,
      { title: meta || "search" },
    );
  }

  const post = items[0];
  if (!post) return notFound();
  const backlinks = await sql<
    { cid: number; body: string }[]
  >`select cid, body, created_at from com where parent_cid is null and links @> array[${post.cid}::int] and ${
    visibleTo(rT, n || "")
  } order by created_at desc limit 5`;
  const replies = (post.child_comments || []).filter(
    (r: ChildCom) => !isReaction(r.body),
  );
  const errMsg: Record<string, string> = {
    "self-react": "you cannot react to your own post",
    "self-flag": "you cannot flag your own post",
  };
  return c.render(
    <>
      {q.err && errMsg[q.err] && (
        <section>
          <p class="error">{errMsg[q.err]}</p>
        </section>
      )}
      <section>
        {Comment(
          {
            ...post,
            child_comments: (post.child_comments || []).filter((r: ChildCom) => isReaction(r.body)),
          } as Com,
          n,
          true,
        )}
      </section>
      <section>
        {n
          ? (
            <form method="post" action={`/c/${post.cid}`} class="upload-form">
              <textarea
                aria-label="reply"
                required
                name="body"
                rows={6}
              >
              </textarea>
              <div class="post-form__row">
                <ComposeTools />
                <button type="submit">reply</button>
              </div>
            </form>
          )
          : (
            <form method="post" action="/signup">
              <p>create an account to reply</p>
              <label>
                username
                <input
                  type="text"
                  name="name"
                  pattern="^[0-9a-zA-Z_]{4,32}$"
                  required
                />
              </label>
              <label>
                email
                <input type="email" name="email" required />
              </label>
              <button type="submit">create account</button>
              <p class="note-sm">
                already have one?{" "}
                <a href={`/u?next=${encodeURIComponent(`/c/${post.cid}`)}`}>
                  log in
                </a>
              </p>
            </form>
          )}
        <SortToggle sort={s} baseHref={`/c/${cid}`} title="comments" />
      </section>
      <section>
        {replies.length === 0 ? <p class="empty">no replies yet{n ? ". be the first." : "."}</p> : (
          replies.map((r: ChildCom) => Comment(r, n))
        )}
      </section>
      {backlinks.length > 0 && (
        <section>
          <h3>backlinks</h3>
          <div class="backlinks">
            {backlinks.map((bl) => (
              <div key={bl.cid}>
                <a href={`/c/${bl.cid}`}>
                  {bl.body.trim().split("\n")[0].slice(0, 60)}
                </a>
              </div>
            ))}
          </div>
        </section>
      )}
    </>,
    { title: post.body.slice(0, 16) },
  );
});

app.get("/img", async (c) => {
  const url = c.req.query("url");
  if (!url) throw new HTTPException(400, { message: "missing ?url=" });
  if (!/^https?:\/\//.test(url))
    throw new HTTPException(400, { message: "invalid url" });
  const res = await fetch(url, {
    headers: { "User-Agent": "ding/1.0" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok)
    throw new HTTPException(502, { message: `upstream ${res.status}` });
  const ct = res.headers.get("content-type") || "image/png";
  if (!ct.startsWith("image/"))
    throw new HTTPException(400, { message: "not an image" });
  return new Response(res.body, {
    headers: {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
});

// Read-only comment widget for static sites: <iframe src="https://ding.bar/embed?url=PAGE_URL">.
// Never consults the viewer's cookie — only public root posts may render inside a foreign page.
app.get("/embed", async (c) => {
  c.header("Content-Security-Policy", "frame-ancestors *");
  c.header("X-Robots-Tag", "noindex");
  const page = (inner: HtmlEscapedString | Promise<HtmlEscapedString>) =>
    html`
      <!DOCTYPE html>
      <html>
        <head>
          <title>ding embed</title>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <base target="_blank" />
          <link rel="stylesheet" href="https://ding.bar${assetUrl("/style.css")}" />
        </head>
        <body class="embed">
                ${inner}
                <p class="embed-footer"><a href="https://ding.bar/">✦ ding</a></p>
              </body>
      </html>
    `;
  const url = (c.req.query("url") || "").trim().replace(/\/+$/, "");
  let domain: string;
  try {
    if (!/^https?:\/\//.test(url)) throw new Error("not http(s)");
    domain = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return c.html(
      page(html`
        <p class="error">/embed needs a full page URL, e.g. /embed?url=https://example.com/post</p>
        <pre>&lt;iframe src="https://ding.bar/embed?url=PAGE_URL" style="width:100%;height:400px;border:0"&gt;&lt;/iframe&gt;</pre>
      `),
      400,
    );
  }
  // strpos, not ilike/like — URLs routinely contain % and _.
  const posts = await sql<Com[]>`
    select c.cid, c.body, c.created_by, c.hash, c.c_flags, ${aggCols("c", "")},
      array(select jsonb_build_object('body', ch.body, 'created_by', ch.created_by, 'cid', ch.cid, 'c_flags', ch.c_flags, 'hash', ch.hash)
        from com ch where ch.parent_cid = c.cid and char_length(ch.body) > 1
          and ch.orgs = '{}' and ch.usrs = '{}'
        order by ch.created_at asc limit 20) as child_comments
    from com c
    where c.parent_cid is null and c.orgs = '{}' and c.usrs = '{}' and char_length(c.body) > 1
      and c.domains @> ${[domain]}::text[]
      and strpos(c.body, ${url}) > 0
    order by c.created_at asc limit 5
  `;
  return c.html(page(
    posts.length ? html`${posts.map((p) => EmbedComment(p))}` : html`
      <p class="empty">
        no discussion yet — <a href="https://ding.bar/?www=${domain}&body=${encodeURIComponent(
          url,
        )}">start one on ding</a>
      </p>
    `,
  ));
});

const MB = 1024 * 1024;

app.post("/i", authed, async (c) => {
  // Refuse on the DECLARED size first. Every check below needs the whole body in memory, so
  // without this a caller that skips the client-side check makes the isolate buffer the lot
  // just to reject it. The slack covers multipart framing around the file itself.
  const declared = +(c.req.header("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES + MB) {
    throw new HTTPException(413, {
      message: `upload is ${(declared / MB).toFixed(1)} MB — the limit is ${MAX_UPLOAD_BYTES / MB} MB.`,
    });
  }

  // A client that goes away mid-upload (closed tab, dropped mobile connection, a proxy
  // timing out) makes this throw "error reading a body from connection", which otherwise
  // becomes a bare 500 and a stack trace in the logs — telling neither the user nor us
  // anything actionable. It is a client-side truncation, so name it and return 400.
  let f: FormData;
  try {
    f = await c.req.formData();
  } catch (e) {
    throw new HTTPException(400, {
      message: `upload did not finish — the connection dropped before the whole file arrived (${
        e instanceof Error ? e.message : e
      }). nothing was saved; try again.`,
    });
  }

  const id = f.get("id")?.toString() ?? "";
  const file = f.get("file");
  if (!(file instanceof File)) {
    throw new HTTPException(400, {
      message: `expected a "file" part in the form, got ${id ? `only "id"` : "nothing"}.`,
    });
  }
  const m = id.match(IMG_EXT_RE);
  if (!m) {
    throw new HTTPException(400, {
      message: `bad id "${id}" — expected 8 letters/digits then one of ${
        Object.keys(MIME_BY_EXT).join(", ")
      } (e.g. a1b2c3d4.png).`,
    });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new HTTPException(413, {
      message: `${file.name || id} is ${(file.size / MB).toFixed(1)} MB — the limit is ${MAX_UPLOAD_BYTES / MB} MB.`,
    });
  }
  const ext = m[2].toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  await r2.uploadToR2(bytes, `${m[1]}.${ext}`, MIME_BY_EXT[ext], "i/");
  return c.body(null, 204);
});

app.use("/*", serveStatic({ root: "./public" }));

//// BOT FLEET ////

// Bots used to run as a GitHub Actions matrix POSTing to https://ding.bar, then in-process
// through `app.request`. They now call the database directly via feedPosts/createPost.
//
// The in-process HTTP hop was not free: every bot action re-ran routing, the whole middleware
// chain, and Basic Auth — and Basic Auth is a bcrypt comparison inside Postgres, measured at
// ~49ms of database CPU per request. Across 46 bots on a 5-minute tick that was the single
// largest source of load on the database, spent re-proving credentials the process already had.
//
// The ACL did NOT come from the HTTP layer, which is why this is safe: visibleTo lives inside
// feedPosts and every parent/org/self check lives inside createPost, so the direct callers are
// gated by the same code the route is. The password is still verified — once per bot per run,
// in botApi — because that is what stops a mistyped BOT_<N>_EMAIL from posting as someone else.
const BOT_CONCURRENCY = 4;
const BOT_TIMEOUT_MS = 90_000;

export const botApi = async (envPrefix: string): Promise<Api | null> => {
  const email = Deno.env.get(`BOT_${envPrefix}_EMAIL`), password = Deno.env.get(`BOT_${envPrefix}_PASSWORD`);
  if (!email || !password) return null;
  const [usr] = await sql<{ name: string; orgs_r: string[] }[]>`
    select name, orgs_r from usr where email = ${email} and password = crypt(${password}, password)`;
  if (!usr) throw new Error(`bot ${envPrefix}: BOT_${envPrefix}_EMAIL/_PASSWORD do not match any user`);
  return {
    botUsername: usr.name,
    orgsR: usr.orgs_r,
    feed: async (q) => {
      const rows = await feedPosts(q as FeedQuery);
      // Bots were written against JSON responses, so hand them JSON-shaped rows: postgres.js
      // returns Date objects where the wire returned ISO strings, and a bot comparing those
      // as text would silently stop matching.
      return JSON.parse(JSON.stringify(rows));
    },
    post: async (body, o) => {
      try {
        await createPost(usr.name, body, o);
        return true;
      } catch (e) {
        // Same contract as the old postForm: log and report failure, never throw, so one
        // rejected post cannot abort the rest of a bot's run.
        console.error(`bot ${usr.name}: post failed — ${e instanceof Error ? e.message : e}`);
        return false;
      }
    },
  };
};

export async function runBotFleet(names: string[] = Object.keys(BOTS)) {
  const queue = [...names];
  let ok = 0, failed = 0, skipped = 0;
  const worker = async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      let api: Api | null;
      try {
        api = await botApi(name.toUpperCase());
      } catch (e) {
        failed++;
        console.error(`bot ${name}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (!api) {
        skipped++;
        console.warn(`bot ${name}: no BOT_${name.toUpperCase()}_EMAIL/_PASSWORD, skipping`);
        continue;
      }
      // One wedged bot must not hold the slot forever: Deno.cron skips a tick while the previous
      // run is still going, so an un-timed-out hang would silently stop the whole fleet.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          BOTS[name](api),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error(`timed out after ${BOT_TIMEOUT_MS}ms`)), BOT_TIMEOUT_MS);
          }),
        ]);
        ok++;
      } catch (e) {
        failed++;
        console.error(`bot ${name} failed: ${e instanceof Error ? e.message : e}`);
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: BOT_CONCURRENCY }, worker));
  console.log(`bot fleet: ${ok} ok, ${failed} failed, ${skipped} skipped`);
}

// Hourly checkmark cron via Deno.cron — registered ONLY on Deno Deploy (DENO_DEPLOYMENT_ID
// is unset locally/in tests, so this never fires there or trips the test sanitizer).
// SIMPLE path for now: DING_ORG_SK lives on the main server. Harden later by moving the cron
// to a separate Deno Deploy project (or GitHub Actions) so the trust root is off the public server.
if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
  Deno.cron("ding-checkmark", "0 * * * *", async () => {
    try {
      // Ingest marks straight into the dht via ingestMsg — NOT an HTTP POST back to our own
      // db.ding.bar (a Deno Deploy isolate fetching its own custom domain redirect-loops).
      await runCheckmark({
        sql,
        sink: async (rows) => {
          for (const row of rows) {
            try {
              await ingestMsg(row, { verify: true });
            } catch (e) {
              if (!(e instanceof DhtReject)) throw e;
              console.error(`checkmark: mark dropped — ${e.message}`);
            }
          }
        },
      });
    } catch (e) {
      console.error(`checkmark cron failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  // Daily: prune stale unverified self-signups. They have no password → no posts → no com rows,
  // so deletion is safe; `invited_by = name` limits it to self-signups (pending real invites kept).
  Deno.cron("ding-prune-unverified", "17 3 * * *", async () => {
    try {
      const gone = await sql`
        delete from usr
        where email_verified_at is null and invited_by = name
          and created_at < now() - interval '7 days'
        returning name
      `;
      if (gone.length) console.log(`pruned ${gone.length} stale unverified signups`);
    } catch (e) {
      console.error(`prune cron failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  Deno.cron("ding-bots", "*/5 * * * *", () => runBotFleet());

  // stat_tag is a snapshot now, so something has to take it. Every 10 minutes: the chips it
  // feeds are discovery, and its refresh_score term is slow-moving reputation, so staleness
  // of that order is invisible. pg_cron is available on Neon but this repo already schedules
  // everything here — one scheduler to reason about beats two.
  Deno.cron("ding-refresh-stats", "*/10 * * * *", async () => {
    try {
      await refreshStats();
    } catch (e) {
      console.error(`stat refresh cron failed: ${e instanceof Error ? e.message : e}`);
    }
  });
}

export default app;
