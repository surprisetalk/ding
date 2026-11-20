- [ ] You scroll a feed of cards in masonry columns: each post fills its card with an image (og:image, a screenshot of
      the link, or an uploaded image), the title, and an article excerpt. Decision: the grid wins over the "craigslist
      density" direction, so text-only posts get a quiet default card instead of a dense row. Decision: masonry columns,
      not a square grid; you liked the look of the mockup (https://claude.ai/artifact/8XJP56od9ihKA51B8sWorj). Decision:
      bucket "grow after the main quest" (~/Documents/tasks/todo.md, projects entry, 27 Oct).
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
  1. Measured 11-20. Top 10 overall: bot, smallweb, blog, video, youtube, hn, reddit, hmmm, tildes, welcome. Top 10 by
     humans: design, lol, art, architecture, wtf, web, furniture, humor, math, wood. They differ, so steps 2–4 stand.
  2. `stat_tag` gains `human_posts` (public roots by non-`bot_` authors). The tagger takes candidates with
     `human_posts >= 2`, ordered by `human_posts`. Run `migrate.sql` before the deploy, and terminate the pooled
     backends after: a matview rebuild changes the result type.
  3. Add two candidate sources: the viewer's own posted tags (the `own` CTE of the presets query) and the tags humans
     put on public roots with the same `~domain` as the link. Keep the ▼ exclusion last.
  4. Test, in "share via ?submit=": a tag only `bot_` posts use is absent from `tagger.prompt`; a tag a human put on a
     same-domain post is present.

- [ ] `deno test -A` finishes in under 10 s, so the pre-commit hook stays cheap.
  1. Measured 11-20: 34.8 s wall. Slowest: routes 2.7, status 2.5, share via ?submit= 2.3, server.tsx boot 2.2, tag
     discovery 1.8. Needs `LD_LIBRARY_PATH` for sharp, as the hook sets.
  2. Cut the cost where it lives (PGlite boot, child-process boots, real timers), then record the floor and its
     bottleneck in claude.md.

- [ ] `blogs` finishes a run every hour. On pc its run fails with
      `paginate: hit maxPages=50 for /c?usr=bot_blogs&sort=new&limit=100&p=0`: `getPostedUrls` already reads only the
      30-day window, but bot_blogs posts more than 50 × 100 rows in 30 days
      (`select count(*) from com where
      created_by = 'bot_blogs' and created_at > now() - interval '30 days'`).
  1. Replace the history read in bots/blogs.ts with a lookup of the candidate URLs only (one query over `com.links` for
     this run's feed items), so the read no longer grows with post volume.
  2. Test in bots.test.ts: a bot with 6,000 prior posts finishes a run.

- [ ] `redditBot` throws when every subreddit fetch fails, so a blocked IP turns "Every bot finished a run" red, not
      green. Today bot_reddit beats each hour but has posted nothing since 11-14: 3,457 "Reddit 429" lines on 11-20.
  1. In `redditBot` (bots.ts), count failed `fetchSub` calls. When all fail, throw with the count and the last status.
  2. Test in bots.test.ts: a stub that answers 429 for every sub makes the run throw.

- [ ] You drop a room link into a post and talk to whoever is in it, and busy rooms climb the feed. Decision: real
      WebRTC, spartan — audio only, mesh, no SFU, no recording, no TURN. ~10% of peers behind symmetric NAT will fail to
      connect; they see "couldn't connect", never a silent mute.
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
  8. Add `800.ding.bar` to the cloudflared ingress in `/etc/nixos` on pc, next to `i`/`db`/`api`/`rss`.

## Blocked on you

- [ ] `reddit` posts every hour again. Reddit answers 429 to pc's IP for most subreddits since the move. Blocker: you
      register a Reddit app for app-only OAuth (Reddit reviews new API apps) and put its id and secret in
      `/var/lib/ding/env`.
  1. Register the app at https://www.reddit.com/prefs/apps. Set `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`.
  2. `redditFetch` gets a bearer token from `/api/v1/access_token` (`grant_type=client_credentials`), caches it until
     expiry, and reads `https://oauth.reddit.com/r/<sub>/new.json`.
  3. Put `reddit` and `hmmm` back in the bot-run status condition.
  4. Asked 2026-11-20.

- [ ] @lectures.bsky.social posts one talk a day from a catalog Taylor curates. Blocker: you set fave, create the
      account, and deploy.
  1. Open `bots/data/lectures.tsv`. Set `fave` to 1 on favorites and fill `tags`. Add rows from HN "favorite talks"
     threads until it holds 100.
  2. Create the `bot_lectures` account like `bot_album`. Put `BOT_LECTURES_EMAIL` and `BOT_LECTURES_PASSWORD` in
     `bots.env` and in `/var/lib/ding/env` on pc (mode 0600).
  3. Push to main (pc deploys within a minute), then run `deno task status`. "bots/data/lectures.tsv holds 14 talks" and
     "Every bot finished a run" must score at least 1.
  4. Do step 7 of the move-to-pc entry in ~/Developer/repasta/todo.md: repasta copies `bot_lectures` posts to @lectures.
  5. Asked 2026-11-20.

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

- [ ] Every LLM call goes to the local llama.cpp model on pc, so the Anthropic bill no longer limits ding. Blocker: pc's
      GPU is shared with other llama servers and has too little free VRAM. The bots' 90 s `BOT_TIMEOUT_MS` and the
      in-request `?submit=` tagger need about 30 tok/s.
  1. Free the GPU first: stop or shrink another llama server, or give ding a smaller model. Then measure tok/s with one
     `curl 127.0.0.1:8080/v1/chat/completions` call; it must reach 20.
  2. `claude()` in `bots.ts` → `127.0.0.1:8080/v1/chat/completions` with
     `chat_template_kwargs:
     {enable_thinking: false}`. Drop `ANTHROPIC_API_KEY` from `/var/lib/ding/env` and the
     startup warning. The tagger's daily cap stays: it bounds GPU time instead of spend.
  3. Tests stub `fetch` on `api.anthropic.com` (bots.test.ts, server.test.ts): point them at the new URL and shape.
  4. Asked 2026-11-20. You chose to stay on Anthropic.

- [ ] Humans find ding and post each week. You dropped its status conditions on 11-20.
  1. Sign up with a fresh address on https://ding.bar/signup. Confirm that the verify email arrives. If it does not,
     check `grep -c '^RESEND_API_KEY=' /var/lib/ding/env` and `journalctl -u ding` for 'Could not send verification
     email'.
  2. Write the Slack migration guide as a post on ding, and send it to 3 people you know.
  3. After the Slack import entry ships, post the guide to 20 target communities (r/True\* subreddits, small Discords,
     academic Zulip refugees). Keep the target list in `*ding`, not in this file.
  4. The 100-posters and paid-org goals wait on the Slack import entry. Do not build marketing code for them.
  5. Asked 2026-11-20.

- [ ] You use ding from an iPhone app with real push notifications. Decision: native, not a PWA — push is the entire
      reason, and iOS web push needs the app installed anyway. Needs an Apple developer account, an APNs key, a device,
      and App Store review on every release.
  1. Backend push: `usr.apns_token`, and the notification insert path sends to APNs.
  2. `ding-ios` (new repo), SwiftUI, four screens: feed, thread, compose, notifications. Nothing else.
  3. Asked 2026-11-20.

- [ ] When the Haiku tagger fails or hits its cap, `?submit=` falls back to a SQL guess instead of an empty labels box.
      Blocker: build only after the empty box shows up as a real complaint.
  1. Candidates: `stat_tag` tags that equal a title word or a `meta[name=keywords]`/`article:tag` value, plus the top
     tags that humans (`created_by !~ '^bot_'`) put on public root posts with the same `~domain`.
  2. Minus your ▼'d tags. Order by domain count, then `posts_count`. Limit 3.
  3. Weakness: no synonyms, and a title word can match a generic tag such as `#new`.
