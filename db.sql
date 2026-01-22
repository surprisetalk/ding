create extension if not exists pgcrypto;

create extension if not exists citext;

create function email_token(ts timestamptz, email text) returns text
language sql
immutable
returns null on null input
return ''
|| extract(epoch from ts)::bigint
|| ':'
|| md5(extract(epoch from ts)::bigint || ':TODO:' || email);

create table usr (
  uid serial primary key,
  name citext unique not null check (name ~ '^[0-9a-zA-Z_]{4,32}$'),
  email citext unique not null check (email ilike '%@%' and email ~ '^.{4,64}$'),
  password text check (password <> ''),
  bio text not null check (length(bio) between 1 and 1441),
  email_verified_at timestamp,
  invited_by int not null references usr (uid),
  tags_prv_r text[] not null default '{}',  -- private tags user can read
  tags_prv_w text[] not null default '{}',  -- private tags user can write
  tags_prv_x text[] not null default '{}',  -- private tags user can moderate (future)
  created_at timestamptz not null default current_timestamp
);

create index usr_email_idx on usr (email);
create index usr_tags_prv_r_idx on usr using gin (tags_prv_r);

create table com (
  cid serial primary key,
  parent_cid int references com (cid),
  uid int references usr (uid) not null,
  tags_pub text[] not null default '{}',  -- public (e.g., 'linking')
  tags_prv text[] not null default '{}',  -- private (e.g., 'secret')
  tags_usr text[] not null default '{}',  -- usernames (e.g., 'john')
  body text not null check (length(body) between 0 and 1441),
  created_at timestamp default current_timestamp,
  -- Root posts require at least one public tag
  check ((parent_cid is null and tags_pub <> '{}') or parent_cid is not null)
);

create index com_body_idx on com using gin (to_tsvector('english', body));
create index com_tags_pub_idx on com using gin (tags_pub);
create index com_tags_prv_idx on com using gin (tags_prv);
create index com_tags_usr_idx on com using gin (tags_usr);
create index com_parent_cid_idx on com (parent_cid);
create index com_uid_idx on com (uid);

insert into
usr (uid, name, email, password, bio, email_verified_at, invited_by, tags_prv_r, tags_prv_w)
values
(201, 'BugHunter42', 'bughunter42@example.com', crypt('bugzapper123!', gen_salt('bf', 8)), 'I squash bugs for fun and profit.', null, 201, '{secret,internal}', '{secret}'),
(202, 'NullPointerQueen', 'nullpointerqueen@example.com', crypt('segfaults4ever!', gen_salt('bf', 8)), 'Segfaults are my specialty.', null, 202, '{secret}', '{secret}'),
(203, 'CodeWarrior007', 'codewarrior007@example.com', crypt('goldeneye$', gen_salt('bf', 8)), 'Writing code faster than a speeding bullet.', null, 203, '{internal}', '{internal}'),
(204, 'StackOverflowLord', 'solord@example.com', crypt('downvote_this!', gen_salt('bf', 8)), 'Living on the edge of recursion.', null, 204, '{}', '{}'),
(205, 'DebuggerDiva', 'debuggerdiva@example.com', crypt('breakpoint@!', gen_salt('bf', 8)), 'I can debug anything, even your life choices.', null, 205, '{secret,internal}', '{secret,internal}'),
(206, 'SyntaxSamurai', 'syntaxsamurai@example.com', crypt('semicolon&samurai', gen_salt('bf', 8)), 'Syntax errors fear me.', null, 206, '{}', '{}');

