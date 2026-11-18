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

## content negotiation

- `api.ding.bar` or `Accept: application/json` returns JSON.
- `rss.ding.bar` or `Accept: application/xml` returns RSS/XML.
- Default returns HTML.

Write API (api host, Basic Auth, form in, JSON out). `POST /c` reads its body with `form()`, so a JSON body is a 400.

- `POST /c` returns 201 and the `GET /c/:cid` row array on create. It returns 200 `{kind,parent_cid}` for unreact and
  flag.
- `POST /p` returns 200 `{label,vote,ups}`. `vote: null` means cleared.
- No viewer returns 401 `{error}`. `app.onError` turns every `HTTPException` on api into `{error: message}`.

## authentication

- Signed cookies for browser sessions.
- Basic Auth for API access (bots).
- `authed` middleware protects private routes. `some()` allows either method.

## signup anti-spam

`POST /signup` checks these in order, cheapest first. No CAPTCHA.

- Honeypot: a hidden `url` input (`.hp`). A filled input gets a fake success (`redirect /signup?ok`) and creates
  nothing.
- Per-IP throttle: `signupRate` (in-memory sliding window, `perHour`/`windowMs`), keyed by `clientIp(c)`
  (`cf-connecting-ip`, then first `x-forwarded-for` hop, then `"unknown"`). `signupThrottle(c)` returns 429. It also
  guards `/signup/resend` and `/forgot`.
- `badSignupEmail(email)`: rejects throwaway domains (`disposable-domains.txt`) and domains with no MX/A record
  (`hasMailExchange`, `Deno.resolveDns`). It fails open on non-`NotFound` resolver errors.
- Posting needs a verified email. `GET /us` lists verified accounts only. The `ding-prune-unverified` cron deletes
  unverified self-signups older than 7 days (`invited_by = name`).
- Tests stub `Deno.resolveDns` (`fakeResolveDns`) and raise `signupRate.perHour`.

## labels

- `#tag`: public label (`tags` array, GIN indexed).
- `*org`: org label (access by `orgs_r`/`orgs_w`).
- `@user`: mention (`usrs` array).
- `~domain`: synthetic label from every URL host in the body (`domains` array, GIN indexed).

Exports: `parseLabels()`, `decodeLabels()`, `formatLabels()`.

### label prefs (per-viewer ▲/▼)

A pref is a label plus a vote. Table `pref(uid, kind, val, vote)`, PK `(uid, kind, val)`, `kind` in `tag`/`usr`/`www`.
`POST /p` takes a sigil string (`#humor`, `@jane_doe`, `~arxiv.org`). `*org` is rejected.

- `normHost`/`HOST_RE` define `~domain`. `POST /p`, the `?www=` filter, and the `InfoBlock` all normalize through
  `normHost`. A non-hostname `~` value is rejected.
- ▲ is public. ▼ is private (`prefStat` never selects the ▼ count). ▲ on a user is a follow. Mutual means both ▲.
- The primary key is the toggle. The same vote deletes the row. The opposite vote replaces it. One statement with a
  data-modifying `del` CTE does it.
- Post reactions differ. ▲ and ▼ toggle independently. `com_reaction_once` (partial unique index on
  `(parent_cid, created_by, body)` where `char_length(body) = 1`) counts each once. `createPost` uses
  `on conflict do nothing`.
- `pref` is invisible to `refresh_score` and to `stat_tag`/`stat_usr`/`stat_domain`. Personalization is a separate
  ranking stage.
- Only a `usr` pref that inserts is validated. `pref.val` has no FK. A deleted account leaves its row, and removal must
  still work.
- Personalization applies to `GET /` on the default `hot` sort only. A logged-in `hot` feed runs a `mine`/`cand`/`pick`
  CTE chain. `cand` takes `PREF_WINDOW` (300) rows by `score desc, cid desc`. `pick` re-sorts them by score plus pref
  boost. `aggCols` applies above the window. A viewer with no prefs gets the global order. `feedWhere` defines what the
  feed selects for both branches.
- The window does not depend on the page, so paging is a slice of one list. Past the window, the feed falls back to the
  global branch. The two meet on a page boundary.
