create extension if not exists pgcrypto;

create extension if not exists citext;

create extension if not exists hstore;

create table usr (
  name citext primary key check (name ~ '^[0-9a-zA-Z_]{4,32}$'),
  email citext unique not null check (email ilike '%@%' and email ~ '^.{4,64}$'),
  password text check (password <> ''),
  bio text not null check (length(bio) between 1 and 1441),
  email_verified_at timestamptz,
  invited_by citext not null references usr (name),
  orgs_r text[] not null default '{}',  -- orgs user can read
  orgs_w text[] not null default '{}',  -- orgs user can write
  orgs_x text[] not null default '{}',  -- orgs user can moderate (future)
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
  usrs text[] not null default '{}',  -- user mentions (e.g., 'john')
  body text not null check (length(body) between 0 and 1441),
  links int[] not null default '{}',
  thumb text,  -- thumbnail URL (og:image or favicon fallback)
  created_at timestamptz default current_timestamp,
  -- Denormalized counts for hot ranking (maintained by server)
  c_comments int not null default 0,    -- count of non-reaction replies
  c_reactions hstore not null default ''::hstore,  -- reaction counts (e.g., '▲=>5,👍=>3')
  c_flags int not null default 0,       -- count of 'flag' replies
  flaggers citext[] not null default '{}',
  -- Denormalized recommendation signals (maintained by refresh_score)
  domain text,
  author_ups int not null default 0,
  author_downs int not null default 0,
  author_posts_count int not null default 0,
  tag_ups int not null default 0,
  tag_downs int not null default 0,
  domain_ups int not null default 0,
  domain_downs int not null default 0,
  repost_ups int not null default 0,
  score timestamptz not null default current_timestamp,
  -- Root posts require at least one public tag
  check ((parent_cid is null and tags <> '{}') or parent_cid is not null)
);

create index com_body_idx on com using gin (to_tsvector('english', body));
create index com_tags_idx on com using gin (tags);
create index com_orgs_idx on com using gin (orgs);
create index com_usrs_idx on com using gin (usrs);
create index com_links_idx on com using gin (links);
create index com_parent_cid_idx on com (parent_cid);
create index com_created_by_idx on com (created_by);
create index com_score_idx on com (score desc);
create index com_domain_idx on com (domain) where domain is not null;

create view stat_usr as
select u.name as uid,
  (select count(*)::int from com where created_by = u.name and parent_cid is null and char_length(body) > 1) as posts_count,
  (select count(*)::int from com r join com p on p.cid = r.parent_cid where p.created_by = u.name and r.body = '▲') as ups_received,
  (select count(*)::int from com r join com p on p.cid = r.parent_cid where p.created_by = u.name and r.body = '▼') as downs_received
from usr u;

create view stat_tag as
select t.tag,
  count(*) filter (where r.body = '▲')::int as ups_received,
  count(*) filter (where r.body = '▼')::int as downs_received
from (select unnest(tags) tag, cid from com where tags <> '{}' and parent_cid is null) t
join com r on r.parent_cid = t.cid and char_length(r.body) = 1
group by t.tag;

create view stat_domain as
select p.domain,
  count(*) filter (where r.body = '▲')::int as ups_received,
  count(*) filter (where r.body = '▼')::int as downs_received
from com p
join com r on r.parent_cid = p.cid and char_length(r.body) = 1
where p.domain is not null
group by p.domain;