insert into
com (cid, parent_cid, uid, body, tags_pub, tags_prv, tags_usr)
values
(301, null, 201, 'Why do bugs always show up on Fridays?', '{humor,bugs}', '{}', '{}'),
(302, null, 202, 'Just had a null pointer exception. Classic!', '{humor,exceptions}', '{}', '{}'),
(303, 0301, 202, 'Bugs love weekends too!', '{humor,bugs}', '{}', '{}'),
(304, null, 203, 'Anyone else feel like a coding ninja today?', '{motivation,coding}', '{}', '{}'),
(305, null, 204, 'Just downvoted my own answer for fun.', '{humor,meta}', '{}', '{}'),
(306, 0304, 205, 'Only when I finally solve that pesky bug.', '{motivation,coding}', '{}', '{}'),
(307, null, 206, 'Semicolon misplaced. It''s a tragedy.', '{humor,syntax}', '{}', '{}'),
(308, 0307, 203, 'I feel your pain, syntax samurai.', '{humor,syntax}', '{}', '{}'),
(309, null, 205, 'Breakpoints are like checkpoints in life.', '{motivation,debugging}', '{}', '{}'),
(310, 0309, 201, 'And stepping through code is like meditation.', '{motivation,debugging}', '{}', '{}'),
(311, null, 201, 'Just found a bug that only occurs on leap years. FML.', '{humor,bugs}', '{}', '{}'),
(312, 0311, 202, 'Those are the best kind. Totally worth the wait.', '{humor,bugs}', '{}', '{}'),
(313, null, 202, 'Segfaults are like surprise parties, but with more panic.', '{humor,exceptions}', '{}', '{}'),
(314, null, 203, 'Just optimized a function from O(n^2) to O(n log n). I feel like a superhero.', '{motivation,coding}', '{}', '{}'),
(315, 0314, 206, 'Teach me your ways, CodeWarrior007!', '{motivation,coding}', '{}', '{}'),
(316, null, 204, 'Just saw someone use a global variable... in 2024. Cringe.', '{humor,coding}', '{}', '{}'),
(317, 0316, 205, 'Yikes. That''s a crime against programming.', '{humor,coding}', '{}', '{}'),
(318, null, 205, 'Spent 3 hours debugging only to find out I misspelled a variable. Classic.', '{humor,debugging}', '{}', '{}'),
(319, 0318, 203, 'Been there, done that. Welcome to the club.', '{humor,debugging}', '{}', '{}'),
(320, null, 206, 'Autocomplete is both a blessing and a curse.', '{humor,coding}', '{}', '{}'),
(321, 0320, 201, 'True, but more blessing when it actually works.', '{humor,coding}', '{}', '{}'),
(322, null, 201, 'Why does every tutorial say "it''s simple" and then proceed to confuse you for hours?', '{humor,learning}', '{}', '{}'),
(323, 0322, 204, 'Because they are written by people who forgot how hard it is to learn from scratch.', '{humor,learning}', '{}', '{}'),
(324, null, 202, 'My code works. I have no idea why. But it works.', '{humor,coding}', '{}', '{}'),
(325, 0324, 203, 'If it ain''t broke, don''t fix it.', '{humor,coding}', '{}', '{}'),
(326, null, 204, 'Just spent 2 hours fixing a bug that turned out to be a typo.', '{humor,debugging}', '{}', '{}'),
(327, 0326, 202, 'Typos: the silent killers.', '{humor,debugging}', '{}', '{}'),
(328, null, 205, 'Breakpoints are my best friends.', '{humor,debugging}', '{}', '{}'),
(329, 0328, 201, 'Especially when you''re deep into spaghetti code.', '{humor,debugging}', '{}', '{}'),
(330, null, 206, 'Why do code reviews feel like therapy sessions?', '{humor,coding}', '{}', '{}'),
(331, 0330, 205, 'Because they are! Code is personal.', '{humor,coding}', '{}', '{}'),
(332, null, 203, 'Just finished a project without any merge conflicts. Feels like winning the lottery.', '{motivation,coding}', '{}', '{}'),
(333, 0332, 204, 'You should definitely buy a lottery ticket today.', '{motivation,coding}', '{}', '{}'),
(334, 0311, 203, 'Leap year bugs are like finding Easter eggs... painful ones.', '{humor,bugs}', '{}', '{}'),
(335, 0313, 204, 'More panic and less cake, unfortunately.', '{humor,exceptions}', '{}', '{}'),
(336, 0313, 201, 'Segfaults: the ultimate surprise gift from your code.', '{humor,exceptions}', '{}', '{}'),
(337, 0314, 202, 'That''s some next-level optimization. Hats off!', '{motivation,coding}', '{}', '{}'),
(338, 0314, 204, 'O(n log n)? You must have used some dark magic.', '{motivation,coding}', '{}', '{}'),
(339, 0316, 201, 'Global variables are so last century.', '{humor,coding}', '{}', '{}'),
(340, 0318, 206, 'Nothing like a good variable name typo to humble you.', '{humor,debugging}', '{}', '{}'),
(341, 0318, 204, 'Variable typos: the bane of every coder''s existence.', '{humor,debugging}', '{}', '{}'),
(342, 0320, 202, 'Autocomplete is the friend who tries too hard.', '{humor,coding}', '{}', '{}'),
(343, 0320, 205, 'And sometimes, it''s that annoying friend who finishes your sentences wrong.', '{humor,coding}', '{}', '{}'),
(344, 0322, 203, 'It''s their way of saying "Welcome to the real world."', '{humor,learning}', '{}', '{}'),
(345, 0322, 206, 'Because simplicity is a complex concept.', '{humor,learning}', '{}', '{}'),
(346, 0324, 201, 'The mystery of working code: embrace it.', '{humor,coding}', '{}', '{}'),
(347, 0324, 204, 'Sometimes code just wants to be mysterious.', '{humor,coding}', '{}', '{}'),
(348, 0326, 205, 'Typo bugs: 1, Human: 0.', '{humor,debugging}', '{}', '{}'),
(349, 0328, 202, 'Breakpoints are the unsung heroes of debugging.', '{humor,debugging}', '{}', '{}'),
(350, 0328, 203, 'Breakpoints and coffee: the ultimate combo.', '{humor,debugging}', '{}', '{}'),
(351, 0330, 201, 'Because they reveal your deepest coding secrets.', '{humor,coding}', '{}', '{}'),
(352, 0330, 204, 'It''s a safe space to discuss your code crimes.', '{humor,coding}', '{}', '{}'),
(353, 0332, 202, 'Merge conflicts are the worst. Congrats on avoiding them!', '{motivation,coding}', '{}', '{}'),
(354, 0332, 205, 'That''s a rare achievement! Celebrate it.', '{motivation,coding}', '{}', '{}'),
-- Private posts for testing access control
(355, null, 201, 'This is a secret post only visible to users with secret tag.', '{humor}', '{secret}', '{}'),
(356, null, 205, 'Internal team discussion about upcoming features.', '{coding}', '{internal}', '{}'),
(357, null, 201, 'Direct message to BugHunter42 and DebuggerDiva.', '{general}', '{}', '{BugHunter42,DebuggerDiva}');