- Prefs feed the compose chips: an explicit ▲ outranks `own`/`affinity`, and a ▼ suppresses the tag everywhere.
- `/c` search, `sort=new`, and `sort=top` are not personalized. Weights are constants scaled by `usr.pref_weight` (0 to
  2, the `/u` slider).
- Surfaces: `LabelVote` on the `/c?tag=`, `/c?usr=`, `/c?www=` `InfoBlock`s and on `/u/:name`. `/u` shows people
  (mutuals) and interests (toggle-off chips).

### tag discovery

Both surfaces render as `.tag-preset` chips.

- Frontpage presets (`GET /`, logged-in, in the compose form): `top_mine` is capped at 12, so `disco` keeps 8 reserved
  slots. Priority: writable `*orgs` (1), explicit ▲ tags `picked` (2), own posted labels `own` and upvoted-post tags
  `affinity` (3). A ▼ tag is filtered from `mine` and `disco`.
- `disco` is a weighted random sample of `stat_tag` (`posts_count >= 3`):
  `order by -ln(greatest(random(), 1e-9)) / greatest(ups_received / ln(posts_count + 2), 0.05)`. Do not use
  `select distinct on (tag)`: it forces `tag` leftmost and keeps the alphabetically-first N.
- Profile top tags (`topTags(name)`, `User` component): ranked by upvotes received, then post count. Chips link to
  `/c?tag=<tag>`.

### pagination

- `pageParam` parses `?p=`. Malformed and negative values become page 0.
- `p * limit` past `paging.maxOffset` (5000) is a 400, because postgres cannot skip an OFFSET.
- `Pagination` hides "next" at the cap. `paging` is an object so tests can shrink it.

### stats views

- `stat_tag` and `stat_domain` are materialized. `stat_usr` is a plain view.
- `refreshStats()` refreshes both `CONCURRENTLY` on the `ding-refresh-stats` cron (every 10 min). Their unique indexes
  (`stat_tag_tag_idx`, `stat_domain_domain_idx`) allow it.
- `refresh_score` ranks against a snapshot up to 10 minutes old. A new tag or domain earns no reputation until the next
  tick.
- Both are readable by strangers. They filter to public root posts (`orgs = '{}' and usrs = '{}'`) and never use
  `visibleTo`. Private posts do not count in `tag_ups`/`tag_downs`.

## body formatting

`formatBody()` renders lightweight markdown and keeps the symbols visible (`_foo_` renders as `<em>_foo_</em>`).
Supported: `_italic_`, `**bold**`, `` `code` ``, `[text](https://...)`, `# heading`, `> blockquote`, `- item` and
`1. item` lists, fenced and 4-space code blocks. Only code blocks use monospace. Styles: `.body`, `.body pre`,
`.body blockquote`, `.body-list` in `public/style.css`.

- `POST /i` checks the declared `content-length` before it reads the body. A client that drops mid-upload makes
  `c.req.formData()` throw. The handler returns 400.
- The upload id comes from the client. `POST /i` uploads with `noOverwrite` (R2 `If-None-Match: *`) and maps the 412 to
  409. `uploadToR2` overwrites by default, because bots reuse keys (`clipart-<date>.svg`).
- Bare or linked `.mp4`/`.webm` URLs render as muted looping autoplay `<video class="pre-img">` above the link. No
  transcoding. `POST /i` accepts the same extensions (`IMG_EXT_RE`/`MIME_BY_EXT`). `resolveThumbnail` skips video URLs.
- `/c/:cid` fetches two levels of comments. The feed (`/`) stays one level deep.

## account hub (/u)

`GET /u` shows identity (`User` component), bio edit, people (mutual follows), interests (pref chips, each a toggle-off
`POST /p`), orgs (from `orgs_r`, "(read-only)" when not in `orgs_w`), invites (`POST /invite`, "N of 4 used", pending
list), and account actions: logout, custodial `/key` download, and a `<details class="danger">` around
`POST /key/delete`. `/u/:name` shares `User` and stays lean. `/n` stays a separate page.

- The hub runs three queries. The pool is `max: 3`, so a wider `Promise.all` queues.
- The invite list is a `json_agg` subquery on the `usr` row. Prefs, mutuals, and both follow counts share one pass.
- That pass uses `counts left join mine on true`, so a follower count that is not yours never reads as zero. JS drops
  the all-null sentinel row.

