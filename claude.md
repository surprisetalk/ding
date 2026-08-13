# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is ding?

A minimalist Slack alternative. Simple social commenting with threaded replies and tags.

## Commands

```bash
# Development server (watches for changes)
deno serve --watch -A server.tsx

# Run tests (uses in-memory PGlite)
deno test -A

# Run a single bot manually (real HTTP against $DING_API_URL; needs BOT_<NAME>_EMAIL/_PASSWORD)
deno task bot hn

# Post to the DHT with your own key (self-managed identity)
deno task ding msg "hello world" "#tag *org @user"   # default node: $DING_DB or https://db.ding.bar
deno task ding id                                     # show your pubkey + id (~/.ding/key.json)

# Database setup
psql -d postgres -c "create database ding"
psql -d ding -x < db.sql

# Enable pre-commit hook (one-time per clone)
git config core.hooksPath .githooks
```

## Architecture

**Single-file server** (`server.tsx`, ~3,300 lines) using:

- **Hono** - HTTP framework with middleware chain
- **postgres.js** - SQL via template literals (`sql\`SELECT ...\``)
- **JSX** - Server-side rendered components (no frontend framework)
- **Resend** - Email delivery

Server is organized with `//// SECTION ////` headers: IMPORTS, TYPES, CONSTANTS & HELPERS, LABEL PARSING, EMAIL TOKEN,
POSTGRES, DHT, RESEND, STRIPE, COMPONENTS, HONO. The `GET /` and `GET /c` feed queries share fragment builders
(`visibleTo` ACL, `aggCols`/`aggPairs` per-row aggregates, `orderBy`) so the two feeds can't drift; `visibleTo` is
applied per nesting level (children and grandchildren too — a DM or `*org` reply under a public root must not leak to
strangers). `wireRow` is the single definition of the NDJSON wire format (WS live-tail + HTTP drain must stay
byte-identical). `notifWhere` is the single definition of the notification predicate (nav badge + `/n` + `/n/unread`);
the badge is skipped on `/n/unread` so the 60s poller doesn't run the count twice. `visibleTo` emits `orgs = '{}'`
rather than `orgs <@ '{}'` for the common no-readable-orgs case — gin's `<@` cannot seek, so it scans the whole index.
`?sort=top` orders on the denormalized `c_reactions` hstore, NOT the `reaction_count` select alias: an alias in ORDER BY
makes postgres run that correlated subquery for every candidate row, not just the 25 returned. `GET /` renders roots
only (`Post` never touches `child_comments`), so it must NOT select a `child_comments` array — only `GET /c` does, and
only `GET /c` needs `visibleTo` at the child + grandchild levels.

**Client JS lives in `public/client.js`**, served statically and cached — it is NOT inlined into every page.

**Asset caching**: `style.css`/`client.js` have no content hash in their path, so the HTML links them as
`?v=${DENO_DEPLOYMENT_ID}` (`assetUrl`) and the middleware sets `cache-control: public, max-age=31536000, immutable`
**only** when `?v=` matches the current deploy. A bare or stale-version path stays revalidated, so a client that guesses
the path can't pin one deploy's copy for a year, and a deploy invalidates everything by changing the URL.
`DENO_DEPLOYMENT_ID` is unset locally → no versioning and no caching, so edits show up. Tests override it with
`setAssetV` rather than the env var, because setting `DENO_DEPLOYMENT_ID` would make `Deno.cron` register the bot fleet.
The `assetRe` early-return must stay ABOVE the `botRe` check — assets now carry a query string, and that check 403s any
crawler request with one. Anything it needs from the server arrives as a `data-` attribute on `<body>` (currently
`data-unread`, present only when logged in). The `app.use("*")` middleware early-returns on asset paths (`assetRe`), so
a `/client.js` or `/style.css` hit costs no cookie read, no `refreshVerified`, and no unread query.

**Postgres connection**: `DATABASE_URL` is Neon's **`-pooler`** endpoint (transaction mode), so `server.tsx` sets
`prepare: false`. Named prepared statements there outlive the client that created them and are reused by the next one,
so any DDL that changes a result type (`alter table ... drop column`) makes every cached plan fail with
`cached plan
must not change result type` — site-wide, including freshly-started isolates. Recover by terminating the
pooled backends (`pg_terminate_backend`), never with `deallocate all`. Also set: `max: 3` (each isolate gets its own
pool), `idle_timeout: 20`, `statement_timeout: 15s`.

