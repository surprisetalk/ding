create extension if not exists pgcrypto;

create extension if not exists citext;

create function email_token (ts timestamptz, email text) returns text
  language sql
  immutable
  returns null on null input
  return ''
    || extract(epoch from ts)::bigint
    || ':'
    || md5( extract(epoch from ts)::bigint || ':TODO:' || email )
    ;

create table
  usr (
    uid serial primary key,
    name citext unique not null check (name ~ '^[0-9a-zA-Z_]{4,32}$'),
    email citext unique not null check (email ilike '%@%' and email ~ '^.{4,64}$'),
    password text check (password <> ''),
    bio text not null check (length(bio) between 1 and 1441),
    email_verified_at timestamp,
    invited_by int not null references usr (uid),
    created_at timestamptz not null default current_timestamp
  );

create index usr_email_idx on usr (email);

create table
  com (
    cid serial primary key,
    parent_cid int references com (cid),
    uid int references usr (uid) not null,
    tags text[] not null default '{}'::text[] check (1 = (tags <> '{}'::text[])::int + (parent_cid is not null)::int and tags::text ~ '^{[a-z,]{0,64}}$'),
    body text not null check (length(body) between 0 and 1441),
    created_at timestamp default current_timestamp
  );

create index com_body_idx on com using gin(to_tsvector('english', body));
create index com_tags_idx on com using gin(tags);
create index com_parent_cid_idx on com (parent_cid);
create index com_uid_idx on com (uid);

insert into
  usr (uid, name, email, password, bio, email_verified_at, invited_by)
values
  ( 201, 'BugHunter42', 'bughunter42@example.com', crypt('bugzapper123!', gen_salt('bf', 8)), 'I squash bugs for fun and profit.', null, 201),
  ( 202, 'NullPointerQueen', 'nullpointerqueen@example.com', crypt('segfaults4ever!', gen_salt('bf', 8)), 'Segfaults are my specialty.', null, 202),
  ( 203, 'CodeWarrior007', 'codewarrior007@example.com', crypt('goldeneye$', gen_salt('bf', 8)), 'Writing code faster than a speeding bullet.', null, 203),
  ( 204, 'StackOverflowLord', 'solord@example.com', crypt('downvote_this!', gen_salt('bf', 8)), 'Living on the edge of recursion.', null, 204),
  ( 205, 'DebuggerDiva', 'debuggerdiva@example.com', crypt('breakpoint@!', gen_salt('bf', 8)), 'I can debug anything, even your life choices.', null, 205),
  ( 206, 'SyntaxSamurai', 'syntaxsamurai@example.com', crypt('semicolon&samurai', gen_salt('bf', 8)), 'Syntax errors fear me.', null, 206);

insert into
  com (cid, parent_cid, uid, body, tags)