## share (?submit=)

Save this as a bookmark, or use the same URL in an iOS Shortcut's Open URL action:

```
javascript:location='https://ding.bar/?submit='+encodeURIComponent(location.href)
```

`GET /?submit=<url>` prefills compose: `<title>\n<url>` in the textarea, up to 8 images as `GET /img` thumbnails, and up
to 3 `#tags` in the labels input. A logged-out request redirects to `/u?next=` before any fetch. An unreadable page
prefills the bare link and shows the reason.

- A labelless browser root post comes back as compose. `POST /c` answers `home(c, draft)` with 200, so the text never
  enters a URL, history, or the request log. The first http(s) URL runs through the `sharing` pipeline. It never fires
  for api callers, a request with `Authorization`, a reply, or a body over 4096 code points. Those reach `createPost`'s
  400.
- `labelled` is the single rule: a `#tag` or an `@user`. `*org` alone fails, because `com_tags_pub_check` wants one of
  those on every root. The labels input has no `required`/`pattern`.
- `fetchPage` is the single foreign-page fetch (3s, `ding/1.0`, first 1 MB, linkedom). Its `images` are `og:image` and
  `twitter:image` only. Readability runs in the `?submit=` path only.
- The strip offers only images that `isImageUrl` accepts, because `formatBody` renders no others.
- Compose previews (`public/client.js`): a row under each `textarea[name=body]` shows each image the post renders, with
  an × that removes its URL. `imagesIn` copies `INLINE_RE`'s URL pattern and `isImageUrl`. Change them together. Code
  that sets a textarea value goes through `setValue`, which fires `input`. An upload previews its local file
  (`localSrc`).
- `GET /img` answers with `Content-Security-Policy: sandbox` and `nosniff`.
- A thumbnail click copies the image. `client.js` POSTs `url` to `POST /i`. The server fetches through `fetchPublic`,
  takes the extension from `content-type`, draws the id, uploads with `noOverwrite`, and answers the `i.ding.bar` URL.
  On refusal (SVG, over 25 MB, dead or private host) the client adds the original link. Refusals answer one generic
  line. The detail goes to the log. A copy counts against `postRate`. The button keeps the copy in `data-mirror`.
- The tagger is one Haiku call (`claude()`, 3s, temperature 0) after Readability. It picks only candidates: the top 150
  `stat_tag` tags plus the viewer's ▲ tags, minus ▼ tags. It drops and logs other words. It never picks `*org` or
  `@user`. A failure leaves the labels to the viewer and logs `tags not suggested`.
- `taggerCap.perDay` (200) caps Haiku calls per UTC day. Each call upserts the `spend` row `(day, 'tagger', n)`. `n`
  over the cap throws `daily cap of N Haiku calls reached` into that catch. `/status` grades today's row.
- A brand-new tag is not a candidate until `refreshStats` runs.

### fetchPublic

User-chosen URLs go through `fetchPublic` (in `bots.ts`, with `fetchGuard`). Users: `fetchPage`, `GET /img`, the
`POST /i` copy, `imageMentionBot` (15s), `extractArticle` (10s).

- Before each hop (first and every redirect, followed by hand, at most 5), it resolves the host. It refuses unless every
  address is public unicast by `ipaddr.js` (`range() === "unicast"`). That blocks loopback, private, link-local, CGNAT,
  and IPv4-mapped addresses.
- Known gap: `fetch` resolves the name again, so DNS rebinding passes.
- Failure text never reaches the user. The detail goes to the log.
- Tests add 127.0.0.1 to `fetchGuard.allow`. Production never does.

## embeddable comments (/embed)

`GET /embed?url=<page>` is a read-only iframe widget (`<iframe src="https://ding.bar/embed?url=PAGE_URL">`). It returns
`c.html` directly, never reads the viewer's cookie, and filters to public root posts (`orgs = '{}' and usrs = '{}'`). A
`domains` GIN prefilter plus `strpos` exact-URL match selects posts (not `ilike`: URLs contain `%` and `_`). Headers:
`Content-Security-Policy: frame-ancestors *`, `X-Robots-Tag: noindex`. `EmbedComment` renders absolute ding.bar links
and no forms. The empty state links `/?www=<domain>`. A bad `?url=` returns 400 with the snippet.