**Database** (`db.sql`):

- `usr` - Users with bcrypt passwords, email verification, org memberships (`orgs_r`/`orgs_w` arrays). `pubkey` +
  `seckey_enc` hold the user's Ed25519 identity (custodial key = AES-256-GCM(JWK, `KEY_WRAP_SECRET`); null =
  self-custody)
- `pref` - Per-user ▲/▼ on a label: `(uid, kind in ('tag','usr','www'), val, vote)`, PK `(uid, kind, val)`. See **Label
  Prefs** below
- `com` - Comments with threading (parent_cid), tags/orgs/usrs arrays, full-text search. Index rules: `com_feed_idx` is
  the partial index the default feed rides (`score desc where parent_cid is null and orgs = '{}' and usrs = '{}'`);
  `com_by_created_idx` serves the bots' `?usr=X&sort=new` hot path. `= any(array_col)` cannot use a gin index — write
  `links @> array[$1]` (that was a full table scan on every write and every thread view). `refresh_score` maintains only
  `score`; the eight `author_ups`/`tag_ups`/… columns it used to write were never read and are dropped.
  `hash`/`author_id`/`sig`/ `parent_hash`/`t` carry the signed DHT identity; `created_by` is null for foreign authors
  (rendered by short hash)
- `dht` - The signed, content-addressed, append-only log (source of truth; `com`/`usr`/`org` are a rebuildable
  projection). `seen_at` (local arrival) is the replication cursor, never the attacker-controlled signed `ts`

## Decentralization (DHT) — Phase 1

ding is being decentralized into a signed, content-addressed, gossip-replicated event log (Nostr/SSB family, **not**
Kademlia). Identity is an Ed25519 keypair; content is content-addressed (`k = sha256(canonical signed bytes)`) and
signed.

- **`dht.ts`** - the load-bearing shared module (server + CLI + node + tests import it): `canon` (deterministic
  serialization — sorted keys, floats/unsafe-ints rejected), `signRow`/`verifyRow` (Ed25519 via `crypto.subtle`, zero
  deps), `idOf` (= sha256 of pubkey), `buildMsg` (normalizes tag arrays: lowercased, deduped, **sorted**),
  `parseLabels`, AES-GCM `wrapSecret`/`unwrapSecret`. Golden vectors are frozen in `server.test.ts` (a fixed ALICE key →
  fixed canon/hash/sig) so server, CLI, and node can never silently diverge.
- **Phase 1 carries PUBLIC posts only.** `POST /c` signs public root posts and public replies-to-signed-parents into
  `dht` (one transaction: dht insert + `com` projection commit/rollback together; `ingestMsg`). Reactions,
  `*org`/`@user` (private) posts, and replies-to-legacy posts stay on the unsigned `com` path, so private bodies never
  enter the public log. `ingestMsg` also rejects any incoming `msg` row scoped to `*org`/`@user`. Validation drops use
  `DhtReject` (per-row, returns `{ok,bad,errors}`); infrastructure errors propagate as 5xx so peers retry.
- **`db.ding.bar` node endpoint** (subdomain-routed via `host()`): `POST` ingests NDJSON rows (per-row `verifyRow` +
  content-hash + ts-skew checks, bad rows dropped with Elm-style messages, returns `{ok,bad,errors}`); `GET ?t=&q=`
  drains the log oldest→newest by `seen_at`, filtered by `q` (e.g. `$msg #lol`).
- **`/key`** downloads the custodial JWK; **`POST /key/delete`** nulls `seckey_enc` (switch to self-custody).
- **Signed `flag` rows** (Phase 2a): `ingestMsg` counts **distinct flagger pubkeys** per target hash and mirrors that
  onto the projected `com.c_flags` (so the existing `[flagged]` suppression works) + sets `dht.flagged` at the
  threshold. `ding flag <hash>` and the web flag button (on signed posts) emit them; legacy unsigned posts keep the
  name-based `flaggers` array.
