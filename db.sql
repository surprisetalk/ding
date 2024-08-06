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
    usr_id serial primary key,
    name text unique not null check (name <> ''),
    email citext unique not null check (email ilike '%@%'),
    password text,
    bio text check (bio <> ''),
    email_verified_at timestamp,
    invited_by int not null references usr (usr_id),
    created_at timestamptz not null default current_timestamp
  );

create table
  comment (
    comment_id serial primary key,
    parent_comment_id int references comment (comment_id),
    usr_id int references usr (usr_id) not null,
    body text not null check (body <> ''),
    created_at timestamp default current_timestamp
  );

insert into
  usr (
    usr_id,
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
    'john doe',
    'john@example.com',
    'password1!',
    'sample bio',
    null,
    101
  ),
  (
    102,
    'jane smith',
    'jane@example.com',
    'password2!',
    'another sample bio',
    null,
    102
  );

insert into
  comment (comment_id, parent_comment_id, usr_id, body)
values
  (201, null, 101, 'this is a sample comment'),
  (202, null, 102, 'this is another sample comment'),
  (
    203,
    201,
    102,
    'this is a reply to the first comment'
  );