## database (`db.sql`)

- `usr`: users with bcrypt passwords, email verification, org memberships (`orgs_r`/`orgs_w`). `pubkey` + `seckey_enc`
  hold the Ed25519 identity (custodial: AES-256-GCM(JWK, `KEY_WRAP_SECRET`); null means self-custody).
- `pref`: per-user ▲/▼ on a label.
- `com`: comments with threading (`parent_cid`), tags/orgs/usrs arrays, full-text search.
  - `com_feed_idx`: partial index for the anonymous default feed
    (`score desc where parent_cid is null and orgs = '{}' and usrs = '{}'`).
  - `com_root_score_idx` (`score desc where parent_cid is null`): the logged-in feed. Its `usrs` predicate is a
    disjunct, so the equality index cannot serve it.
  - `com_by_created_idx`: serves the bots' `?usr=X&sort=new` path.
  - `= any(array_col)` cannot use gin. Write `links @> array[$1]`.
  - `refresh_score` maintains only `score`.
  - `hash`/`author_id`/`sig`/`parent_hash`/`t` carry the signed DHT identity. `created_by` is null for foreign authors
    (rendered by short hash).
- `dht`: the signed, content-addressed, append-only log. It is the source of truth. `com`/`usr`/`org` are a rebuildable
  projection. `seen_at` (local arrival) is the replication cursor, never the signed `ts`.

## dht (decentralization)

ding's data is a signed, content-addressed, gossip-replicated event log (Nostr/SSB family, not Kademlia). Identity is an
ed25519 keypair. Content id is `k = sha256(canonical signed bytes)`. Any node verifies a row without trusting the
publisher. ding.bar holds keys for users who do not want to (custodial, AES-256-GCM at rest). Self-managed users publish
directly.

```bash
deno task ding msg "hello world" "#tag"     # sign with ~/.ding/key.json, POST to a node (default $DING_DB or https://db.ding.bar)
deno task ding usr --name=you --links=you.com,github.com/you   # identity register (links get verified)
deno task ding org ...                       # org register
deno task ding flag <content-hash>           # signed flag (3 distinct flaggers suppress a post)
deno task ding mark <id>                     # personally vouch for an identity
deno task ding id                            # print your pubkey + id

http POST db.ding.bar < rows.ndjson          # ingest signed rows (per-row verify; bad rows dropped)
http  db.ding.bar/?q='$msg #lol'             # drain the log, filtered by kind + labels
http  ding.bar/key                           # download your custodial key (POST /key/delete for self-custody)
```

- `dht.ts` exports `canon` (sorted keys; floats and unsafe ints rejected), `signRow`/`verifyRow` (Ed25519,
  `crypto.subtle`), `idOf` (sha256 of pubkey), `buildMsg` (tags lowercased, deduped, sorted), `parseLabels`,
  `unwrapSecret`. Golden vectors in `server.test.ts` (fixed ALICE key) keep server, CLI, and node in step.
- `POST /c` signs public root posts and public replies to signed parents into `dht` in one transaction (dht insert and
  `com` projection commit or roll back together; `ingestMsg`). Reactions and replies to legacy posts stay on the
  unsigned `com` path. Validation drops use `DhtReject` (per row, returns `{ok,bad,errors}`). Infrastructure errors
  propagate as 5xx so peers retry.
- `db.ding.bar` node endpoint (routed by `host()`): `POST` ingests NDJSON (per-row `verifyRow`, content-hash and ts-skew
  checks, Elm-style error messages). `GET ?t=&q=` drains oldest to newest by `seen_at`.
- `/key` downloads the custodial JWK. `POST /key/delete` nulls `seckey_enc`.
- Signed `flag` rows: `ingestMsg` counts distinct flagger pubkeys per target hash, mirrors the count onto `com.c_flags`
  (the `[flagged]` suppression), and sets `dht.flagged` at the threshold. `ding flag <hash>` and the web flag button on
  signed posts emit them. Legacy unsigned posts keep the name-based `flaggers` array.
- `usr`/`org` registers: signed rows `{name, bio, links[]}` (org adds `members[]`). `resolveName` ranks contested
  `@name` claims by trust-root marks, then first-seen.