- **Checkmarks / `mark` rows** (Phase 2b): issuer-signed `mark` rows endorse a subject id with a TTL'd claim
  (`buildMark`, claim never carries PII). The ✓ renders when a non-expired identity mark (`email`/`payment`/`human`)
  from the trust root (`DING_ORG_PK` env) targets the author's `author_id` (`GET /c` `checked` subquery → `Meta`).
  `bots/checkmark.ts` exports `runCheckmark()` (the **only** signer with `DING_ORG_SK`): `email` marks for verified
  users (100yr), plus `dns:`/`github:` marks (1-day leases) proved from a user's **`usr` register** links —
  `_ding.<domain>` TXT `ding_id=<id>` or the id in a GitHub bio (handle sanitized). It runs hourly via **`Deno.cron`**
  in `server.tsx`, gated on `DENO_DEPLOYMENT_ID` so it registers only on Deno Deploy (never in tests/local). The
  in-server cron passes a **`sink`** so `runCheckmark` ingests marks via `ingestMsg` **directly** — NOT an HTTP POST to
  `db.ding.bar` (a Deno Deploy isolate fetching its own custom domain redirect-loops, which silently dropped every
  mark). `deno task checkmark` (standalone) still POSTs over HTTP. `Deno.cron` needs `unstable: ["cron"]` +
  `deno.unstable` lib (in `deno.json`). `deno task checkmark` triggers a manual run. Proof helpers + `runCheckmark` are
  testable (`bots/checkmark.test.ts` mocks DNS/fetch). `ding mark <id>` is a personal vouch. ⚠️ SIMPLE path:
  `DING_ORG_SK` is on the main server — harden later (separate cron project) so a server breach can't forge checkmarks.
- **`usr` register**: a signed `usr` row `{name, bio, links[]}` (`ding usr --name --bio --links`), ingested into the
  dht; the checkmark cron reads it to verify domain/social links. (Leases + resolution come with Phase 4.)
