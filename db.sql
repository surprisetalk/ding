create extension if not exists pgcrypto;

create extension if not exists citext;

create extension if not exists hstore;

create table usr (
  name citext primary key check (name ~ '^[0-9a-zA-Z_]{4,32}$'),
  email citext unique not null check (email ilike '%@%' and email ~ '^.{4,64}$'),
  password text check (password <> ''),
  bio text not null check (length(bio) between 1 and 4096),
  email_verified_at timestamptz,
  verify_sent_at timestamptz,
  invited_by citext not null references usr (name),
  orgs_r text[] not null default '{}',  -- orgs user can read
  orgs_w text[] not null default '{}',  -- orgs user can write
  pubkey text check (pubkey ~ '^[0-9a-f]{64}$'),  -- Ed25519 identity (custodial or self-managed)
  id text check (id ~ '^[0-9a-f]{64}$'),  -- sha256(pubkey); resolves private @recipient ids -> name
  seckey_enc bytea,  -- custodial private key, AES-256-GCM(JWK, KEY_WRAP_SECRET); null = self-custody
  last_seen_at timestamptz not null default current_timestamp,
  created_at timestamptz not null default current_timestamp
);

-- `email citext unique` already indexes email, so no usr_email_idx here. No gin index on
-- orgs_r either: every predicate on it is `x = any(orgs_r)`, which gin array_ops cannot serve.
create index usr_id_idx on usr (id);
create index usr_pubkey_idx on usr (pubkey);

create table org (
  name citext primary key check (name ~ '^[0-9a-zA-Z_]{4,32}$'),
  created_by citext references usr (name) not null,
  stripe_sub_id text unique,
  created_at timestamptz not null default current_timestamp
);

-- A pref is a label plus a vote: the same #tag / @usr / ~www vocabulary the feed already
-- speaks (dht.ts PFX), scoped to one user. ▲ is public (follower counts, mutuals); ▼ is
-- private to the voter and must never be selected on another user's behalf.
-- *org is deliberately absent: org access is already orgs_r/orgs_w membership.
-- Read per-viewer at render time; refresh_score and the stat_* views stay global.
create table pref (
  uid  citext not null references usr (name) on delete cascade,
  kind text not null check (kind in ('tag','usr','www')),
  val  citext not null,  -- citext so @JohnDoe = @johndoe and com.created_by compares cleanly
  vote smallint not null check (vote in (-1, 1)),
  created_at timestamptz not null default current_timestamp,
  -- one vote per label per user: the PK is the toggle's uniqueness, so no read-then-write
  -- race can stack two rows (the reaction path has no such constraint and can).
  primary key (uid, kind, val)
);

-- Reverse lookup: who follows @x / #y. The vote column is in the index so the public
-- ▲-only counts never touch a heap row.
create index pref_target_idx on pref (kind, val, vote);

create table com (
  cid serial primary key,
  parent_cid int references com (cid),
  created_by citext references usr (name),  -- null for foreign authors (no local usr); see author_id
  hash text unique,  -- dht content hash for signed msgs (null for legacy unsigned rows)
  author_id text,    -- sha256(pubkey) of the signing identity
  sig text,          -- Ed25519 signature
  parent_hash text,  -- parent msg content hash (content-addressed threading)
  t bigint,          -- signed unix-seconds timestamp
  tags text[] not null default '{}',  -- public tags (e.g., 'linking')
  orgs text[] not null default '{}',  -- org/private tags (e.g., 'secret')
  usrs text[] not null default '{}',  -- direct-message targeting (restricts visibility)
  mentions text[] not null default '{}',  -- @-mentions extracted from body (public, no visibility effect)
  body text not null check (length(body) between 0 and 4096),
  links int[] not null default '{}',
  thumb text,  -- thumbnail URL (og:image or favicon fallback)
  created_at timestamptz default current_timestamp,
  -- Denormalized counts for hot ranking (maintained by server)
  c_comments int not null default 0,    -- count of non-reaction replies
  c_reactions hstore not null default ''::hstore,  -- reaction counts (e.g., '▲=>5,👍=>3')
  c_flags int not null default 0,       -- count of 'flag' replies
  flaggers citext[] not null default '{}',
  domains text[] not null default '{}',  -- synthetic ~host tags, one per distinct URL host in body
  score timestamptz not null default current_timestamp,  -- ranking key, maintained by refresh_score
  -- Root posts need a public tag or DM recipient
  constraint com_tags_pub_check check ((parent_cid is null and (tags <> '{}' or usrs <> '{}')) or parent_cid is not null)
);

create index com_body_idx on com using gin (to_tsvector('english', body));
create index com_tags_idx on com using gin (tags);
create index com_orgs_idx on com using gin (orgs);
create index com_usrs_idx on com using gin (usrs);
create index com_mentions_idx on com using gin (mentions);
create index com_links_idx on com using gin (links);
-- (parent_cid, created_at desc) also serves plain parent_cid lookups, so no separate index.
create index com_parent_created_idx on com (parent_cid, created_at desc);
create index com_by_created_idx on com (created_by, created_at desc);
create index com_created_at_idx on com (created_at desc);
create index com_score_idx on com (score desc);
-- The default feed: public root posts by score. A bare score index makes the planner walk
-- every comment row, and comments outgrow posts.
create index com_feed_idx on com (score desc) where parent_cid is null and orgs = '{}' and usrs = '{}';
-- Same idea for a LOGGED-IN viewer, whose usrs predicate is a disjunct and so can never
-- satisfy com_feed_idx's. Without this they fall back to com_score_idx and the scan walks
-- every comment row to find roots.
create index com_root_score_idx on com (score desc) where parent_cid is null;
create index com_domains_idx on com using gin (domains);
create index com_parent_hash_idx on com (parent_hash);

