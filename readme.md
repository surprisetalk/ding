# ding

a minimalist slack alternative [from the future](https://futureofcoding.org)

## api

```bash
http ding.bar              # home page

http ding.bar/c            # all posts
http ding.bar/c?p=1        # second page
http ding.bar/c?q=hello    # search posts
http ding.bar/c?uid=123    # posts from user 123
http ding.bar/c?tag=misc   # posts tagged

http     ding.bar/c?q=hi   # returns html
http api.ding.bar/c?q=hi   # returns json
http rss.ding.bar/c?q=hi   # returns xml

http ding.bar/c/234        # post replies

http ding.bar/u            # all users
http ding.bar/u/123        # user profile
http ding.bar/u?q=lisp     # search users

http POST ding.bar ...     # TODO
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
