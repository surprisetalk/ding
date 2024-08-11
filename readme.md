# ding

a minimalist slack alternative [from the future](https://futureofcoding.org)

## api

```bash
http futureofcod.ing              # home page

http futureofcod.ing/c            # all posts
http futureofcod.ing/c?p=1        # second page
http futureofcod.ing/c?q=hello    # search posts
http futureofcod.ing/c?uid=123    # posts from user 123
http futureofcod.ing/c?tag=misc   # posts tagged

http     futureofcod.ing/c?q=hi   # returns html
http api.futureofcod.ing/c?q=hi   # returns json
http rss.futureofcod.ing/c?q=hi   # returns xml

http futureofcod.ing/c/234        # post replies

http futureofcod.ing/u            # all users
http futureofcod.ing/u/123        # user profile
http futureofcod.ing/u?q=lisp     # search users

http POST futureofcod.ing ...     # TODO
```

## local dev

```bash
psql -d postgres -c "create database ding"
psql -d ding -x < db.sql
deno serve --watch -A server.tsx
```

## tests

```bash
deno test -A
```