- Private content uses auth-gated delivery, not e2e encryption. `@user` DMs and `*org` posts enter the log with
  id-scoped `usrs`/`orgs`. `ingestMsg` accepts them. The `GET /db` drain is default-deny: public rows, plus the DMs of
  an id and the `*org` rows of orgs whose signed `members` register lists it, for a subscriber that proves a key via a
  single-use challenge (`GET /db/challenge`, then `Authorization: Ding <pubkey> <nonce> <sig>`). A DM projects to
  `com.usrs` as local names, or the raw id for a non-local recipient, never `'{}'`. `*org` content is dht-only.
- Checkmarks: issuer-signed `mark` rows endorse a subject id with a TTL'd claim (`buildMark`, no PII). The renderer
  shows a ✓ when a non-expired identity mark (`email`/`payment`/`human`) from `DING_ORG_PK` targets the author's
  `author_id` (`GET /c` `checked` subquery).
- `bots/checkmark.ts` `runCheckmark()` is the only signer with `DING_ORG_SK`. It signs `email` marks for verified users
  (100 years) and `dns:`/`github:` marks (1-day leases) from a user's `usr` register links: `_ding.<domain>` TXT
  `ding_id=<id>`, or the id in a GitHub bio. It runs hourly via `Deno.cron` in `server.tsx`, only when
  `DENO_DEPLOYMENT_ID` is set. The in-server cron passes a `sink` so marks go through `ingestMsg` directly.
  `deno task
  checkmark` runs standalone and POSTs over HTTP. `Deno.cron` needs `unstable: ["cron"]` in `deno.json`.
  `bots/checkmark.test.ts` mocks DNS and fetch.
- Replication (pull): `dht.seq bigserial` is the local arrival order. `GET /db?after=<seq>` is keyset pagination, and
  returns the next `seq` in the `X-Ding-Cursor` header. `?t=YYYYMMDDhhmmss` is a coarse manual filter.
  `replicate(bootstrap, queries, cursor)` drains, verifies, and ingests each row. It drops bad JSON and `DhtReject` rows
  per line, retries infra errors next tick, and returns the new cursor. `node.tsx` serves the same endpoints and mirrors
  a bootstrap in a 30s non-overlapping `replicate` loop.
- Gossip: `peer` rows advertise a node's dialable origins and served queries. `discoverPeers` reads them. `publishPeer`
  announces. `node.tsx` mirrors the bootstrap (trust anchor) and N discovered peers, and re-broadcasts hourly.
- WebSocket live-tail: `ws://…/db?after=<seq>&q=…` drains history, sweeps, sends `{hb:<seq>}`, then tails via
  `LISTEN/NOTIFY` (`pg_notify` on ingest). One shared `sql.listen('dht')` (`startDhtListener`/`wsSubs`) fetches each
  NOTIFY'd row once and fans out in memory (`matchesQ` mirrors `dhtWhere`). Public rows only. Short-poll `replicate`
  stays the default. PGlite has no LISTEN/NOTIFY, so only `matchesQ` has a unit test.
- `POST /db` rate limit (`dbIngestRate`): per-IP request cap and per-pubkey accepted-row cap, in memory. `ingestMsg`
  takes a post-verify `gate(pubkey)` hook.
- Prod migration: `migrate.sql` (idempotent additive delta), `migration.md` (runbook), and `backfill.ts`
  (`deno task backfill`) signs legacy public posts (resumable; reactions and private posts excluded).
- DHT secrets live in `/var/lib/ding/env` on pc (`KEY_WRAP_SECRET`, `DING_ORG_PK`, `DING_ORG_SK`, `DING_DB`). Run
  `keygen.ts` to make them.
- `DING_ORG_SK` is on the main server. Moving it to a separate cron project would stop a server breach from forging
  checkmarks.
- Not built: lease-wrapping of register links, mark revocation tombstones (long email marks keep the recycled-address
  weakness), verified-link chips in the UI, weighted-flag trust engine, in-browser WebCrypto signing for self-custody
  web posts, retention and compaction, `resolveName` in the web DM compose.

## bots

