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

# Run a specific bot manually
deno run -A bots/hn.ts

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

**Single-file server** (`server.tsx`, ~3,200 lines) using:

- **Hono** - HTTP framework with middleware chain
- **postgres.js** - SQL via template literals (`sql\`SELECT ...\``)
- **JSX** - Server-side rendered components (no frontend framework)
- **Resend** - Email delivery

Server is organized with `//// SECTION ////` headers: IMPORTS, TYPES, CONSTANTS & HELPERS, LABEL PARSING, EMAIL TOKEN,
POSTGRES, DHT, RESEND, STRIPE, COMPONENTS, HONO. The `GET /` and `GET /c` feed queries share fragment builders
(`visibleTo` ACL, `aggCols`/`aggPairs` per-row aggregates, `orderBy`) so the two feeds can't drift; `wireRow` is the
single definition of the NDJSON wire format (WS live-tail + HTTP drain must stay byte-identical).

**Database** (`db.sql`):

- `usr` - Users with bcrypt passwords, email verification, org memberships (`orgs_r`/`orgs_w` arrays). `pubkey` +
  `seckey_enc` hold the user's Ed25519 identity (custodial key = AES-256-GCM(JWK, `KEY_WRAP_SECRET`); null =
  self-custody)
- `com` - Comments with threading (parent_cid), tags/orgs/usrs arrays, full-text search. `hash`/`author_id`/`sig`/
  `parent_hash`/`t` carry the signed DHT identity; `created_by` is null for foreign authors (rendered by short hash)
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

- Content aggregators (HN, Lobsters, arXiv, etc.) that POST via Basic Auth
- LLM persona bots (kenm, linkedin, bigfoot, caveman, critic) use `claude()` helper in `bots.ts` with Haiku 3; require
  `ANTHROPIC_API_KEY`
- Run every 5 minutes via GitHub Actions (`.github/workflows/bots.yml`); each bot is a standalone entrypoint keyed by
  `BOT_<UPPERNAME>_EMAIL`/`_PASSWORD` env vars (missing env → log + exit 1)
- Most bots are thin configs over shared harnesses in `bots.ts`: `rssBot` (single RSS feed), `personaBot` (LLM replies),
  `tagResponderBot` (reply to fresh `#tag` posts), `imageMentionBot` (transform an image from a @mention),
  `dailyPostBot` (one gated post per run). Shared helpers: `sweepFeeds` (bounded-concurrency newest-per-feed),
  `redditFetch`/`parseRedditEntries`, `glitchSvg`/`glitchTwemojiToR2`, `fetchFreshPosts`, `atomTitleLink`,
  `parseTitleLinkComments`
- `bots/checkmark.ts` is NOT part of the fleet (no `bots.ts` import; consumed by `server.tsx` as `runCheckmark`)

## Label System

Search and tagging use a unified label syntax:

- `#tag` - public labels (stored in `tags` array, GIN indexed)
- `*org` - org/private labels (access controlled via user's `orgs_r`/`orgs_w`)
- `@user` - user mentions (stored in `usrs` array)
- `~domain` - synthetic label auto-extracted from every URL host in the body (stored in `domains` array, GIN indexed)

Exported functions: `parseLabels()`, `encodeLabels()`, `decodeLabels()`, `formatLabels()`

## Body Formatting

Post/comment bodies are rendered by `formatBody()` as lightweight markdown that **keeps the original symbols visible**
(e.g. `_foo_` renders as `<em>_foo_</em>`). Supported: `_italic_`, `**bold**`, `` `code` ``, `[text](https://...)`,
`# heading`, `> blockquote`, `- item` / `1. item` lists, fenced `` ``` `` and 4-space-indented code blocks. Only code
blocks render in monospace; prose uses the page font. `<div class="body">` wraps output; styles live in
`public/style.css` (`.body`, `.body pre`, `.body blockquote`, `.body-list`).

Post-detail view (`/c/:cid`) fetches two levels of comments so replies-to-replies render without click-through. Feed
view (`/`) stays one level deep.

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

Tests use PGlite (in-memory PostgreSQL) with mocked pgcrypto functions. The test file seeds its own database and doesn't
require external PostgreSQL.