values
  (301, null, 201, 'Why do bugs always show up on Fridays?', '{humor, bugs}'),
  (302, null, 202, 'Just had a null pointer exception. Classic!', '{humor, exceptions}'),
  (303,  301, 202, 'Bugs love weekends too!', '{}'),
  (304, null, 203, 'Anyone else feel like a coding ninja today?', '{motivation, coding}'),
  (305, null, 204, 'Just downvoted my own answer for fun.', '{humor, meta}'),
  (306,  304, 205, 'Only when I finally solve that pesky bug.', '{}'),
  (307, null, 206, 'Semicolon misplaced. It’s a tragedy.', '{humor, syntax}'),
  (308,  307, 203, 'I feel your pain, syntax samurai.', '{}'),
  (309, null, 205, 'Breakpoints are like checkpoints in life.', '{motivation, debugging}'),
  (310,  309, 201, 'And stepping through code is like meditation.', '{}'),
  (311, null, 201, 'Just found a bug that only occurs on leap years. FML.', '{humor, bugs}'),
  (312,  311, 202, 'Those are the best kind. Totally worth the wait.', '{}'),
  (313, null, 202, 'Segfaults are like surprise parties, but with more panic.', '{humor, exceptions}'),
  (314, null, 203, 'Just optimized a function from O(n^2) to O(n log n). I feel like a superhero.', '{motivation, coding}'),
  (315,  314, 206, 'Teach me your ways, CodeWarrior007!', '{}'),
  (316, null, 204, 'Just saw someone use a global variable... in 2024. Cringe.', '{humor, coding}'),
  (317,  316, 205, 'Yikes. That’s a crime against programming.', '{}'),
  (318, null, 205, 'Spent 3 hours debugging only to find out I misspelled a variable. Classic.', '{humor, debugging}'),
  (319,  318, 203, 'Been there, done that. Welcome to the club.', '{}'),
  (320, null, 206, 'Autocomplete is both a blessing and a curse.', '{humor, coding}'),
  (321,  320, 201, 'True, but more blessing when it actually works.', '{}'),
  (322, null, 201, 'Why does every tutorial say “it’s simple” and then proceed to confuse you for hours?', '{humor, learning}'),
  (323,  322, 204, 'Because they are written by people who forgot how hard it is to learn from scratch.', '{}'),
  (324, null, 202, 'My code works. I have no idea why. But it works.', '{humor, coding}'),
  (325,  324, 203, 'If it ain’t broke, don’t fix it.', '{}'),
  (326, null, 204, 'Just spent 2 hours fixing a bug that turned out to be a typo.', '{humor, debugging}'),
  (327,  326, 202, 'Typos: the silent killers.', '{}'),
  (328, null, 205, 'Breakpoints are my best friends.', '{humor, debugging}'),
  (329,  328, 201, 'Especially when you’re deep into spaghetti code.', '{}'),
  (330, null, 206, 'Why do code reviews feel like therapy sessions?', '{humor, coding}'),
  (331,  330, 205, 'Because they are! Code is personal.', '{}'),
  (332, null, 203, 'Just finished a project without any merge conflicts. Feels like winning the lottery.', '{motivation, coding}'),
  (333,  332, 204, 'You should definitely buy a lottery ticket today.', '{}'),
  (334,  311, 203, 'Leap year bugs are like finding Easter eggs... painful ones.', '{}'),
  (335,  313, 204, 'More panic and less cake, unfortunately.', '{}'),
  (336,  313, 201, 'Segfaults: the ultimate surprise gift from your code.', '{}'),
  (337,  314, 202, 'That’s some next-level optimization. Hats off!', '{}'),
  (338,  314, 204, 'O(n log n)? You must have used some dark magic.', '{}'),
  (339,  316, 201, 'Global variables are so last century.', '{}'),
  (340,  318, 206, 'Nothing like a good variable name typo to humble you.', '{}'),
  (341,  318, 204, 'Variable typos: the bane of every coder’s existence.', '{}'),
  (342,  320, 202, 'Autocomplete is the friend who tries too hard.', '{}'),
  (343,  320, 205, 'And sometimes, it’s that annoying friend who finishes your sentences wrong.', '{}'),
  (344,  322, 203, 'It’s their way of saying "Welcome to the real world."', '{}'),
  (345,  322, 206, 'Because simplicity is a complex concept.', '{}'),
  (346,  324, 201, 'The mystery of working code: embrace it.', '{}'),
  (347,  324, 204, 'Sometimes code just wants to be mysterious.', '{}'),
  (348,  326, 205, 'Typo bugs: 1, Human: 0.', '{}'),
  (349,  328, 202, 'Breakpoints are the unsung heroes of debugging.', '{}'),
  (350,  328, 203, 'Breakpoints and coffee: the ultimate combo.', '{}'),
  (351,  330, 201, 'Because they reveal your deepest coding secrets.', '{}'),
  (352,  330, 204, 'It’s a safe space to discuss your code crimes.', '{}'),
  (353,  332, 202, 'Merge conflicts are the worst. Congrats on avoiding them!', '{}'),
  (354,  332, 205, 'That’s a rare achievement! Celebrate it.', '{}');