create or replace function refresh_score(cids int[]) returns void language sql as $$
  update com c set
    author_ups = coalesce(su.ups_received, 0),
    author_downs = coalesce(su.downs_received, 0),
    author_posts_count = coalesce(su.posts_count, 0),
    tag_ups = coalesce((select max(ups_received) from stat_tag where tag = any(c.tags)), 0),
    tag_downs = coalesce((select max(downs_received) from stat_tag where tag = any(c.tags)), 0),
    domain_ups = coalesce((select ups_received from stat_domain where domain = c.domain), 0),
    domain_downs = coalesce((select downs_received from stat_domain where domain = c.domain), 0),
    repost_ups = coalesce((select sum(coalesce((c2.c_reactions->'▲')::int, 0))::int from com c2 where c2.cid = any(c.links)), 0),
    score = c.created_at
      + interval '2 hours'   * ln(coalesce((c.c_reactions->'▲')::int, 0) + 1)
      - interval '6 hours'   * ln(coalesce((c.c_reactions->'▼')::int, 0) + 1)
      + interval '1 hour'    * ln(coalesce(su.ups_received, 0) + 1)
      - interval '3 hours'   * ln(coalesce(su.downs_received, 0) + 1)
      + interval '1 hour'    * ln(coalesce((select max(ups_received) from stat_tag where tag = any(c.tags)), 0) + 1)
      - interval '3 hours'   * ln(coalesce((select max(downs_received) from stat_tag where tag = any(c.tags)), 0) + 1)
      + interval '1 hour'    * ln(coalesce((select ups_received from stat_domain where domain = c.domain), 0) + 1)
      - interval '3 hours'   * ln(coalesce((select downs_received from stat_domain where domain = c.domain), 0) + 1)
      - interval '30 minutes'* ln(coalesce(su.posts_count, 0) + 1)
      - interval '2 hours'   * ln(coalesce((select sum(coalesce((c2.c_reactions->'▲')::int, 0))::int from com c2 where c2.cid = any(c.links)), 0) + 1)
  from stat_usr su
  where c.cid = any(cids) and c.created_by = su.uid;
$$;


insert into
usr (name, email, password, bio, email_verified_at, invited_by, orgs_r, orgs_w)
values
('BugHunter42', 'bughunter42@example.com', crypt('bugzapper123!', gen_salt('bf', 8)), 'I squash bugs for fun and profit.', null, 'BugHunter42', '{secret,internal}', '{secret}'),
('NullPointerQueen', 'nullpointerqueen@example.com', crypt('segfaults4ever!', gen_salt('bf', 8)), 'Segfaults are my specialty.', null, 'NullPointerQueen', '{secret}', '{secret}'),
('CodeWarrior007', 'codewarrior007@example.com', crypt('goldeneye$', gen_salt('bf', 8)), 'Writing code faster than a speeding bullet.', null, 'CodeWarrior007', '{internal}', '{internal}'),
('StackOverflowLord', 'solord@example.com', crypt('downvote_this!', gen_salt('bf', 8)), 'Living on the edge of recursion.', null, 'StackOverflowLord', '{}', '{}'),
('DebuggerDiva', 'debuggerdiva@example.com', crypt('breakpoint@!', gen_salt('bf', 8)), 'I can debug anything, even your life choices.', null, 'DebuggerDiva', '{secret,internal}', '{secret,internal}'),
('SyntaxSamurai', 'syntaxsamurai@example.com', crypt('semicolon&samurai', gen_salt('bf', 8)), 'Syntax errors fear me.', null, 'SyntaxSamurai', '{}', '{}');

