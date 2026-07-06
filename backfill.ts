#!/usr/bin/env -S deno run -A
// One-time history backfill: sign legacy PUBLIC com posts into the dht so the whole history
// is replicable, not just posts from launch onward. Mints a custodial key per author, signs
// each post with the original created_at as ts, and patches the existing com row (hash/
// author_id/sig/parent_hash/t) + inserts the dht row in one transaction.
//
// Resumable + idempotent: skips rows that already have a hash, so re-running continues.
// NOT backfilled: reactions (1-char), deleted (empty body), and *org/@usr private posts
// (those need id-scoping + the auth-gated delivery model). Replies to a parent that wasn't
// backfilled (yet) are skipped — the multi-pass runner re-signs them once the parent lands.
//
//   required: DATABASE_URL, KEY_WRAP_SECRET
//   optional: BACKFILL_LIMIT (rows/pass; default all), BACKFILL_CONCURRENCY (default 8)

import pg from "postgres";
import { buildMsg, ensureCustodialKey, signRow } from "./dht.ts";

type Sql = ReturnType<typeof pg>;
type ComRow = {
  cid: number;
  parent_cid: number | null;
  created_by: string;
  tags: string[];
  body: string;
  created_at: string;
};

export const backfill = async (
  sql: Sql,
  opts: { limit?: number; concurrency?: number } = {},
): Promise<{ signed: number; skipped: number }> => {
  const KEY_WRAP_SECRET = Deno.env.get("KEY_WRAP_SECRET") ?? (() => {
    throw new Error("KEY_WRAP_SECRET required");
  })();
  // Promise-cached so concurrent workers minting the same author share one mint.
  const cache = new Map<string, Promise<{ priv: CryptoKey; pub: string; id: string }>>();
  const keyFor = (name: string) => {
    let p = cache.get(name);
    if (p) return p;
    p = ensureCustodialKey(sql, name, KEY_WRAP_SECRET).then((key) => {
      if (!key) throw new Error(`@${name} is self-custody — cannot sign their history with a custodial key.`);
      return key;
    });
    cache.set(name, p);
    return p;
  };

  const rows = await sql<ComRow[]>`
    select cid, parent_cid, created_by, tags, body, created_at from com
    where hash is null and char_length(body) > 1 and orgs = '{}' and usrs = '{}' and created_by is not null
    order by cid asc ${opts.limit ? sql`limit ${opts.limit}` : sql``}`;

  const N = opts.concurrency ?? (+(Deno.env.get("BACKFILL_CONCURRENCY") ?? "8") || 8);
  let idx = 0, signed = 0, skipped = 0;
  const work = async () => {
    while (idx < rows.length) {
      const c = rows[idx++];
      let parentHash: string | null = null;
      if (c.parent_cid != null) {
        const [p] = await sql`select hash from com where cid = ${c.parent_cid}`;
        if (!p?.hash) { // reply to a not-yet-backfilled parent → a later pass catches it
          skipped++;
          continue;
        }
        parentHash = p.hash;
      }
      const payload = buildMsg({ parent: parentHash ?? undefined, tags: c.tags, body: c.body });
      if (!parentHash && (payload.tags as string[]).length === 0) { // invalid root (no parent, no labels)
        skipped++;
        continue;
      }
      const key = await keyFor(c.created_by);
      const ts = Math.floor(new Date(c.created_at).getTime() / 1000);
      const row = await signRow("msg", ts, payload, key.priv, key.pub);
      await sql.begin(async (tx: Sql) => {
        await tx`
          insert into dht (k, kind, pubkey, ts, sig, val, tags)
          values (${row.k}, 'msg', ${key.pub}, ${ts}, ${row.sig}, ${sql.json(payload)}, ${payload.tags as string[]})
          on conflict (k) do nothing`;
        await tx`
          update com set hash = ${row.k}, author_id = ${key.id}, sig = ${row.sig}, parent_hash = ${parentHash}, t = ${ts}
          where cid = ${c.cid} and hash is null`;
      });
      if (++signed % 500 === 0) console.log(`backfill: ${signed} signed…`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(N, rows.length) || 1 }, work));
  return { signed, skipped };
};

if (import.meta.main) {
  const sql = pg(Deno.env.get("DATABASE_URL")?.replace(/flycast/, "internal")!, { database: "ding", max: 12 });
  const limit = +(Deno.env.get("BACKFILL_LIMIT") ?? "0") || undefined;
  let total = 0, totalSkipped = 0, pass = 0;
  // Loop until a pass makes no progress: replies whose parents land mid-pass get caught next pass.
  while (true) {
    const { signed, skipped } = await backfill(sql, { limit });
    total += signed;
    totalSkipped = skipped;
    console.log(`backfill: pass ${++pass} — ${signed} signed, ${skipped} skipped`);
    if (signed === 0 || limit) break; // limit mode = single pass (for testing)
  }
  console.log(`backfill: done — ${total} signed across ${pass} pass(es), ${totalSkipped} unsignable remaining.`);
  await sql.end();
}
