# ding

a minimalist slack alternative

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

http -a you@x.org:pw -f POST api.ding.bar/c body=hi tags='#misc'
http -a you@x.org:pw -f POST api.ding.bar/c/45 body=▲
http -a you@x.org:pw -f POST api.ding.bar/p label='#humor' vote=1
http -a you@x.org:pw api.ding.bar/n
```

## share

`https://ding.bar/?submit=<url>` opens compose with the page's title, the link, and up to 3 suggested tags filled in.
Publishing with no labels brings the text back to compose with suggested tags. Click an image found on the page to add a
copy of it, hosted on i.ding.bar. Save this as a bookmark, or use the same URL in an iOS Shortcut's Open URL action:

```
javascript:location='https://ding.bar/?submit='+encodeURIComponent(location.href)
```

## dht (decentralization, phase 1)

ding's data is a signed, content-addressed log. identity is an ed25519 keypair; every post is content-addressed
(`k = sha256(canonical signed bytes)`) and signed, so any node can verify it without trusting the publisher.

```bash
deno task ding msg "hello world" "#tag"     # sign with ~/.ding/key.json, POST to a node
deno task ding usr --name=you --links=you.com,github.com/you   # identity register (links get verified)
deno task ding flag <content-hash>           # signed flag (3 distinct flaggers suppress a post)
deno task ding mark <id>                      # personally vouch for an identity
deno task ding id                            # print your pubkey + id

http POST db.ding.bar < rows.ndjson          # ingest signed rows (per-row verify; bad rows dropped)
http  db.ding.bar/?q='$msg #lol'             # drain the log, filtered by kind + labels
http  ding.bar/key                           # download your custodial key (then POST /key/delete for self-custody)
```

verified identities show a ✓ — `bots/checkmark.ts` (the checkmark cron) signs `mark` rows for verified emails
(DNS/GitHub proofs next); the renderer trusts marks from `DING_ORG_PK`.

ding.bar holds keys for users who don't want to (custodial, AES-256-GCM at rest); self-managed users publish directly.
multi-peer gossip, the checkmark/verification service, and leases are not yet built.

## local dev

prereqs: [deno](https://deno.com/), `postgresql`, `postgresql-contrib`, & `postgresql-client` (includes the `psql` CLI)

`.env`: refer to `.env.example`

```bash
psql -d postgres -c "create database ding"
psql -d ding -x < db.sql
deno serve --watch -A --env server.tsx
git config core.hooksPath .githooks  # enable pre-commit hook
```

## status

```bash
deno task status   # grades production; exits 1 when any condition is below 1.0
```

## tests

```bash
deno test -A
```
