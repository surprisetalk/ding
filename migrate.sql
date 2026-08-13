-- Prod schema migration: centralized ding -> decentralized DHT layer.
-- Idempotent + ADDITIVE (nullable columns, new tables) so OLD code keeps running against
-- it — i.e. you can migrate the schema first and roll the code back without a schema revert.
--
-- Run OUTSIDE a transaction (CREATE INDEX CONCURRENTLY forbids one):
--   psql -d ding -f migrate.sql      # psql autocommits each statement; do NOT add BEGIN/COMMIT
-- Safe to re-run.

-- usr: custodial identity. seckey_enc is AES-256-GCM(JWK) under KEY_WRAP_SECRET (set that env
-- var BEFORE deploying the new server, which refuses to boot without it).
alter table usr add column if not exists pubkey text check (pubkey ~ '^[0-9a-f]{64}$');
alter table usr add column if not exists id text check (id ~ '^[0-9a-f]{64}$');
alter table usr add column if not exists seckey_enc bytea;
create index concurrently if not exists usr_id_idx on usr (id);

-- com: carry the signed identity of decentralized posts. created_by becomes nullable
-- (foreign authors have no local usr). Legacy rows keep these null and render as today.
alter table com add column if not exists hash text;
alter table com add column if not exists author_id text;
alter table com add column if not exists sig text;
alter table com add column if not exists parent_hash text;
alter table com add column if not exists t bigint;
alter table com alter column created_by drop not null;
create unique index concurrently if not exists com_hash_key on com (hash);
create index concurrently if not exists com_parent_hash_idx on com (parent_hash);

-- dht: the signed, content-addressed, append-only log (source of truth; com/usr/org project
-- from it). New + empty, so plain CREATE INDEX is instant (no CONCURRENTLY needed).
create table if not exists dht (
  k        text primary key,
  seq      bigserial,
  kind     text not null check (kind in ('peer','usr','org','msg','flag','mark')),
  pubkey   text not null check (pubkey ~ '^[0-9a-f]{64}$'),
  id       text,
  ts       bigint not null,
  sig      text not null check (sig ~ '^[0-9a-f]{128}$'),
  val      jsonb not null,
  tags     text[] not null default '{}',
  orgs     text[] not null default '{}',
  usrs     text[] not null default '{}',
  members  text[] not null default '{}',
  target   text,
  flagged  boolean not null default false,
  seen_at  timestamptz not null default current_timestamp
);
create unique index if not exists dht_seq_idx on dht (seq);
create index if not exists dht_seen_idx on dht (seen_at);
create index if not exists dht_id_idx on dht (id);
create index if not exists dht_kind_ts_idx on dht (kind, pubkey, ts desc);
create index if not exists dht_tags_idx on dht using gin (tags);
create index if not exists dht_target_idx on dht (target);

-- used_nonce: single-use drain-auth challenge nonces (replay protection).
create table if not exists used_nonce (
  nonce text primary key,
  exp   bigint not null
);
create index if not exists used_nonce_exp_idx on used_nonce (exp);

-- Index gaps found by profiling. com had no created_at index at all, so every ?sort=new
-- (which is what every bot uses) sorted the whole table; usr.pubkey was a seq scan on every
-- ingested dht row. com_parent_created_idx supersedes com_parent_cid_idx, and usr_email_idx
-- always duplicated the `email citext unique` constraint index — both are dropped last, after
-- their replacements exist.
create index concurrently if not exists com_created_at_idx on com (created_at desc);
create index concurrently if not exists com_by_created_idx on com (created_by, created_at desc);
create index concurrently if not exists com_parent_created_idx on com (parent_cid, created_at desc);
create index concurrently if not exists usr_pubkey_idx on usr (pubkey);
create index concurrently if not exists com_feed_idx on com (score desc)
  where parent_cid is null and orgs = '{}' and usrs = '{}';
drop index concurrently if exists com_parent_cid_idx;
drop index concurrently if exists com_created_by_idx;
drop index concurrently if exists usr_email_idx;
-- Unreachable gin indexes: both columns are only ever read with `x = any(col)`, which
-- gin array_ops cannot serve, and dht.members is read off a materialized subquery besides.
drop index concurrently if exists usr_orgs_r_idx;
drop index concurrently if exists dht_members_idx;