insert into
com (cid, parent_cid, created_by, body, tags, orgs, usrs)
values
(301, null, 'BugHunter42', 'Why do bugs always show up on Fridays?', '{humor,bugs}', '{}', '{}'),
(302, null, 'NullPointerQueen', 'Just had a null pointer exception. Classic!', '{humor,exceptions}', '{}', '{}'),
(303, 0301, 'NullPointerQueen', 'Bugs love weekends too!', '{humor,bugs}', '{}', '{}'),
(304, null, 'CodeWarrior007', 'Anyone else feel like a coding ninja today?', '{motivation,coding}', '{}', '{}'),
(305, null, 'StackOverflowLord', 'Just downvoted my own answer for fun.', '{humor,meta}', '{}', '{}'),
(306, 0304, 'DebuggerDiva', 'Only when I finally solve that pesky bug.', '{motivation,coding}', '{}', '{}'),
(307, null, 'SyntaxSamurai', 'Semicolon misplaced. It''s a tragedy.', '{humor,syntax}', '{}', '{}'),
(308, 0307, 'CodeWarrior007', 'I feel your pain, syntax samurai.', '{humor,syntax}', '{}', '{}'),
(309, null, 'DebuggerDiva', 'Breakpoints are like checkpoints in life.', '{motivation,debugging}', '{}', '{}'),
(310, 0309, 'BugHunter42', 'And stepping through code is like meditation.', '{motivation,debugging}', '{}', '{}'),
(311, null, 'BugHunter42', 'Just found a bug that only occurs on leap years. FML.', '{humor,bugs}', '{}', '{}'),
(312, 0311, 'NullPointerQueen', 'Those are the best kind. Totally worth the wait.', '{humor,bugs}', '{}', '{}'),
(313, null, 'NullPointerQueen', 'Segfaults are like surprise parties, but with more panic.', '{humor,exceptions}', '{}', '{}'),
(314, null, 'CodeWarrior007', 'Just optimized a function from O(n^2) to O(n log n). I feel like a superhero.', '{motivation,coding}', '{}', '{}'),
(315, 0314, 'SyntaxSamurai', 'Teach me your ways, CodeWarrior007!', '{motivation,coding}', '{}', '{}'),
(316, null, 'StackOverflowLord', 'Just saw someone use a global variable... in 2024. Cringe.', '{humor,coding}', '{}', '{}'),
(317, 0316, 'DebuggerDiva', 'Yikes. That''s a crime against programming.', '{humor,coding}', '{}', '{}'),
(318, null, 'DebuggerDiva', 'Spent 3 hours debugging only to find out I misspelled a variable. Classic.', '{humor,debugging}', '{}', '{}'),
(319, 0318, 'CodeWarrior007', 'Been there, done that. Welcome to the club.', '{humor,debugging}', '{}', '{}'),
(320, null, 'SyntaxSamurai', 'Autocomplete is both a blessing and a curse.', '{humor,coding}', '{}', '{}'),
(321, 0320, 'BugHunter42', 'True, but more blessing when it actually works.', '{humor,coding}', '{}', '{}'),
(322, null, 'BugHunter42', 'Why does every tutorial say "it''s simple" and then proceed to confuse you for hours?', '{humor,learning}', '{}', '{}'),
(323, 0322, 'StackOverflowLord', 'Because they are written by people who forgot how hard it is to learn from scratch.', '{humor,learning}', '{}', '{}'),
(324, null, 'NullPointerQueen', 'My code works. I have no idea why. But it works.', '{humor,coding}', '{}', '{}'),
(325, 0324, 'CodeWarrior007', 'If it ain''t broke, don''t fix it.', '{humor,coding}', '{}', '{}'),
(326, null, 'StackOverflowLord', 'Just spent 2 hours fixing a bug that turned out to be a typo.', '{humor,debugging}', '{}', '{}'),
(327, 0326, 'NullPointerQueen', 'Typos: the silent killers.', '{humor,debugging}', '{}', '{}'),
(328, null, 'DebuggerDiva', 'Breakpoints are my best friends.', '{humor,debugging}', '{}', '{}'),
(329, 0328, 'BugHunter42', 'Especially when you''re deep into spaghetti code.', '{humor,debugging}', '{}', '{}'),
(330, null, 'SyntaxSamurai', 'Why do code reviews feel like therapy sessions?', '{humor,coding}', '{}', '{}'),
(331, 0330, 'DebuggerDiva', 'Because they are! Code is personal.', '{humor,coding}', '{}', '{}'),
(332, null, 'CodeWarrior007', 'Just finished a project without any merge conflicts. Feels like winning the lottery.', '{motivation,coding}', '{}', '{}'),
(333, 0332, 'StackOverflowLord', 'You should definitely buy a lottery ticket today.', '{motivation,coding}', '{}', '{}'),
(334, 0311, 'CodeWarrior007', 'Leap year bugs are like finding Easter eggs... painful ones.', '{humor,bugs}', '{}', '{}'),
(335, 0313, 'StackOverflowLord', 'More panic and less cake, unfortunately.', '{humor,exceptions}', '{}', '{}'),
(336, 0313, 'BugHunter42', 'Segfaults: the ultimate surprise gift from your code.', '{humor,exceptions}', '{}', '{}'),
(337, 0314, 'NullPointerQueen', 'That''s some next-level optimization. Hats off!', '{motivation,coding}', '{}', '{}'),
(338, 0314, 'StackOverflowLord', 'O(n log n)? You must have used some dark magic.', '{motivation,coding}', '{}', '{}'),
(339, 0316, 'BugHunter42', 'Global variables are so last century.', '{humor,coding}', '{}', '{}'),
(340, 0318, 'SyntaxSamurai', 'Nothing like a good variable name typo to humble you.', '{humor,debugging}', '{}', '{}'),
(341, 0318, 'StackOverflowLord', 'Variable typos: the bane of every coder''s existence.', '{humor,debugging}', '{}', '{}'),
(342, 0320, 'NullPointerQueen', 'Autocomplete is the friend who tries too hard.', '{humor,coding}', '{}', '{}'),
(343, 0320, 'DebuggerDiva', 'And sometimes, it''s that annoying friend who finishes your sentences wrong.', '{humor,coding}', '{}', '{}'),
(344, 0322, 'CodeWarrior007', 'It''s their way of saying "Welcome to the real world."', '{humor,learning}', '{}', '{}'),
(345, 0322, 'SyntaxSamurai', 'Because simplicity is a complex concept.', '{humor,learning}', '{}', '{}'),
(346, 0324, 'BugHunter42', 'The mystery of working code: embrace it.', '{humor,coding}', '{}', '{}'),
(347, 0324, 'StackOverflowLord', 'Sometimes code just wants to be mysterious.', '{humor,coding}', '{}', '{}'),
(348, 0326, 'DebuggerDiva', 'Typo bugs: 1, Human: 0.', '{humor,debugging}', '{}', '{}'),
(349, 0328, 'NullPointerQueen', 'Breakpoints are the unsung heroes of debugging.', '{humor,debugging}', '{}', '{}'),
(350, 0328, 'CodeWarrior007', 'Breakpoints and coffee: the ultimate combo.', '{humor,debugging}', '{}', '{}'),
(351, 0330, 'BugHunter42', 'Because they reveal your deepest coding secrets.', '{humor,coding}', '{}', '{}'),
(352, 0330, 'StackOverflowLord', 'It''s a safe space to discuss your code crimes.', '{humor,coding}', '{}', '{}'),
(353, 0332, 'NullPointerQueen', 'Merge conflicts are the worst. Congrats on avoiding them!', '{motivation,coding}', '{}', '{}'),
(354, 0332, 'DebuggerDiva', 'That''s a rare achievement! Celebrate it.', '{motivation,coding}', '{}', '{}'),
-- Private posts for testing access control
(355, null, 'BugHunter42', 'This is a secret post only visible to users with secret tag.', '{humor}', '{secret}', '{}'),
(356, null, 'DebuggerDiva', 'Internal team discussion about upcoming features.', '{coding}', '{internal}', '{}'),
(357, null, 'BugHunter42', 'Direct message to BugHunter42 and DebuggerDiva.', '{general}', '{}', '{BugHunter42,DebuggerDiva}');

-- Test seed data
insert into usr (name, email, password, bio, email_verified_at, invited_by, orgs_r, orgs_w)
values ('john_doe', 'john@example.com', 'hashed:password1!', 'sample bio', now(), 'john_doe', '{secret}', '{secret}')
on conflict do nothing;

insert into usr (name, email, password, bio, email_verified_at, invited_by, orgs_r, orgs_w)
values ('jane_doe', 'jane@example.com', 'hashed:password1!', 'sample bio', now(), 'john_doe', '{}', '{}')
on conflict do nothing;

-- Sync sequences for tables with hardcoded IDs in seeds
select setval('com_cid_seq', (select max(cid) from com));

-- Backfill score + denormalized stats
select refresh_score(array(select cid from com));