- Aggregators (HN, Lobsters, arXiv, bubbles, and more) post through `botApi()`.
- LLM persona bots (kenm, bigfoot, caveman, wizard, in the `PERSONAS` table in `bots/personas.ts`, plus critic) use
  `claude()` in `bots.ts` with `claude-haiku-4-5` and need `ANTHROPIC_API_KEY`.
- `Deno.cron("ding-bots")` in `server.tsx` runs the fleet every 5 minutes. `runBotFleet` builds one `Api` per bot and
  runs `BOT_CONCURRENCY` at a time, each with a `BOT_TIMEOUT_MS` deadline and its own try/catch. Missing credentials
  warn and skip.
- Dedup is windowed. `getPostedUrls`/`getAnsweredCids` default to `DEDUP_WINDOW_MS` (30 days). Full history walks past
  `paginate`'s `maxPages=50` and throws. `com.links` holds internal cids, so no index answers exact-URL dedup.
- Bots talk to the database. `Api` carries `feed`/`post`/`users`, injected by `botApi()` and backed by
  `feedPosts`/`createPost`/`verifiedUsers`. Standalone runs need `DATABASE_URL`. Basic Auth costs a bcrypt comparison in
  Postgres, so `botApi` does one per bot per run and resolves the real `usr.name`.
- `createPost` validates its input for every caller: a blank body, a NUL byte, or a non-int parent id is a 4xx. A reply
  in a DM thread adds the parent's author to `usrs`. A legacy flag is one
  `update ... where not (author = any(flaggers))`.
- The ACL lives in `visibleTo` (inside `feedPosts`) and in the parent, org-write, self-react, and rate-limit checks
  (inside `createPost`). `postRate` applies to bots.
- `pathToQuery` turns a bot path (`/c?usr=x&sort=new&limit=100&p=2`, `/c/123`) into a `FeedQuery`. It throws on an
  unknown path. `botApi().feed` round-trips rows through `JSON.parse(JSON.stringify(...))`, because bots expect wire
  JSON.
- `i.ding.bar` proxies `${R2_PUBLIC_URL}/i/<seg>`. A fetch of a user-uploaded image from inside the server goes through
  `directImageUrl`. `imageMentionBot` catches per post. It throws when it attempted work and nothing landed.
- Shared harnesses: `personaBot` (driven by `PERSONAS`), `redditBot` (`reddit`, `hmmm`), `categoryRssBot` (`lobsters`,
  `tildes`), `scanBot` (`haiku`, `pentameter`), `rssBot`, `mentionResponderBot`, `imageMentionBot`, `dailyPostBot`
  (`lectures` drips `bots/data/lectures.tsv`; a bad row fails the bot and its status condition), `pickCandidates` (the
  "worth replying to" filter), `myRecent`, `fetchFeedText`, `fitSharp` (in `bots/images.ts`, so `bots.ts` never imports
  sharp), `dupeLayers`/`noiseRects` (`clipart`/`emojiglitch`), `sweepFeeds`, `redditFetch`/`parseRedditEntries`,
  `glitchSvg`/`glitchTwemojiToR2`, `fetchFreshPosts`, `atomTitleLink`, `parseTitleLinkComments`, `decodeEntities`.
- `unansweredMentions` is the single mention trigger, with the own-post, answered, and stale filter. It fires two
  `/c?mention=<bot>` fetches, because `comments=1` selects comments instead of roots. `cowsay`, `dice`, `8ball`, and
  `sortinghat` trigger on mentions, not `#tag`.
- `mentionResponderBot`'s `max` bounds successful replies. It throws when replies were attempted and none landed. A
  `respond` that returns null must decide cheaply, because the mention returns every tick for `MAX_AGE_MS`.
- `verdictBot`: one Haiku call judges a batch of fresh posts into a `verdict -> action` map, capped at `maxActions`.
  Callers: `critic` (earnest ▲/▼), `hypebot`, `replyguy`, `grouch` (the only downvoter, at most 2 ▼ per run, since ▼
  weighs 3x ▲). Action contract: `null` is declined, `false` is a failed POST, else landed. Each cid acts once per
  batch. `getAnsweredCids` uses `comments=1` (`char_length(body) > 1`) and cannot see votes, so voting bots use
  `getReactedCids` (`reactions=1`).
- Credentials live in `/var/lib/ding/env`. `bots.env` (gitignored) is their source. `bot_linkedin` has a `usr` row and
  no bot file.

