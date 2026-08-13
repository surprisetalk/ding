# Prod migration: centralized → decentralized (DHT)

Rolling the DHT layer onto live ding (Deno Deploy `server.tsx` + Fly Postgres, `(www|api|rss|i).ding.bar`). The change
is **additive and rollback-safe**: every new column is nullable, `created_by` only drops NOT NULL, new tables start
empty, and legacy unsigned `com` rows keep rendering exactly as today. Old code runs fine against the migrated schema,
so **schema-first + code-rollback needs no schema revert**.

## ⚠️ Read first — irreversible / one-way doors

- **`KEY_WRAP_SECRET` is forever.** Custodial private keys are AES-256-GCM-encrypted under it. Lose it → every custodial
  key is unrecoverable (users must re-key). The server **refuses to boot without it**. Generate once, store in a secret
  manager + offline backup, never rotate casually (rotation = a decrypt-then-re-encrypt batch that only works while you
  still hold the old value).
- **`DING_ORG_SK` (checkmark trust root)** lives ONLY on the cron, never on the server. Leak → mass forged checkmarks.
  Rotation = publish a new org pubkey and update `DING_ORG_PK` (old marks lose trust).
- **Content permanence.** Once posts are signed into the public log and replicated to other nodes, they can't be
  unpublished — only flagged. Opening public `POST /db` ingest + replication is the one-way door; do it last.

## 0. One-time secrets & infra (before any deploy)

1. **`KEY_WRAP_SECRET`** — `openssl rand -hex 32` → set in Deno Deploy env (project `dong`). Back it up.
2. **Secrets** — run `deno run -A keygen.ts` locally (it generates `KEY_WRAP_SECRET` + a fresh trust-root keypair and
   prints exactly what to paste). All four go in **Deno Deploy env** (project `dong`): `KEY_WRAP_SECRET`, `DING_ORG_PK`,
   `DING_ORG_SK`, `DING_DB=https://db.ding.bar`. (The keys in `test_env.ts` are test-only/public — never reuse them.)
   The checkmark cron runs in-server via `Deno.cron` (registers only on Deno Deploy), so there's no GitHub Actions or
   separate project to set up. SIMPLE path: `DING_ORG_SK` lives on the main server for now — harden later by moving the
   cron to a separate Deno Deploy project (or GitHub Actions) so a server breach can't also mint fake checkmarks.
