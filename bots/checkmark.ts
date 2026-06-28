#!/usr/bin/env -S deno run -A
// ding checkmark cron (ding.bar-private; NOT a public server). The ONLY holder of
// DING_ORG_SK. Emits org-signed `mark` rows verifying identities, then POSTs them to
// the node for verification + storage.
//
// - email  : ding.bar already verifies emails (usr.email_verified_at) -> 100yr "email" mark.
// - dns    : a `usr` register link whose domain serves TXT _ding.<domain>=ding_id<id> -> 1day "dns:<domain>".
// - github : a `usr` register link to github.com/<handle> whose bio contains the id -> 1day "github:<handle>".
// DAY leases ARE the revocation mechanism: drop the TXT / edit the bio and the badge lapses.

import pg from "postgres";
import { buildMark, idOf, importPriv, type Row, signRow } from "../dht.ts";

type Sql = ReturnType<typeof pg>;
const YEAR = 365 * 86400, DAY = 86400;

// link -> {host, handle}. Accepts bare "taylor.town" or "github.com/you".
export const parseLink = (url: string): { host: string; handle: string } | null => {
  try {
    const u = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`);
    return {
      host: u.hostname.toLowerCase().replace(/^www\./, ""),
      handle: u.pathname.split("/").filter(Boolean)[0] ?? "",
    };
  } catch {
    return null;
  }
};

// DNS proof: TXT record at _ding.<domain> equal to `ding_id=<64hex>`. Returns the id or null.
export const dnsDingId = async (domain: string): Promise<string | null> => {
  for (const rec of await Deno.resolveDns(`_ding.${domain}`, "TXT").catch(() => [] as string[][])) {
    const m = rec.join("").match(/^ding_id=([0-9a-f]{64})$/);
    if (m) return m[1];
  }
  return null;
};

// GitHub proof: the id appears in the handle's profile bio. Handle is sanitized before
// interpolation (no SSRF / path injection).
export const githubDingId = async (handle: string, id: string): Promise<boolean> => {
  if (!/^[A-Za-z0-9-]+$/.test(handle)) return false;
  const res = await fetch(`https://api.github.com/users/${handle}`, { headers: { "user-agent": "ding" } });
  if (!res.ok) return false;
  return String((await res.json()).bio ?? "").includes(id);
};

// One cron run: issue any missing email/dns/github marks. Throws on misconfig/unreachable
// node (no Deno.exit — safe to call from Deno.cron or `deno run`). Only holder of DING_ORG_SK.
export const runCheckmark = async (opts: { sql?: Sql; sink?: (rows: Row[]) => Promise<void> } = {}) => {
  const DB = Deno.env.get("DING_DB") ?? "https://db.ding.bar";
  const ORG_PK = Deno.env.get("DING_ORG_PK"), ORG_SK = Deno.env.get("DING_ORG_SK");
  if (!ORG_PK || !ORG_SK) throw new Error("DING_ORG_PK and DING_ORG_SK (the org's private JWK) are required");
  const orgPriv = await importPriv(JSON.parse(ORG_SK));
  const sql = opts.sql ?? pg(Deno.env.get("DATABASE_URL")?.replace(/flycast/, "internal")!, { database: "ding" });
  try {
    const now = Math.floor(Date.now() / 1000);
    // current org-issued marks still comfortably fresh, keyed "<subject>:<claim>", so we don't
    // re-emit on every run (DAY marks renew only when within ~12h of expiry).
    const fresh = new Set(
      (await sql`
        select target, val->'mark'->>'v' as claim from dht
        where kind = 'mark' and pubkey = ${ORG_PK} and (val->'mark'->>'exp')::bigint > ${now + DAY / 2}`)
        .map((r: { target: string; claim: string }) => `${r.target}:${r.claim}`),
    );

    const rows: Row[] = [];
    const mark = async (subject: string, claim: string, exp: number) => {
      if (fresh.has(`${subject}:${claim}`)) return;
      rows.push(await signRow("mark", now, buildMark(subject, claim, exp), orgPriv, ORG_PK));
    };

    // email: every verified user with a key
    for (const u of await sql`select pubkey from usr where email_verified_at is not null and pubkey is not null`)
      await mark(await idOf(u.pubkey), "email", now + 100 * YEAR);

    // dns + github: every current usr register's links
    for (
      const reg
        of await sql`select distinct on (pubkey) pubkey, val from dht where kind = 'usr' order by pubkey, ts desc`
    ) {
      const id = await idOf(reg.pubkey);
      for (const link of (reg.val.links ?? []) as string[]) {
        const p = parseLink(link);
        if (!p) continue;
        try { // one flaky domain/handle must not abort the whole run
          if (p.host === "github.com") {
            if (await githubDingId(p.handle, id)) await mark(id, `github:${p.handle}`, now + DAY);
          } else if (await dnsDingId(p.host) === id) {
            await mark(id, `dns:${p.host}`, now + DAY);
          }
        } catch (e) {
          console.error(`checkmark: ${link} proof failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    if (!rows.length) return console.log("checkmark: nothing to mark");
    if (opts.sink) { // in-server cron: ingest straight into the dht (no HTTP loopback to our own domain)
      await opts.sink(rows);
      console.log(`checkmark: ingested ${rows.length} marks`);
    } else {
      const res = await fetch(DB, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: rows.map((r) => JSON.stringify(r)).join("\n"),
      });
      console.log(`checkmark: posted ${rows.length} marks → ${res.status} ${await res.text()}`);
    }
  } finally {
    if (!opts.sql) await sql.end(); // only close a connection we opened ourselves
  }
};

if (import.meta.main) {
  await runCheckmark().catch((e) => {
    console.error(`checkmark: ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  });
}
