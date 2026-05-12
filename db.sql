create extension if not exists pgcrypto;

create extension if not exists citext;

create extension if not exists hstore;

create table usr (
  name citext primary key check (name ~ '^[0-9a-zA-Z_]{4,32}$'),
  email citext unique not null check (email ilike '%@%' and email ~ '^.{4,64}$'),
  password text check (password <> ''),
  bio text not null check (length(bio) between 1 and 4096),
  email_verified_at timestamptz,
  invited_by citext not null references usr (name),
  orgs_r text[] not null default '{}',  -- orgs user can read
  orgs_w text[] not null default '{}',  -- orgs user can write
  last_seen_at timestamptz not null default current_timestamp,
  created_at timestamptz not null default current_timestamp
);

create index usr_email_idx on usr (email);
create index usr_orgs_r_idx on usr using gin (orgs_r);

create table org (
  name citext primary key check (name ~ '^[0-9a-zA-Z_]{4,32}$'),
  created_by citext references usr (name) not null,
  stripe_sub_id text unique,
  created_at timestamptz not null default current_timestamp
);

create table com (
  cid serial primary key,
  parent_cid int references com (cid),
  created_by citext references usr (name) not null,
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
  -- Denormalized recommendation signals (maintained by refresh_score)
  domains text[] not null default '{}',  -- synthetic ~host tags, one per distinct URL host in body
  author_ups int not null default 0,
  author_downs int not null default 0,
  author_posts_count int not null default 0,
  tag_ups int not null default 0,
  tag_downs int not null default 0,
  domain_ups int not null default 0,
  domain_downs int not null default 0,
  repost_ups int not null default 0,
  score timestamptz not null default current_timestamp,
  -- Root posts need a public tag or DM recipient
  constraint com_tags_pub_check check ((parent_cid is null and (tags <> '{}' or usrs <> '{}')) or parent_cid is not null)
);

create index com_body_idx on com using gin (to_tsvector('english', body));
create index com_tags_idx on com using gin (tags);
create index com_orgs_idx on com using gin (orgs);
create index com_usrs_idx on com using gin (usrs);
create index com_mentions_idx on com using gin (mentions);
create index com_links_idx on com using gin (links);
create index com_parent_cid_idx on com (parent_cid);
create index com_created_by_idx on com (created_by);
create index com_score_idx on com (score desc);
create index com_domains_idx on com using gin (domains);

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

create view stat_tag as
select t.tag,
  count(distinct t.cid)::int as posts_count,
  count(*) filter (where r.body = '▲')::int as ups_received,
  count(*) filter (where r.body = '▼')::int as downs_received
from (select unnest(tags) tag, cid from com where tags <> '{}' and parent_cid is null) t
left join com r on r.parent_cid = t.cid and char_length(r.body) = 1
group by t.tag;

create view stat_domain as
select d.domain,
  count(*) filter (where r.body = '▲')::int as ups_received,
  count(*) filter (where r.body = '▼')::int as downs_received
from (select unnest(domains) as domain, cid from com where domains <> '{}') d
join com r on r.parent_cid = d.cid and char_length(r.body) = 1
group by d.domain;

create or replace function refresh_score(cids int[]) returns void language sql as $$
  with
  targets as (select cid, tags, domains, links, created_by, created_at from com where cid = any(cids)),
  tag_agg as (
    select t.cid,
      coalesce(max(st.ups_received), 0)::int as tag_ups,
      coalesce(max(st.downs_received), 0)::int as tag_downs,
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
    author_ups = ua.ups_received,
    author_downs = ua.downs_received,
    author_posts_count = ua.posts_count,
    tag_ups = ta.tag_ups,
    tag_downs = ta.tag_downs,
    domain_ups = da.domain_ups,
    domain_downs = da.domain_downs,
    repost_ups = ra.repost_ups,
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