-- refresh_score no longer writes the eight denormalized signal columns below (nothing ever
-- read them; the score expression uses the CTEs directly). Replace the function FIRST, then
-- drop the columns, so no write ever references a missing column.
create or replace function refresh_score(cids int[]) returns void language sql as $$
  with
  targets as (select cid, tags, domains, links, created_by, created_at from com where cid = any(cids)),
  tag_agg as (
    select t.cid,
      coalesce(max(st.ups_received::float / ln(st.posts_count + 2)), 0) as tag_ups_idf,
      coalesce(max(st.downs_received::float / ln(st.posts_count + 2)), 0) as tag_downs_idf
    from targets t left join stat_tag st on st.tag = any(t.tags)
    group by t.cid
  ),
  dom_agg as (
    select t.cid,
      coalesce(max(sd.ups_received), 0)::int as domain_ups,
      coalesce(max(sd.downs_received), 0)::int as domain_downs
    from targets t left join stat_domain sd on sd.domain = any(t.domains)
    group by t.cid
  ),
  repost_agg as (
    select t.cid, coalesce(sum(coalesce((c2.c_reactions->'▲')::int, 0))::int, 0) as repost_ups
    from targets t left join com c2 on c2.cid = any(t.links)
    group by t.cid
  ),
  usr_agg as (
    select t.cid,
      coalesce(su.posts_count, 0) as posts_count,
      coalesce(su.ups_received, 0) as ups_received,
      coalesce(su.downs_received, 0) as downs_received
    from targets t left join stat_usr su on su.uid = t.created_by
  ),
  burst_agg as (
    select t.cid, count(c2.cid)::int as burst
    from targets t left join com c2
      on c2.created_by = t.created_by
     and c2.cid <> t.cid
     and c2.parent_cid is null
     and char_length(c2.body) > 0
     and c2.created_at >= t.created_at - interval '1 hour'
     and c2.created_at <= t.created_at + interval '1 hour'
    group by t.cid
  )
  update com c set
    score = c.created_at
      + interval '2 hours'   * ln(coalesce((c.c_reactions->'▲')::int, 0) + 1)
      - interval '6 hours'   * ln(coalesce((c.c_reactions->'▼')::int, 0) + 1)
      + interval '1 hour'    * ln(ua.ups_received::float / ln(ua.posts_count + 2) + 1)
      - interval '3 hours'   * ln(ua.downs_received::float / ln(ua.posts_count + 2) + 1)
      - interval '48 hours'  * (case when c.created_by like 'bot_%' then 1 else 0 end)
      + interval '1 hour'    * ln(ta.tag_ups_idf + 1)
      - interval '3 hours'   * ln(ta.tag_downs_idf + 1)
      + interval '1 hour'    * ln(c.c_comments + 1)
      + interval '1 hour'    * ln(da.domain_ups + 1)
      - interval '3 hours'   * ln(da.domain_downs + 1)
      - interval '30 minutes'* ln(ua.posts_count + 1)
      - interval '4 hours'   * ln(greatest(0, ba.burst - 2) + 1)
      - interval '2 hours'   * ln(ra.repost_ups + 1)
      + interval '45 minutes'* (case when c.thumb is not null and c.thumb not like 'https://www.google.com/s2/favicons%' then 1 else 0 end)
  from tag_agg ta, dom_agg da, repost_agg ra, usr_agg ua, burst_agg ba
  where c.cid = any(cids)
    and ta.cid = c.cid and da.cid = c.cid and ra.cid = c.cid and ua.cid = c.cid and ba.cid = c.cid;
$$;

-- Dropping them removes eight values from every `select c.*` feed row and eight assignments
-- from every write. ⚠ IRREVERSIBLE — the function above must already be replaced.
--
-- ⚠⚠ THIS STEP TOOK THE SITE DOWN ON 2026-08-09. DATABASE_URL points at Neon's `-pooler`
-- endpoint (transaction mode), where a named prepared statement outlives the client that
-- created it and gets handed to the next one. Changing a result type invalidates every such
-- cached plan, and each reuse fails with `cached plan must not change result type` — across
-- ALL isolates, and for freshly-started ones too, until the pooled backends recycle.
-- Deploy `prepare: false` (server.tsx) BEFORE running this. If you are already stuck:
--   select pg_terminate_backend(pid) from pg_stat_activity
--    where datname = current_database() and pid <> pg_backend_pid();
-- Do NOT use `deallocate all` — clients keep referencing the names it removes and it makes
-- the outage worse.
alter table com
  drop column if exists author_ups,
  drop column if exists author_downs,
  drop column if exists author_posts_count,
  drop column if exists tag_ups,
  drop column if exists tag_downs,
  drop column if exists domain_ups,
  drop column if exists domain_downs,
  drop column if exists repost_ups;

