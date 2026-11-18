# claude.md

## What is ding

A minimalist Slack alternative. Threaded replies and tags. Details: readme.md.

## Commands

```bash
deno serve --watch -A server.tsx   # dev server
deno test -A                       # tests (in-memory PGlite)
deno task bot hn                   # one bot; needs DATABASE_URL + BOT_<NAME>_EMAIL/_PASSWORD
deno task ding msg "hi" "#tag"     # sign a post with ~/.ding/key.json
deno task status                   # grade production
git config core.hooksPath .githooks
```

## Architecture

- `server.tsx`: Hono, postgres.js, server-rendered JSX, Resend. Sections: IMPORTS, TYPES, CONSTANTS & HELPERS, LABEL
  PARSING, EMAIL TOKEN, POSTGRES, DHT, RESEND, STRIPE, COMPONENTS, HONO.
- `dht.ts`: signing and canonical serialization. Server, CLI, node, and tests import it.
- `ding.ts`: CLI. `node.tsx`: replica node. `bots.ts`, `bots/`: bots. `db.sql`: schema. `public/client.js`: client JS,
  served statically.
- Production is the `ding` systemd unit on `pc` (127.0.0.1:8052, behind cloudflared). A push to `main` deploys.
- Secrets live in `/var/lib/ding/env` (0600). Logs: `journalctl -u ding`.
- sharp needs `LD_LIBRARY_PATH` set to gcc's lib on NixOS. The unit and `.githooks/pre-commit` set it.
- Postgres is local: `DATABASE_URL=postgres:///ding`, `PGHOST=/run/postgresql` (postgres.js reads a socket only from
  `PGHOST`).
- postgres.js uses `prepare: false`. DDL that changes a result type breaks cached plans. Fix with
  `pg_terminate_backend`, never `deallocate all`. Also `max: 3`, `idle_timeout: 20`, `statement_timeout: 15s`.
- The server transcodes no video.
- Crons run in-server (`Deno.cron`). Cron name, schedule, and period live in `CRONS`.
- The in-server checkmark cron and bot fleet call `ingestMsg` and `botApi` directly. They never fetch their own origin.

## Load-bearing rules

- `visibleTo` is the ACL. Apply it at every nesting level (children and grandchildren). Emit `orgs = '{}'`, not
  `orgs <@ '{}'`: gin cannot seek `<@`.
- `GET /` and `GET /c` share `visibleTo`, `aggCols`/`aggPairs`, `orderBy`. `GET /` must not select `child_comments`.
- `?sort=top` orders on the `c_reactions` hstore, not the `reaction_count` alias.
- `wireRow` is the single NDJSON wire format (WS and HTTP drain).
- `notifWhere` is the single notification predicate (badge, `/n`, `/n/unread`).
- `pageParam` is the single `?p=` parser. An offset past `paging.maxOffset` is a 400.
- `assetRe` early-return stays above `botRe`. Assets link as `?v=${DENO_DEPLOYMENT_ID}` (`assetUrl`) and cache immutable
  only on a matching `?v=`. Tests use `setAssetV`, not the env var.
- `botRe` (search engines): 403 only with a query string. `AI_CRAWLERS`: 403 on every path. No `AI_CRAWLERS` entry may
  overlap a search engine. `Google-Extended` and `Applebot-Extended` belong in `ROBOTS` only.
- `ROBOTS` joins an array with real newlines. A test rejects a literal `\n`.
- `stat_tag` and `stat_domain` are materialized and public-only. They never use `visibleTo`. Tests call `refreshStats()`
  after seeding content they expect to be scored.
- `PREF_WINDOW` stays a multiple of 25 and never depends on the page. Normalize `s` once (`new`/`top`/else `hot`).
- Normalize `~domain` through `normHost` on write and on read.
- Fetch a user-chosen URL only through `fetchPublic` (in `bots.ts`). `fetchPage` is the single page fetch.
- `dht.ts`: golden vectors in `server.test.ts` pin `canon`, hash, and signature. `buildMsg` sorts tags.
- Private posts (`*org`, `@user`) stay out of the public log unless id-scoped and served auth-gated.
- Deferred: lease-wrapping of register links, mark revocation tombstones.
- `DING_ORG_SK` lives on the main server. It signs checkmarks.

## Bots

- Each bot is `export default (api: Api) => ...`. No top-level side effects. `bots/mod.ts` is the registry. Keys
  uppercase to the `BOT_<NAME>_EMAIL`/`_PASSWORD` prefix.
- Bots call the database through `botApi()` (`feedPosts`, `createPost`, `verifiedUsers`). Put ACL and validation checks
  in those functions, never in route handlers.
- A bot never calls `Deno.exit`. It throws.
- Dedup uses a window (`DEDUP_WINDOW_MS`). Voting bots dedup with `getReactedCids`.
- Mention bots fetch `/c?mention=<bot>` twice (comments and roots).
- A bot that attempts work and lands nothing throws.
- `fitSharp` lives in `bots/images.ts`. `noiseRects` rng draw order is load-bearing.
- `bots/checkmark.ts` is not in the fleet.
- Image fetches of `i.ding.bar` go through `directImageUrl`.
- Verdict bots exclude `bot_%` authors and keep POSTs per run under the 10/min post rate.

## Status

- `GET /status` grades every condition in `checks`. Grade = actual / threshold, floored to 2 decimals. Below 1.0 returns
  503. A check that throws or runs over 5s grades 0.
- snitch runs `deno task status` hourly. ding keeps no status history.
- `beat(name)` records the last time X happened. Every cron and every finished bot beats.
- Run `migrate.sql` before a deploy. Crons write `beat`.

## Testing

- `pgtest(f)` in `server.test.ts` boots an ephemeral PGlite (`jsr:@surprisetalk/pgtemp`), calls `setSql`, resets rate
  limiters, and stubs `Deno.resolveDns`.
- Schema and seed run once into a snapshot. Add fixtures to `setup`/`seedSql`.
- PGlite has no `pgcrypto`. `setup` mocks `gen_salt`/`crypt`. Seeded passwords are `hashed:<password>`.
- Tests serve fixtures on 127.0.0.1 and add it to `fetchGuard.allow`.
