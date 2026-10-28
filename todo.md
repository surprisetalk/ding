- [ ] You scroll a masonry feed of cards with image, title and excerpt on ding.bar. Decision: bucket "grow after the
      main quest" in the projects strategy (~/Documents/tasks/todo.md, projects entry, 27 Oct).
  1. Do step 1 of the masonry entry: add `.feed { columns: 260px }` and `break-inside: avoid` in public/style.css.
  2. Add the mshots fallback to `resolveThumbnail` after og:image misses.
  3. Run `deno task status` and read which conditions fail on production.
- [ ] You scroll a feed of cards in masonry columns: each post fills its card with an image (og:image, a screenshot of
      the link, or an uploaded image), the title, and an article excerpt. Decision: the grid wins over the "craigslist
      density" direction, so text-only posts get a quiet default card instead of a dense row. Decision: masonry columns,
      not a square grid; you liked the look of the mockup (https://claude.ai/artifact/8XJP56od9ihKA51B8sWorj).
  1. `public/style.css`: `.feed { columns: 260px; column-gap: 16px }` and `break-inside: avoid` on each card, one column
     under 480px. A card takes its natural height: the image at its own aspect ratio, the title clamped to 2 lines and
     the excerpt to 3 with `-webkit-line-clamp`. Tradeoff: CSS columns fill top to bottom, so rank 2 sits under rank 1,
     not beside it; row-ordered CSS masonry is not in every stable browser yet.
  2. `resolveThumbnail`: after og:image/twitter:image misses, fall back to
     `https://s.wordpress.com/mshots/v1/<encoded>?w=600` before the favicon. mshots needs no key and generates
     asynchronously (the first hit returns a placeholder), so store the URL, never the bytes — `GET /img` already fronts
     it with a 7-day immutable cache.
  3. Excerpt: run `@mozilla/readability` on the `document` that `fetchPage` already returned (one fetch, not two) and
     store 200 chars in a new `com.excerpt` column. It must stay outside the transaction like the rest of `deriveBody`.
     Tradeoff: this puts Readability back on every link post, bots included; `?submit=` keeps it off the thumbnail path
     today. Bound it with `maxElemsToParse` as `?submit=` does.
  4. `Post` renders excerpt under the title. `GET /` selects the new column; `/c` shares the fragment builders, so add
     it in one place.
  5. Test: a root post whose link has no og:image and no readable article still renders a card (favicon + no excerpt) —
     a column must never collapse.
- [ ] You share a link with `?submit=` and the labels box holds the tags a human would pick for it, not the bot feeds'
      source tags. Today the 150 candidates are the top `stat_tag` rows by `posts_count`, and bots own almost every
      `com` row, so bot tags fill the list. Decision: fix the candidates before the prompt.
  1. Measure on prod, read-only: the top 30 public root tags overall vs. the top 30 where `created_by !~ '^bot_'`. Write
     both lists under this entry. If they match, delete steps 2–3 and look at the prompt instead.
  2. `stat_tag` gains `human_posts` (public roots by non-`bot_` authors). The tagger takes candidates with
     `human_posts >= 2`, ordered by `human_posts`. Run `migrate.sql` before the deploy, and terminate the pooled
     backends after: a matview rebuild changes the result type.
  3. Add two candidate sources: the viewer's own posted tags (the `own` CTE of the presets query) and the tags humans
     put on public roots with the same `~domain` as the link. Keep the ▼ exclusion last.
  4. Test, in "share via ?submit=": a tag only `bot_` posts use is absent from `tagger.prompt`; a tag a human put on a
     same-domain post is present.

## Blocked on you

- [ ] @lectures.bsky.social posts one talk a day from a catalog Taylor curates. Built and committed: `bots/lectures.ts`,
      65 seeded rows in `bots/data/lectures.tsv` (63 from the old posts, 1 from ideas.tsv "lectures" draft, none from
      the "technical lectures" rows: they hold no URLs), the runway status condition, and tests. Blocker: you set fave,
      create the account, and deploy.
  1. Open `bots/data/lectures.tsv`. Set `fave` to 1 on favorites and fill `tags`. Add rows from HN "favorite talks"
     threads until it holds 100.
  2. Create the `bot_lectures` account like `bot_album`. Put `BOT_LECTURES_EMAIL` and `BOT_LECTURES_PASSWORD` in
     `bots.env` and in production.
  3. Deploy with the entry below, then run `deno task status`. "bots/data/lectures.tsv holds 14 talks" and "Every bot
     finished a run" must score at least 1.
  4. Do step 7 of the move-to-pc entry in ~/Developer/repasta/todo.md: repasta copies `bot_lectures` posts to @lectures.

- [ ] Today's changes reach ding.bar: the bot SSRF guard, the tagger cap, `album`/`welcome` fixes, `bestof` removed, the
      labelless-post compose, the JSON write API, DM-reply visibility, body-mention notifications, and once-only
      reactions. Blocker: you commit and deploy.
  1. Review and commit the working tree.
  2. `deno task deploy`, then `deno task status`. Production already runs today's `migrate.sql`. The tagger condition
     must score at least 1. The bot condition loses `bestof` from its count, and `album` and `welcome` should beat
     within the hour.

- [ ] You are a moderator with a Slack export and you move your community to ding in an afternoon. Blocker: you said to
      hold off. Decision: one-shot import only. A live two-way bridge means tokens, rate limits, and dedup loops
      forever.
  1. `import.ts` + `deno task import <export.zip> *org`: channels → `#tag`, `thread_ts` → `parent_cid`, users →
     unverified `usr` rows `invited_by` the importer, source timestamps → `created_at`.
  2. Idempotent and resumable like `backfill.ts`. Add `com.src text unique` holding `slack:<team>:<ts>` and skip on
     conflict. Do not reuse `com.hash`: it must keep meaning "dht content hash" or the dht projection invariant rots.
  3. Decision: every message, public or private channel, imports as `#<channel> *org`, so the whole import is private to
     the org and a private channel can never leak. Members repost to open something up.
  4. Users: `users.json` → unverified `usr` rows `invited_by` the importer, with no org membership (each member is a
     billed Stripe seat; the moderator invites people as they arrive). Decision: a user with no `profile.email` refuses
     the whole import (exit 1, listing those users), so you get a fuller export. A name taken by a different email
     becomes `<name>_slack`.
  5. Bound it: refuse an export over 200k messages up front, with the count in the message. Half an import is worse than
     none.
  6. Zip: `npm:fflate`. Test: a fixture export with one public channel, one private channel, and one thread imports
     twice into the same rows.

- [ ] You drop a room link into a post and talk to whoever is in it, and busy rooms climb the feed. Blocker: after the
      pc move, because the subdomain and the NOTIFY signaling change there. Decision: real WebRTC, spartan — audio only,
      mesh, no SFU, no recording, no TURN. ~10% of peers behind symmetric NAT will fail to connect; they see "couldn't
      connect", never a silent mute.
  1. `800.ding.bar/<id>`: a new `host(c) === "800"` branch, same subdomain routing as `i`/`db`/`api`/`rss`. Page is join
     / leave / mute and a participant list. No accounts — the id is the capability.
  2. Signaling reuses the live-tail plumbing: `pg_notify` on a `room` channel with ONE shared per-isolate `sql.listen`,
     fanned out in memory to that room's sockets. Cross-isolate is exactly why NOTIFY is there.
  3. `create table room_peer (rid text, peer text, at timestamptz not null, primary key (rid, peer))`. Client heartbeats
     every 15s; live = `at > now() - interval '45 seconds'`.
  4. Bound the mesh at `ROOM_MAX = 8` — connections grow n². The 9th join gets a 409 that says the room is full and how
     many are in it.
  5. Compose: a `room` button beside draw/attach in `ComposeTools` mints an 8-char id and inserts the URL into the
     textarea, exactly like the image upload flow. `formatBody` renders an 800.ding.bar URL as a room card with the live
     count.
  6. Ranking: `deriveBody` extracts room ids into a new `com.rooms text[]` (GIN indexed), and `refresh_score` gains
     `+ interval '6 hours' * ln(live_peers + 1)` from a `room_agg` CTE joining `room_peer`. Boost by live participants,
     not by pinning — an empty room must fall.
  7. A `ding-rooms` cron every minute deletes stale `room_peer` rows and re-scores the posts that hold live rooms.
     Without it an emptied room keeps its boost forever, which is the whole failure mode of this feature.

- [ ] You hit `remix` on any image, audio, or video and reply with a mangled copy of it — dithered, pixelsorted,
      lowpoly, glitched, chipmunked, reversed, deepfried. The transforms already exist as bots; today they only fire
      from an `@dither` mention and take up to 5 minutes. This makes them a button. Blocker: the voice-memo entry comes
      first, and you parked it.
  1. Re-export the transform functions that already ship: `toBraille` (`bots/dither.ts`), `pixelsort`, `lowpoly`, and
     `glitchSvg`/`dupeLayers`/`noiseRects` (`bots.ts`). `bots/mod.ts` is statically imported by the server, so sharp is
     already bundled on Deploy — this adds no dependency and no new image code.
  2. `POST /r` takes `{url, tool}`, dispatches through a flat `REMIX` record of `{name → fn}`, uploads the result to R2
     with a fresh 8-char id on the existing `POST /i` path, and returns the new URL for the compose box.
  3. Call `directImageUrl(url)` FIRST. `i.ding.bar` is the same Deploy project, so an in-isolate fetch of a ding-hosted
     image must be rewritten. The test for this entry is a remix of an `i.ding.bar` URL, not an external one.
  4. Audio and video remixes run in the browser, not on the server: Deno Deploy has no ffmpeg. `WebAudio` for speed /
     pitch / reverse, a canvas filter for video, `MediaRecorder` to re-encode — the voice-memo plumbing.
  5. UI: a `remix` button in `ComposeTools` and on every post that holds media, opening a strip of tool chips. The
     result posts as a reply, so `parent_cid` already records what was remixed from what. Do not add a `remix_of` column
     — the thread IS the lineage.
  6. Bound every tool: 5 MB input, `fitSharp`'s max dimension, 15s. A transform that throws returns 400 naming the tool
     and the input size, never a bare 500.
  7. Keep the tools quirky and few. A remix strip of 8 named things people repeat is worth more than 30 sliders, and
     every tool is a permanent maintenance surface.

- [ ] You record a voice memo or a video clip from compose, like attaching an image. The design is approved. Blocker:
      you said to revisit it later.
  1. `ComposeTools` gains `rec audio` and `rec video`, hidden when `MediaRecorder` or `getUserMedia` is missing. A click
     asks for the mic (and camera); a denial alerts "microphone blocked: allow it in this site's settings".
  2. While it records, the button reads "stop 0:12". At 60 s it stops itself and says "stopped at the 60 s limit".
  3. The mime type is the first that `MediaRecorder.isTypeSupported` accepts: `audio/webm` → `.weba`, `audio/mp4` →
     `.m4a` (iOS Safari), `video/webm` → `.webm`, `video/mp4` → `.mp4`. The blob becomes `new File([blob], "rec.<ext>")`
     and goes through the existing `upload(ta, [file])` path.
  4. `IMG_EXT_RE` and `MIME_BY_EXT` gain `m4a` (`audio/mp4`) and `weba` (`audio/webm`). `formatBody` renders those as
     `<audio controls>`, and `.mp4`/`.webm` video gains `controls`, so a recorded clip (muted autoplay loop) can be
     unmuted.
  5. Tests: `POST /i` stores a `.m4a` and a `.weba` with their types; `formatBody` renders `<audio controls>`. Check the
     buttons in a browser, because `client.js` has no test harness.

- [ ] ding runs on `pc` against its local Postgres, and every LLM call goes to the local llama.cpp model, so neither
      Neon's 0.5 GB cap nor the Anthropic bill limits it. Serves "Postgres uses under 80% of Neon's 0.5 GB free-tier
      storage." (0.7). The shape below is approved. Blockers, all yours: (a) the Deno Deploy env holds secrets this
      laptop lacks (only `DATABASE_URL` and `KEY_WRAP_SECRET` are in `.env`): put the full set in `/var/lib/ding/env` on
      pc, mode 0600, owner `taylor`; (b) `llama-cpp.service` on pc is failed since 2026-10-16 15:54 UTC:
      `--device Vulkan0` finds no Vulkan device, so llama-server exits 1 (start-limit-hit after 10 restarts). The RX
      5700 XT is not visible to Mesa RADV; vixing's cluster names stop too; (c) the cutover window, because DNS moves.
      Decision: no bot prune. Bots own 148k of the 149k `com` rows and 144,682 of the 145,314 `dht` msg rows (581 MB in
      all, growing about 30k rows a month). Local disk holds them.
  1. `/etc/nixos/flake.nix`: `systemd.services.ding` runs `deno serve -A --host=127.0.0.1 --port=8046 server.tsx` in
     `/home/taylor/ding` (a git clone), `EnvironmentFile=/var/lib/ding/env`, and `DENO_DEPLOYMENT_ID=<git rev>`, so the
     crons and `?v=` asset caching stay on with no code change. Restart on failure, 5 s.
  2. Postgres on its socket: `createdb ding`, then `pg_dump` Neon → `pg_restore`. Nightly `pg_dump` to R2, because
     Neon's point-in-time restore goes away. Drop `prepare: false` only after the cutover: it is the Neon pooler
     workaround.
  3. Run it beside Deno Deploy on 127.0.0.1:8046 against the restored copy, with no public ingress, and run
     `deno task status` against it.
  4. At the cutover, in one change: `claude()` in `bots.ts` → `127.0.0.1:8080/v1/chat/completions` with
     `chat_template_kwargs: {enable_thinking: false}` (gemma-4-12b, ctx 4096, ~31 tok/s, one slot shared with vixing);
     `deno task deploy` = `ssh pc 'cd ~/ding && git pull && sudo systemctl restart ding'`; disk, RAM, and CPU status
     conditions replace the Neon cap. The tagger's daily cap stays: it bounds CPU instead of spend.
  5. Cutover: freeze writes, final dump/restore, cloudflared ingress for `ding.bar` and `api`/`rss`/`db`/`i.ding.bar` →
     `http://127.0.0.1:8046`, flip DNS, then `deno task status` against production must pass and snitch must log it.

- [ ] `grouch`, `hypebot`, and `replyguy` finish a run every hour. Blocker: only the Deno Deploy logs and env show why.
  1. They have 0 posts ever, and `critic` runs the same `verdictBot` harness and beats. So the likely cause is that
     their `BOT_<NAME>_EMAIL`/`_PASSWORD` never reached the Deploy env.
  2. In the Deno Deploy logs, search the last tick for `bot grouch`. `no BOT_GROUCH_EMAIL/_PASSWORD` means the env is
     missing: upload `bots.env` to the Deploy project env. `bot grouch failed:` means a code error: paste the line here.

- [ ] Humans find ding and post each week. Serves "Somebody verified their email this week." (0), "3 humans besides
      taylor posted this week." (0.33), "100 humans posted in the past 24h." (0.01), and "Somebody paid for an org this
      month." (0).
  1. Sign up with a fresh address on https://ding.bar/signup. Confirm that the verify email arrives. If it does not,
     check `grep -c '^RESEND_API_KEY=' .env` and the Deno Deploy logs for 'Could not send verification email'.
  2. Write the Slack migration guide as a post on ding, and send it to 3 people you know.
  3. After the Slack import entry ships, post the guide to 20 target communities (r/True\* subreddits, small Discords,
     academic Zulip refugees). Keep the target list in `*ding`, not in this file.
  4. Run `deno task status` after each signup. The first three conditions must rise above 0.
  5. The 100-posters and paid-org goals wait on the Slack import entry. Do not build marketing code for them.

- [ ] You get an email from Neon and Deno Deploy before ding hits a usage limit or its error rate spikes. These cover
      the conditions `/status` cannot see: error rate across isolates, CPU, memory, bandwidth, and spend.
  1. Neon console: storage, compute-hours, and spend alerts to surprisetalk@gmail.com.
  2. Deno Deploy console: request, CPU, bandwidth, and error-rate alerts to the same address.
  3. Then note in `claude.md` that these alerts live outside this repo.

- [ ] You use ding from an iPhone app with real push notifications. Decision: native, not a PWA — push is the entire
      reason, and iOS web push needs the app installed anyway. Needs an Apple developer account, an APNs key, a device,
      and App Store review on every release. Do it after the JSON API entry.
  1. Backend push: `usr.apns_token`, and the notification insert path sends to APNs.
  2. `ding-ios` (new repo), SwiftUI, four screens: feed, thread, compose, notifications. Nothing else.

- [ ] When the Haiku tagger fails or hits its cap, `?submit=` falls back to a SQL guess instead of an empty labels box.
      Blocker: build only after the empty box shows up as a real complaint.
  1. Candidates: `stat_tag` tags that equal a title word or a `meta[name=keywords]`/`article:tag` value, plus the top
     tags that humans (`created_by !~ '^bot_'`) put on public root posts with the same `~domain`.
  2. Minus your ▼'d tags. Order by domain count, then `posts_count`. Limit 3.
  3. Weakness: no synonyms, and a title word can match a generic tag such as `#new`.