-- pref: per-user ▲/▼ on a label (#tag / @usr / ~www). Purely additive — old code never
-- reads it, so this is safe to apply ahead of the deploy and safe to leave in place on a
-- code rollback. NOTE: this table is duplicated verbatim in db.sql — changes touch both.
-- New + empty, so plain CREATE INDEX is instant. CONCURRENTLY would buy nothing here and
-- costs two table scans plus a wait on every open transaction — and if it were interrupted
-- it would leave an INVALID index that `if not exists` then silently skips forever.
create table if not exists pref (
  uid  citext not null references usr (name) on delete cascade,
  kind text not null check (kind in ('tag','usr','www')),
  val  citext not null,
  vote smallint not null check (vote in (-1, 1)),
  created_at timestamptz not null default current_timestamp,
  primary key (uid, kind, val)
);
create index if not exists pref_target_idx on pref (kind, val, vote);

-- The logged-in feed. com_feed_idx's predicate requires `usrs = '{}'`, but a logged-in
-- viewer's predicate is a disjunct (`usrs = '{}' or me = any(usrs) or created_by = me`) and
-- a disjunct can never satisfy a partial index, so those requests fell back to com_score_idx
-- and walked ~26k comment rows to find 300 roots. CONCURRENTLY: com is large and live.
create index concurrently if not exists com_root_score_idx on com (score desc) where parent_cid is null;

-- stat_tag becomes MATERIALIZED. As a plain view it re-aggregated every public root post and
-- every reaction on EVERY read — ~350ms measured on prod — and it is read once per logged-in
-- frontpage load (the disco chip sample) plus once per refresh_score call. Refreshed every
-- 10 min by the ding-refresh-stats Deno.cron; the unique index is what lets that run
-- CONCURRENTLY. Trade: a brand-new tag doesn't reach the discovery chips until the next tick.
--
-- Idempotent AND atomic, deliberately in a transaction (the file's no-BEGIN rule exists only
-- because CREATE INDEX CONCURRENTLY forbids one, and nothing here is concurrent). Without
-- the transaction there is a window where stat_tag does not exist and every logged-in
-- frontpage 500s. `drop view if exists` is not enough on its own: on a re-run stat_tag is a
-- MATVIEW, and `drop view` on a matview errors rather than skipping.
begin;

do $$
begin
  if exists (select 1 from pg_class where relname = 'stat_tag' and relkind = 'v') then
    drop view stat_tag;
  end if;
end $$;

create materialized view if not exists stat_tag as
select t.tag,
  count(distinct t.cid)::int as posts_count,
  count(*) filter (where r.body = '▲')::int as ups_received,
  count(*) filter (where r.body = '▼')::int as downs_received
from (select unnest(tags) tag, cid from com
       where tags <> '{}' and parent_cid is null and orgs = '{}' and usrs = '{}') t
left join com r on r.parent_cid = t.cid and char_length(r.body) = 1
group by t.tag;

-- Required by REFRESH MATERIALIZED VIEW CONCURRENTLY.
create unique index if not exists stat_tag_tag_idx on stat_tag (tag);

commit;

-- stat_domain gets the same treatment, and for a sharper reason: nothing but refresh_score
-- reads it, and refresh_score runs on every post and every reaction — ~330ms of re-aggregation
-- each time. Same idempotent+atomic shape as stat_tag above; see that block for why the
-- transaction and the DO guard are both needed.
begin;

do $$
begin
  if exists (select 1 from pg_class where relname = 'stat_domain' and relkind = 'v') then
    drop view stat_domain;
  end if;
end $$;

create materialized view if not exists stat_domain as
select d.domain,
  count(*) filter (where r.body = '▲')::int as ups_received,
  count(*) filter (where r.body = '▼')::int as downs_received
from (select unnest(domains) as domain, cid from com where domains <> '{}') d
join com r on r.parent_cid = d.cid and char_length(r.body) = 1
group by d.domain;

create unique index if not exists stat_domain_domain_idx on stat_domain (domain);

commit;