-- The DHT: signed, content-addressed, append-only log. Source of truth; com/usr/org
-- are a projection rebuilt from it. seen_at (LOCAL arrival) is the replication cursor,
-- never the attacker-controlled signed ts.
-- NOTE: this table is duplicated verbatim in migrate.sql (the applied prod migration) —
-- schema changes must touch both.
create table dht (
  k        text primary key,                       -- content hash = sha256(canonical signed bytes)
  seq      bigserial,                               -- strictly-increasing LOCAL arrival order = the replication cursor
  kind     text not null check (kind in ('peer','usr','org','msg','flag','mark')),
  pubkey   text not null check (pubkey ~ '^[0-9a-f]{64}$'),
  id       text,                                    -- sha256(pubkey) for register kinds (usr/org/peer); the org's id
  ts       bigint not null,                         -- signed unix seconds (register-version order only)
  sig      text not null check (sig ~ '^[0-9a-f]{128}$'),
  val      jsonb not null,                          -- canonical payload (kind/pubkey/ts live outside)
  tags     text[] not null default '{}',            -- denormalized from val for q= filters
  orgs     text[] not null default '{}',            -- msg delivery scope: *org ids
  usrs     text[] not null default '{}',            -- msg delivery scope: @recipient ids
  members  text[] not null default '{}',            -- org register: the member ids (for *org delivery gating)
  target   text,                                    -- flag/mark subject (id or content hash)
  flagged  boolean not null default false,          -- set when >=3 distinct flagger pubkeys target k
  seen_at  timestamptz not null default current_timestamp
);
create unique index dht_seq_idx on dht (seq);
create index dht_seen_idx on dht (seen_at);
create index dht_id_idx on dht (id);
create index dht_kind_ts_idx on dht (kind, pubkey, ts desc);
create index dht_tags_idx on dht using gin (tags);
create index dht_target_idx on dht (target);

-- single-use drain-auth challenge nonces (so a captured Authorization header can't be replayed)
create table used_nonce (
  nonce text primary key,
  exp   bigint not null
);
create index used_nonce_exp_idx on used_nonce (exp);

create view stat_usr as
with posts as (
  select created_by as uid, count(*)::int as n
  from com where parent_cid is null and char_length(body) > 1
  group by created_by
),
rx as (
  select p.created_by as uid,
    count(*) filter (where r.body = '▲')::int as ups,
    count(*) filter (where r.body = '▼')::int as downs
  from com p join com r on r.parent_cid = p.cid and char_length(r.body) = 1
  group by p.created_by
)
select u.name as uid,
  coalesce(p.n, 0) as posts_count,
  coalesce(r.ups, 0) as ups_received,
  coalesce(r.downs, 0) as downs_received
from usr u
left join posts p on p.uid = u.name
left join rx r on r.uid = u.name;

-- MATERIALIZED, unlike its stat_usr/stat_domain siblings: as a plain view this aggregates
-- every public root post and every reaction on EVERY read, and it is read once per
-- logged-in frontpage load (the `disco` chip sample) plus once per refresh_score call.
-- The numbers are slow-moving reputation, so a periodic snapshot is the right shape.
-- Refreshed by refreshStats() on a Deno.cron; the unique index below is what lets that
-- refresh run CONCURRENTLY and not lock readers out.
create materialized view stat_tag as
select t.tag,
  count(distinct t.cid)::int as posts_count,
  count(*) filter (where r.body = '▲')::int as ups_received,
  count(*) filter (where r.body = '▼')::int as downs_received
from (select unnest(tags) tag, cid from com
       where tags <> '{}' and parent_cid is null and orgs = '{}' and usrs = '{}') t
left join com r on r.parent_cid = t.cid and char_length(r.body) = 1
group by t.tag;

create unique index stat_tag_tag_idx on stat_tag (tag);

-- MATERIALIZED for the same reason as stat_tag: as a plain view this re-aggregated every
-- post carrying a domain and every reaction on EVERY read (~330ms measured on prod), and
-- refresh_score reads it on every single post and reaction. Nothing else reads it at all,
-- so the only staleness this buys is in a slow-moving ranking term.
-- Refreshed by refreshStats(); the unique index is what lets that run CONCURRENTLY.
create materialized view stat_domain as
select d.domain,
  count(*) filter (where r.body = '▲')::int as ups_received,
  count(*) filter (where r.body = '▼')::int as downs_received
from (select unnest(domains) as domain, cid from com where domains <> '{}') d
join com r on r.parent_cid = d.cid and char_length(r.body) = 1
group by d.domain;

create unique index stat_domain_domain_idx on stat_domain (domain);

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
