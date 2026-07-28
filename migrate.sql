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
create index if not exists dht_members_idx on dht using gin (members);
create index if not exists dht_kind_ts_idx on dht (kind, pubkey, ts desc);
create index if not exists dht_tags_idx on dht using gin (tags);
create index if not exists dht_target_idx on dht (target);

-- used_nonce: single-use drain-auth challenge nonces (replay protection).
create table if not exists used_nonce (
  nonce text primary key,
  exp   bigint not null
);
create index if not exists used_nonce_exp_idx on used_nonce (exp);

-- stat_tag: restrict the tag rollup to PUBLIC root posts. Previously it aggregated
-- *org and @user rows too, so a tag used only inside a private post could surface as a
-- public frontpage chip. Column list is unchanged, so this replace is idempotent.
-- Side effect: refresh_score's tag_ups/tag_downs signal no longer counts private posts.
create or replace view stat_tag as
select t.tag,
  count(distinct t.cid)::int as posts_count,
  count(*) filter (where r.body = '▲')::int as ups_received,
  count(*) filter (where r.body = '▼')::int as downs_received
from (select unnest(tags) tag, cid from com
       where tags <> '{}' and parent_cid is null and orgs = '{}' and usrs = '{}') t
left join com r on r.parent_cid = t.cid and char_length(r.body) = 1
group by t.tag;