## crawlers

- `botRe` (search engines) gets a 403 only when the request has a query string. Filtered feeds are an infinite crawl
  space. Content URLs stay indexable.
- `aiBotRe`/`AI_CRAWLERS` (training scrapers) gets a 403 on every path, because the heaviest ignore `robots.txt`.
- `ROBOTS` joins an array with `"\n"`. Check with `curl -s .../robots.txt | od -c`.

## hosting

- `ding-pull` fetches each minute. `ding-restart` restarts the unit when HEAD moves.
- `ding-backup` dumps nightly to `~/Developer/ding/nightly.dump`. `r2-backup` copies it to R2.
- Client JS lives in `public/client.js` and is not inlined. Server data reaches it as `data-` attributes on `<body>`
  (`data-unread`, logged in only).
- The `app.use("*")` middleware returns early on asset paths (`assetRe`): no cookie read, no `refreshVerified`, no
  unread query.
- Asset caching: `style.css` and `client.js` carry no content hash. HTML links them as `?v=${DENO_DEPLOYMENT_ID}`
  (`assetUrl`). The middleware sets `cache-control: public, max-age=31536000, immutable` only when `?v=` matches.
  Locally the variable is unset, so nothing caches. Setting it in tests would register the bot fleet cron, so tests use
  `setAssetV`.
- The `GET /` and `GET /c` feeds: `GET /` renders roots only (`Post` never touches `child_comments`). Only `GET /c`
  selects `child_comments` and needs `visibleTo` at the child and grandchild levels. `notifWhere` matches an `@user`
  label naming me, a reply to my post, or a body `@mention` of me on a post with no `@user` label. The badge is skipped
  on `/n/unread` so the 60s poller counts once. `visibleTo` emits `orgs = '{}'` for the no-readable-orgs case, because
  gin's `<@` scans the whole index. `?sort=top` orders on `c_reactions`, because an alias in ORDER BY runs the
  correlated subquery for every candidate row.

## status

```bash
deno task status   # grades production; exits 1 when any condition is below 1.0
```

- `GET /status` grades every condition in `checks` (`server.tsx`). Grade is actual / threshold, unclamped, floored to 2
  decimals. The body maps each condition to `{"0": grade}`. The route answers 503 when any grade is below 1.0. A check
  that throws or exceeds 5s grades 0 and logs expected, received, source, and fix. Requests inside 30s share one grading
  (`gradeMemo`).
- snitch runs `deno task status` (`ding.ts status <url>`) hourly from pc, logs it, and mails the 4:30 report. That run
  is the external uptime ping.
- `beat(name)` upserts "the last time X happened" into the `beat` table. Every `Deno.cron` beats its name after a good
  tick. `runBotFleet` beats `bot:<name>`. `CRONS` defines each cron name, schedule, and period. Keep each period equal
  to its schedule.
- The bot condition keeps one key. Below 1, it also logs the stale bot names (no `bot:<name>` beat in the past hour).
- Run `migrate.sql` before a deploy.

## local dev

prereqs: [deno](https://deno.com/), `postgresql`, `postgresql-contrib`, & `postgresql-client` (includes the `psql` CLI)

`.env`: refer to `.env.example`

```bash
psql -d postgres -c "create database ding"
psql -d ding -x < db.sql
deno serve --watch -A --env server.tsx
git config core.hooksPath .githooks  # enable pre-commit hook
```

## tests

```bash
deno test -A
```

`pgtest(f)` in `server.test.ts` boots one ephemeral PGlite (`jsr:@surprisetalk/pgtemp`) per test, swaps it in with
`setSql`, resets the rate limiters, and stubs `Deno.resolveDns`. `await using` tears the backend down on a throw.

- Schema and seed run once at module load into a `snapshot` blob. Add fixtures to `setup`/`seedSql`.
- PGlite has no `pgcrypto`. `setup` mocks `gen_salt`/`crypt` and strips `create extension pgcrypto`. Seeded passwords
  are `hashed:<password>`.
- `pgtemp`'s client comes from `npm:postgres`. The server imports `deno.land/x/postgresjs`. One `as unknown as pg.Sql`
  cast in `pgtest` bridges them.
