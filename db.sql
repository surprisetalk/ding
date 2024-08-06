-- TODO: add indexes
--
--
create schema public;

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
    name text unique not null check (name ~ '^[0-9a-zA-Z_]{4,32}$'),
    email citext unique not null check (email ilike '%@%' and email ~ '^.{4,64}$'),
    password text check (password <> ''),
    bio text not null check (length(bio) between 1 and 1441),
    email_verified_at timestamp,
    invited_by int not null references usr (uid),
    created_at timestamptz not null default current_timestamp
  );

create table
  com (
    cid serial primary key,
    parent_cid int references com (cid),
    uid int references usr (uid) not null,
    tags text[] not null default '{}'::text[] check (1 = (tags <> '{}'::text[])::int + (parent_cid is not null)::int and tags::text ~ '^{[a-z,]{0,64}}$'),
    body text not null check (length(body) between 1 and 1441),
    created_at timestamp default current_timestamp
  );

insert into
  usr (
    uid,
    name,
    email,
    password,
    bio,
    email_verified_at,
    invited_by
  )
values
  (
    101,
    'john_doe',
    'john@example.com',
    crypt('password1!', gen_salt('bf', 8)),
    'sample bio',
    null,
    101
  ),
  (
    102,
    'jane_smith',
    'jane@example.com',
    crypt('password2!', gen_salt('bf', 8)),
    'another sample bio',
    null,
    102
  );

insert into
  com (cid, parent_cid, uid, body, tags)
values
  (201, null, 101, 'this is a sample comment', '{misc}'),
  (202, null, 102, 'this is another sample comment', '{junk}'),
  (
    203,
    201,
    102,
    'this is a reply to the first comment',
    '{}'
  );