3. **`db.ding.bar`** — add it as a custom domain/subdomain on the Deno Deploy project (TLS), so `https://db.ding.bar`
   and `wss://db.ding.bar` route to `server.tsx` (it's served by the existing `host()` routing — no new app).

## 1. Migrate the schema (online, no downtime)

```bash
psql -d ding -f migrate.sql      # do NOT wrap in a transaction — CREATE INDEX CONCURRENTLY forbids it
```

Additive ALTERs are metadata-only (instant); `com` indexes use `CONCURRENTLY` (no table lock); `dht`/`used_nonce` are
new+empty. Idempotent and re-runnable. Validated against a copy of the old schema (legacy rows preserved). **This is
forward-compatible** — the currently-deployed code ignores the new columns/tables, so you can sit here safely before
deploying.

The tail of `migrate.sql` also `create or replace`s the **`stat_tag`** view so it only aggregates public root posts
(`orgs = '{}' and usrs = '{}'`) — without it, a tag used only inside a `*org` post can surface as a public frontpage
chip. Column list is unchanged, so the replace is instant and re-runnable. Expect `refresh_score`'s `tag_ups`/
`tag_downs` signal to shift slightly (private posts stop contributing); existing `score` values are not rewritten until
the next `refresh_score` call.

Smoke check — **must return zero rows**. It lists any tag the view still exposes that lives only on private posts:

```sql
select st.tag from stat_tag st
 where st.tag in (select unnest(tags) from com
                   where parent_cid is null and (orgs <> '{}' or usrs <> '{}'))
   and st.tag not in (select unnest(tags) from com
                       where parent_cid is null and orgs = '{}' and usrs = '{}');
```

`migrate.sql` also creates the **`pref`** table (per-user ▲/▼ on a `#tag` / `@usr` / `~www` label). New and empty, read
by nothing until the new code ships, so it is safe to apply early and safe to leave behind on a rollback. Smoke check —
**must return one row**:

```sql
select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid
 where c.relname = 'pref_target_idx' and i.indisvalid;
```

(`pg_indexes` would also list an INVALID index, which `create index if not exists` then skips forever — check
`indisvalid`, not mere existence.)

`migrate.sql` also adds **`com_root_score_idx`** (the logged-in feed's partial index — `CONCURRENTLY`, `com` is large
and live) and converts **`stat_tag` from a plain view to a MATERIALIZED view** (~350ms/read → ~2ms; it is read once per
logged-in frontpage load plus once per `refresh_score`). The conversion is wrapped in an explicit transaction, the one
exception to this file's no-`BEGIN` rule: nothing in that block is `CONCURRENTLY`, and without the transaction there is
a window where `stat_tag` does not exist and every logged-in frontpage 500s.

⚠️ **The matview is a snapshot with no self-refresh.** It is populated at migration time and then frozen until the
`ding-refresh-stats` `Deno.cron` ships — so run this migration _close to_ the deploy, not days ahead, or tag discovery
silently stops seeing new tags. Smoke check — **must return `m`**:

```sql
select relkind from pg_class where relname = 'stat_tag';
```

## 2. Deploy the new code

**Deno Deploy auto-deploys on push to `main`.** So the schema migration (step 1) MUST already be done — otherwise the
new code boots against a DB with no `dht` table and crashes. Order: env (step 0) → migrate (step 1) → **push**.

```bash
git push origin main     # triggers the Deno Deploy build + production deploy
```

Smoke-test (a test post writes a real `dht` row, which is harmless):

- [ ] site loads (server booted ⇒ `KEY_WRAP_SECRET` is set)
- [ ] log in; post `hello #migtest` → redirects to the post; it renders in the feed
- [ ] `select hash, author_id, t from com where body like 'hello%' order by cid desc limit 1` → all non-null
- [ ] `select kind from dht where kind='msg' limit 1` → a row exists
- [ ] `GET https://<preview>/c?tag=migtest` (Accept json) → contains the post
- [ ] `GET https://db.ding.bar/?q=$msg%20%23migtest` → NDJSON + `X-Ding-Cursor` header _(after step 3 routing)_
- [ ] `GET https://db.ding.bar/challenge` → `{nonce}`
- [ ] a custodial user's `GET /key` downloads a JWK; `POST /key/delete` works
- [ ] run one bot (`deno run -A bots/hn.ts` with its creds) → still posts (custodial key minted lazily)
- [ ] **behavior change to expect:** tags now render **sorted/deduped** (set semantics), not insertion order

Then **promote to production** (deployctl `--prod`, or the dashboard).

## 3. Turn on the decentralized surfaces (after prod is stable)

- **Read drain public:** `GET https://db.ding.bar/...` (and the `wss://` live-tail) — safe to expose; read-only.
- **Checkmark cron:** runs automatically in-server via `Deno.cron` ("ding-checkmark", hourly) once deployed with
  `DING_ORG_PK`/`DING_ORG_SK` set. First run mints `email` marks for every verified user (a one-time burst) +
  `dns:`/`github:` marks from `usr` registers. To trigger immediately instead of waiting, run `deno task checkmark`
  locally with the cron env set. Verify a known verified user shows a ✓ on `/c`.
- **`POST /db` ingest:** rate-limited (`dbIngestRate`): per-IP request cap (`reqPerMin`, default 300) + per-pubkey
  accepted-row cap (`rowsPerKeyPerMin`, default 120), in-memory per-isolate like `postRate`. Tune the limits for your
  traffic. Still **permissive on identity** (any valid signature accepted) — per-pubkey is sybil-bypassable since keys
  are free, so before a wide launch consider also requiring a checkmark to gossip unmarked authors beyond local. The
  per-isolate counters reset on isolate recycle; a DB/Redis counter is the next step if you need a hard global cap.
- **Mesh replica (`node.tsx`):** optional, later. Not required — Deno Deploy serves the WS live-tail itself (shared
  per-isolate `LISTEN/NOTIFY`). Run a replica only when you want a second node mirroring the log.

## 4. Backfill — decision required

- **Forward-only (recommended for v1):** only new posts enter the log; legacy `com` history stays unsigned/local. Zero
  migration risk. Trade-off: a fresh node mirroring `db.ding.bar` only gets posts from launch onward.
- **Sign history (`backfill.ts`, run once stable):** signs legacy PUBLIC posts into `dht` (mints a custodial key per
  author, `ts` = original `created_at`, patches `com.hash/author_id/sig/t` + inserts the `dht` row per post, in one
  transaction). Resumable + idempotent (skips rows that already have a `hash`). Reactions, deleted, and `*org`/`@usr`
  private posts are not backfilled; replies to a non-backfilled parent are skipped.
  ```bash
  BACKFILL_LIMIT=1000 deno task backfill   # dry-ish first pass (1000 rows), then re-run with no limit to finish
  ```
  Needs `DATABASE_URL` + `KEY_WRAP_SECRET`. Run forward-only first; do this when ready to make the whole history
  replicable to other nodes.

## Rollback

Fully safe. Redeploy the previous Deno Deploy deployment (dashboard or deployctl). The schema is additive so old code
ignores the new columns/tables; custodial keys / `dht` rows created during the window just sit unused. Disable the
checkmark cron. No schema revert needed (and none is safe to do while any new-code instance is live).

## Open hardening items (track before wide launch)

- **`POST /db` abuse:** rate-limited per-IP + per-pubkey (done). Remaining: a body byte-cap on the actual read (the
  `content-length` guard is spoofable), a global (DB/Redis) counter if per-isolate isn't enough, and optionally
  requiring a checkmark to gossip unmarked authors (closes the free-key sybil gap).
- **`ORG_SK` SPOF:** single env key on the cron; define a rotation runbook.
- **WS connection scale:** one shared `LISTEN` per isolate (already implemented); watch isolate count × 1 vs the
  Postgres connection cap.
- **Private content at rest:** `*org`/DM bodies are plaintext in `dht.val` (delivery is auth-gated, not encrypted) — a
  conscious 70% choice; revisit if confidentiality-at-rest is needed.