- **Replication** (Phase 3, Stage 1 — pull/short-poll): the dht has a `seq bigserial` (strictly-increasing local arrival
  order). `GET /db?after=<seq>` is keyset pagination on `seq` (immune to clock skew / same-second collisions / the
  > limit wedge); it returns the next `seq` as the `X-Ding-Cursor` header. (`?t=YYYYMMDDhhmmss` remains a coarse "since
  > UTC time" filter for manual drains.) `replicate(bootstrap, queries, cursor)` drains from the cursor, verifies +
  > ingests each row (bad-JSON and `DhtReject` rows dropped per-line; infra errors retried next tick), and returns the
  > advanced cursor. `node.tsx` is a replica that serves the same endpoints **and** mirrors a bootstrap via a
  > self-scheduling 30s `replicate` loop (no overlapping ticks). Works on Deno Deploy.
- **Gossip mesh** (Phase 4): `peer` rows advertise a node's dialable origins + served queries; `discoverPeers` reads
  them, `publishPeer` announces. `node.tsx` mirrors the bootstrap (always, as a trust anchor) + N discovered peers,
  re-broadcasting hourly.
- **Private content — auth-gated delivery, no e2e encryption** (Phase 3 Stage 2): `@user` DMs and `*org` posts enter the
  log with **id-scoped** `usrs`/`orgs` (names aren't key-bound). The `GET /db` drain is **default-deny**: it serves
  public rows, plus — for a subscriber that proves a key via a single-use challenge (`GET /db/challenge` →
  `Authorization: Ding <pubkey> <nonce> <sig>`) — that id's DMs and the `*org` rows of orgs whose signed `members`
  register lists it. `dht.usrs`/`orgs` stay id-scoped (gating); a DM projects to `com.usrs` resolved to local names (or,
  for a non-local recipient, the raw id — never `'{}'`, so it can't render publicly). `*org` content is dht-only.
- **`usr`/`org` registers** carry `{name, bio, links[]}` (+ org `members[]`); `resolveName` ranks contested `@name`
  claims by trust-root marks then first-seen. `ding usr`/`ding org` publish them.
- **WebSocket live-tail** (optional, low-latency): `ws://…/db?after=<seq>&q=…` drains history → catch-up sweep →
  `{hb:<seq>}` → live-tails via `LISTEN/NOTIFY` (`pg_notify` on ingest). **Runs on Deno Deploy** — WS is supported and
  Postgres `LISTEN/NOTIFY` coordinates cross-isolate, so a `POST /db` in one isolate wakes the listener in another. Uses
  **ONE shared per-isolate `sql.listen('dht')`** (`startDhtListener`/`wsSubs`): each NOTIFY'd row is fetched once and
  fanned out in memory to matching subscribers (`matchesQ` mirrors `dhtWhere` containment) — no DB connection per
  subscriber. **Public rows only**; auth-gated private delivery stays on the HTTP drain. Short-poll (`replicate`)
  remains the connection-light default. The WS socket plumbing isn't covered by the PGlite harness (no LISTEN/NOTIFY
  there); `matchesQ` is unit-tested.
- **`ding.ts`** CLI signs with `~/.ding/key.json`. Commands: `msg`, `usr`, `org`, `flag`, `mark`, `id`.
- **`POST /db` rate limit** (`dbIngestRate`): per-IP request cap + per-pubkey accepted-row cap (in-memory per-isolate,
  like `postRate`; limits tunable on the object). `ingestMsg` takes a post-verify `gate(pubkey)` hook for it.
- **Prod migration**: `migrate.sql` (idempotent additive schema delta, validated), `migration.md` (runbook — ordering,
  irreversibility warnings, smoke checklist, rollback), and `backfill.ts` (`deno task backfill`) signs legacy public
  posts into the dht (resumable/idempotent; reactions + private posts excluded).
- **Deploy note:** all DHT secrets live in Deno Deploy env (`KEY_WRAP_SECRET`, `DING_ORG_PK`, `DING_ORG_SK`, `DING_DB`);
  the checkmark cron is in-server `Deno.cron`. Run `keygen.ts` to generate them.
- **Explicit 70% cuts (deferred):** lease-wrapping register links + mark revocation tombstones (link marks already
  expire via DAY leases; long email marks are a known recycled-address weakness); verified-link chips in the UI;
  weighted-flag trust engine; in-browser WebCrypto signing for self-custody web posts; retention/compaction; wiring
  `resolveName` into the web DM compose. See `~/.claude/plans/i-d-like-to-decentralize-radiant-aho.md`.

**Bots** (`bots/`):

- Content aggregators (HN, Lobsters, arXiv, bubbles, etc.) that post via Basic Auth
- LLM persona bots (kenm, bigfoot, caveman, wizard — all defined by the `PERSONAS` table in `bots/personas.ts`, not by
  per-bot files — plus critic) use the `claude()` helper in `bots.ts` with Haiku 4.5 (`claude-haiku-4-5`; Haiku 3
  retired 2026-04-19 and 404s); require `ANTHROPIC_API_KEY`
- **Every bot is `export default (api: Api) => …`** — a function, never a top-level side effect, so it can be called
  repeatedly in one isolate. `bots/mod.ts` is the registry (static imports, so Deno Deploy bundles them); its keys are
  the bot names and uppercase to the `BOT_<NAME>_EMAIL`/`_PASSWORD` env prefix.
- **Runs every 5 minutes from `Deno.cron("ding-bots")` in `server.tsx`** (was GitHub Actions until 2026-07-27).
  `runBotFleet` builds one `Api` per bot and runs them `BOT_CONCURRENCY` at a time, each with a `BOT_TIMEOUT_MS`
  deadline (Deno skips a tick while the previous run is live, so an untimed hang would wedge the whole fleet) and its
  own try/catch (one bot's failure can't abort the sweep). Missing creds → warn + skip, never throw.
- **Dedup is windowed, not full-history.** `getPostedUrls`/`getAnsweredCids` default to `DEDUP_WINDOW_MS` (30 days).
  Unbounded history walks past `paginate`'s `maxPages=50` cap and throws — that silently killed bot_hn and bot_smallweb
  for months under Actions' `continue-on-error`. `com.links` is internal cids, not external URLs, so no index can answer
  exact-URL dedup; the window is the fix.
- **`Api` carries its own `fetch`** — that's the seam. Standalone runs (`deno task bot hn`) use real fetch against
  `DING_API_URL`; the cron passes `botFetch`, which dispatches through `app.request` in-process because a Deno Deploy
  isolate **cannot fetch its own origin**. `botFetch` follows redirects the way real fetch does — a successful `POST /c`
  302s to `/c/<cid>`, so an unfollowed redirect reads as failure on every single post. Bots must never `Deno.exit` (it
  would kill the server isolate); throw instead.
- **The self-origin rule applies to image fetches too.** `i.ding.bar` is a custom domain on the same Deploy project (the
  `host(c) === "i"` middleware just proxies `${R2_PUBLIC_URL}/i/<seg>`), so any in-isolate fetch of a user-uploaded
  image must be rewritten with `directImageUrl` first — `https://i.ding.bar/<id>.<ext>` →
  `${R2_PUBLIC_URL}/i/<id>.<ext>`. That killed `dither`/`pixelsort`/`lowpoly` on every image posted through `POST /i`
  while they kept working on external hosts (`i.redd.it` etc.), which is why it looked like the bots were fine.
  `imageMentionBot` catches per-post so one bad image can't abort the mentions behind it, and throws when it attempted
  work and nothing landed (a "no image found" mention is a legitimate silent decline, not an attempt).
- Shared harnesses (each bot should be a config, not a copy): `personaBot` (LLM replies) is driven entirely by the
  `PERSONAS` table in `bots/personas.ts` — there is no per-persona file. `redditBot` powers both `reddit` and `hmmm`;
  `categoryRssBot` powers `lobsters` and `tildes`; `scanBot` (feed scan → recogniser → reply) powers `haiku` and
  `pentameter`; `pickCandidates` is the single "worth replying to" filter (`personaBot`, `verdictBot`, `tldr`,
  `reader`); `myRecent` backs `getAnsweredCids`/`getReactedCids`/`getPostedUrls`; `fetchFeedText` backs the RSS sweeps;
  `fitSharp` (in `bots/images.ts`, so `bots.ts` never imports sharp) backs `pixelsort`/`lowpoly`;
  `dupeLayers`/`noiseRects` back `clipart`/`emojiglitch`. **`noiseRects`' rng draw order is load-bearing** — clipart
  seeds its rng, so reordering the draws changes the artwork.
- Most bots are thin configs over shared harnesses in `bots.ts`: `rssBot` (single RSS feed), `personaBot` (LLM replies),
  `mentionResponderBot` (reply to fresh `@bot` mentions), `imageMentionBot` (transform an image from a @mention),
  `dailyPostBot` (one gated post per run). The mention harnesses share `unansweredMentions` — the **single** definition
  of the mention trigger, plus the own-post/answered/stale filter and its `Found N unanswered @<bot> posts` log. It
  fires **two** `/c?mention=<bot>` fetches on purpose: `comments=1` selects `parent_cid is not null`, i.e. comments
  **instead of** roots, so one query can never see both (this silently made every mention bot comment-only).
  `cowsay`/`dice`/`8ball`/`sortinghat` are mention-triggered, **not** `#tag`-triggered (they used to be; `#cowsay` posts
  no longer get answered). `mentionResponderBot`'s `max` bounds _successful_ replies, so it throws when it attempted
  replies and none landed — otherwise a run that burns 20 LLM calls into a rate limit reports green. A `respond` that
  returns null must decide cheaply: the mention isn't marked answered, so it returns every tick for the whole
  `MAX_AGE_MS` window. Shared helpers: `sweepFeeds` (bounded-concurrency newest-per-feed),
  `redditFetch`/`parseRedditEntries`, `glitchSvg`/`glitchTwemojiToR2`, `fetchFreshPosts`, `atomTitleLink`,
  `parseTitleLinkComments`, `decodeEntities` (fixpoint HTML-entity decode, for feeds that double-encode)
- **`verdictBot`** (bots.ts): one Haiku call judges a batch of fresh posts → a `verdict → action` map, capped at
  `maxActions` (keep POSTs-per-verdict × maxActions under the 10/min post rate). Callers: `critic` (earnest ▲/▼) and the
  deliberately-janky crew — `hypebot` (▲ plus a gushing note that misses the point), `replyguy` (confident off-topic
  one-liners, no votes), `grouch` (grumbles; the only downvoter, hard-capped at 2 ▼/run since ▼ weighs 3x ▲ in ranking).
  Action contract: `null` = declined by design, `false` = POST failed, else landed; the run throws when POSTs were
  attempted and none landed (a rate-limited/credential-rotted run must not report green). Each cid acts at most once per
  batch (a duplicate verdict would toggle the vote back off) and `bot_%` authors are excluded (verdict bots reacting to
  each other's replies would chain forever). Voting bots must dedup with `getReactedCids` (`reactions=1`, i.e.
  `char_length(body) = 1`): `getAnsweredCids` uses `comments=1` (`char_length(body) > 1`) and is blind to
  single-grapheme votes — that blindness made critic re-judge the same posts every 5-min tick and toggle its own votes
  off.
- `bots/checkmark.ts` is NOT part of the fleet (not in `bots/mod.ts`; consumed by `server.tsx` as `runCheckmark`)
- Credentials live in Deno Deploy env, not GitHub secrets. `bots.env` (gitignored) is the upload file; `bot_linkedin`
  still has a `usr` row but no bot file, so nothing runs it.

## Label System

Search and tagging use a unified label syntax:

- `#tag` - public labels (stored in `tags` array, GIN indexed)
- `*org` - org/private labels (access controlled via user's `orgs_r`/`orgs_w`)
- `@user` - user mentions (stored in `usrs` array)
- `~domain` - synthetic label auto-extracted from every URL host in the body (stored in `domains` array, GIN indexed)

Exported functions: `parseLabels()`, `encodeLabels()`, `decodeLabels()`, `formatLabels()`

## Label Prefs (per-viewer ▲/▼)

**A pref is a label plus a vote.** The `pref` table is `(uid, kind, val, vote)` where `kind` is one of `tag`/`usr`/`www`
— the same `PFX` vocabulary the feed speaks — so `POST /p` takes a sigil string (`#humor`, `@jane_doe`, `~arxiv.org`)
and `parseLabels` does the parsing. `*org` is rejected: org access is `orgs_r`/`orgs_w` membership, not a preference.

`normHost`/`HOST_RE` are the single definition of the `~domain` vocabulary — `com.domains` only ever holds bare
lowercase hosts (`extractDomains`), so `POST /p`, the `?www=` filter parse, and the `~domain` `InfoBlock` all normalize
through `normHost`. Normalizing on write but not read is a trap: the ▲ renders un-voted on `?www=www.arxiv.org` and
clicking it **deletes** the pref. `~` values that aren't hostnames (a URL, a path, `~.`) are rejected rather than stored
as a pref that could never match.

- **▲ is public, ▼ is private.** `prefStat` selects the ▲ count and the viewer's own vote, never the ▼ count. ▲ on a
  user is a follow; mutual = both sides ▲. A mute has no read path off the voter's own `/u`.
- **The primary key is the toggle.** Re-sending the same vote deletes the row, the opposite vote replaces it. Done in
  one statement with a data-modifying `del` CTE (postgres always runs it to completion), so a double-click can't stack
  rows — unlike post reactions, which have no uniqueness constraint and where ▲/▼ are independent toggles a user can
  hold both of.
- **`pref` is invisible to `refresh_score`** and to `stat_tag`/`stat_usr`/`stat_domain`. Those stay global reputation;
  `pref` is per-viewer. That split is why personalization is a separate ranking stage, not a new term in the polynomial.
- **Only a `usr` pref that will INSERT is validated.** `pref.val` has no FK (a partial one isn't expressible), so a
  followed account that is later deleted — `ding-prune-unverified` does exactly that — leaves the row behind. Rejecting
  the removal too would strand a dead chip on `/u` and permanently inflate "N following".
- **`GET /` only** — and only on the default `hot` sort. A logged-in `hot` feed runs a `mine`/`cand`/`pick` CTE chain:
  `cand` takes `PREF_WINDOW` (300) rows on `score desc, cid desc` (an Incremental Sort on `com_score_idx`, so the index
  still drives it), `pick` re-sorts that window by score + pref boost, and `aggCols` is applied **above** the window —
  selecting it inside `pick` would run its three correlated subqueries for every candidate instead of the 25 returned.
  `&&`/`= any` against a null array is null, so a viewer with no prefs scores exactly as the global ranking does.
  `feedWhere` is the single definition of what the feed selects, shared by both branches.
- **The window must NOT depend on the page**, and `PREF_WINDOW` must stay a multiple of 25. Paging is a slice of one
  ordered list; with a `p * 25 + 300` window (the first cut of this) a row entering at page `p` sorted to the top of
  that page's window — into a slot page `p-1` already emitted — so it appeared on **no** page and the row it displaced
  appeared on two. Past the window the feed falls back to the plain global branch, which is exactly where the
  personalized list's tail lives; the two meet on a page boundary. `cid desc` breaks score ties for the same reason.
- **`s` is normalized once** (`new`/`top`/else `hot`) because `orderBy` treats any unknown sort as hot — reading
  `q.sort` raw in the branch condition let `?sort=HOT` order one way and take the other branch.
- Explicit 70% cuts: `/c` search is **not** personalized (you already expressed intent there — re-ranking fights you),
  and `sort=new`/`sort=top` are not either (chronological and most-voted mean what they say). Weights are constants;
  `todo.md`'s personalization slider is the follow-up.
- Surfaces: `LabelVote` (same markup/classes as `Reactions`) on the `/c?tag=`, `/c?usr=` and `/c?www=` `InfoBlock`s and
  on `/u/:name`; `/u` gains **people** (mutuals) and **interests** (your prefs, with toggle-off chips). `/c?www=` had no
  header before — adding one required `onlyFilter` to move `www` from "nothing else is set" into the single-label count.

## Tag Discovery

Two surfaces, both rendered as `.tag-preset` chips (`public/style.css`):

- **Frontpage presets** (`GET /`, logged-in only, inside the compose form): `top_mine` — your writable `*orgs`, your own
  labels, and tags you've upvoted — capped at **12** so the `disco` slice always keeps its **8** reserved slots. `disco`
  is a _weighted random sample_ of `stat_tag` (`posts_count >= 3`) via the exponential-race trick
  `order by -ln(greatest(random(), 1e-9)) / greatest(ups_received / ln(posts_count + 2), 0.05)`, so the row is fresh on
  every load and better tags surface more often. Do **not** reintroduce
  `select distinct on (tag) … order by tag …
  limit N` — DISTINCT ON forces `tag` leftmost, which silently keeps the
  alphabetically-first N and throws the ranking away (that was the bug).
- **Profile top tags** (`User` component, both `GET /u/:name` and `GET /u`): `topTags(name)`, ranked by upvotes received
  with post count as tiebreak, chips link to the global `/c?tag=<tag>` feed.

**Both are world- or org-stranger-readable, so neither may use `visibleTo`** — they hard-filter to public root posts
(`orgs = '{}' and usrs = '{}'`). `stat_tag` (`db.sql`) carries that same filter for the same reason: before, a tag used
only inside a `*org` post could surface as a public frontpage chip. Side effect: `refresh_score`'s `tag_ups`/`tag_downs`
signal no longer counts private posts.

## Body Formatting

Post/comment bodies are rendered by `formatBody()` as lightweight markdown that **keeps the original symbols visible**
(e.g. `_foo_` renders as `<em>_foo_</em>`). Supported: `_italic_`, `**bold**`, `` `code` ``, `[text](https://...)`,
`# heading`, `> blockquote`, `- item` / `1. item` lists, fenced `` ``` `` and 4-space-indented code blocks. Only code
blocks render in monospace; prose uses the page font. `<div class="body">` wraps output; styles live in
`public/style.css` (`.body`, `.body pre`, `.body blockquote`, `.body-list`).

Bare or markdown-linked `.mp4`/`.webm` URLs render as muted looping autoplay `<video class="pre-img">` above the visible
link (no transcoding — Deno Deploy has no ffmpeg). The same extensions are accepted by `POST /i`
(`IMG_EXT_RE`/`MIME_BY_EXT`) and served from `i.ding.bar`; `resolveThumbnail` short-circuits video URLs to the favicon
fallback so it never streams video bytes as text.

Post-detail view (`/c/:cid`) fetches two levels of comments so replies-to-replies render without click-through. Feed
view (`/`) stays one level deep.

## Account hub (/u)

`GET /u` is the owner's hub: identity (`User` component), bio edit, **people** (mutual follows), **interests** (your
label prefs, each chip a toggle-off `POST /p`), orgs (from `orgs_r`, "(read-only)" when not in `orgs_w`), invites
(`POST /invite`, "N of 4 used", pending list), and account actions — logout, custodial `/key` download, and a
`<details class="danger">` confirm around the irreversible `POST /key/delete`. All three POST targets already redirect
back to `/u`, so the hub needed no handler changes. `/u/:name` stays lean and shares the `User` component (owners get a
pointer line back to `/u`). `/n` stays a separate page on purpose — no notif preview on `/u`.

## Embeddable comments (/embed)

`GET /embed?url=<page>` is a read-only iframe widget for static sites
(`<iframe src="https://ding.bar/embed?url=PAGE_URL">`). It returns `c.html` directly (no `c.render`, so no site layout),
never reads the viewer's cookie, and hard-filters to public root posts (`orgs = '{}' and usrs = '{}'`) matched by a
`domains` GIN prefilter plus `strpos` exact-URL match (not `ilike` — URLs contain `%`/`_`). Headers:
`Content-Security-Policy: frame-ancestors *` and `X-Robots-Tag: noindex`. `EmbedComment` is the slim renderer (absolute
ding.bar links, no forms). Empty state links `/?www=<domain>` (prefills the compose labels); a bad `?url=` returns 400
with the copyable snippet.

## Content Negotiation

Routes return different formats based on subdomain or Accept header:

- `api.ding.bar` or `Accept: application/json` → JSON
- `rss.ding.bar` or `Accept: application/xml` → RSS/XML
- Default → HTML

## Authentication

- Signed cookies for browser sessions
- Basic Auth for API access (used by bots)
- `authed` middleware protects private routes
- `some()` combinator allows either auth method

## Signup anti-spam

The signup door layers cheap, dependency-free defenses (no CAPTCHA) in `POST /signup`, checked in order (cheapest/silent
first):

- **Honeypot** — a hidden `url` input (`.hp` in `style.css`, off-screen); if a POST fills it, the handler pretends
  success (`redirect /signup?ok`) but creates/sends nothing, so bots can't learn it.
- **Per-IP throttle** — `signupRate` (in-memory sliding window, `perHour`/`windowMs` tunable on the object like
  `dbIngestRate`), keyed by `clientIp(c)` (`cf-connecting-ip` → first `x-forwarded-for` hop → `"unknown"`).
  `signupThrottle(c)` → 429. Also guards `/signup/resend` and `/forgot` (mailbomb vectors sharing `sendVerify`).
- **`badSignupEmail(email)`** — rejects known throwaway domains (`disposableDomains`, loaded from the vendored
  `disposable-domains.txt`) and domains with no MX/A record (`hasMailExchange` via `Deno.resolveDns`; **fails open** on
  non-`NotFound` resolver errors so a flaky DNS never blocks real signups). Rejection →
  `redirect /signup?error=bad_email`.

Note: posting already effectively requires a verified email (you can't authenticate until the emailed token sets a
password), so these gates are the primary account-abuse defense. `GET /us` lists **verified** accounts only, and a daily
`Deno.cron` (`ding-prune-unverified`, Deploy-only) deletes stale unverified self-signups (`invited_by = name`, >7 days).
Tests stub `Deno.resolveDns` (`fakeResolveDns`) and raise `signupRate.perHour` so the suite stays hermetic.

## Key Patterns

SQL queries use postgres.js tagged templates:

```tsx
const users = await sql`SELECT * FROM usr WHERE uid = ${id}`;
```

JSX components are pure functions:

```tsx
const Post = ({ post }: { post: Com }) => <article>...</article>;
```

## Testing

Tests use **`jsr:@surprisetalk/pgtemp`** — ephemeral in-memory Postgres (PGlite + pg-gateway behind a real wire
listener), so no external PostgreSQL is needed. `pgtest(f)` in `server.test.ts` wraps each `Deno.test`: it boots one
instance, swaps it into the server with `setSql`, resets the rate limiters, and stubs `Deno.resolveDns`. `await using`
means a throwing test still tears the backend down (the old hand-rolled harness leaked one per failure).

Schema + seed run **once** at module load into a `snapshot` blob; every test boots from that tarball instead of
replaying the DDL (~3x faster). Add new fixtures to `setup`/`seedSql`, not to individual tests, so they land in the
snapshot. `pgcrypto` doesn't exist in PGlite: `gen_salt`/`crypt` are mocked in `setup` and the schema's
`create extension pgcrypto` is stripped, so seeded passwords are the literal string `hashed:<password>`.

`pgtemp`'s bundled client comes from `npm:postgres` while the server imports `deno.land/x/postgresjs` — same library,
different module identity, hence the one `as unknown as pg.Sql` cast in `pgtest`.
