- [ ] The `?submit=` tagger stops at a daily cap, so a share loop cannot run up the Anthropic bill.
  1. Count tagger calls per UTC day in Postgres: one upsert per call, before the call.
  2. Past the cap, skip the call and log `share <url>: tags not suggested: daily cap of <N> Haiku calls reached`.
  3. A status condition grades the day's count against the cap, so the 4:30 report shows the spend.
  4. Test: with the cap at 1, the second share makes no API call and its labels box stays empty.

- [ ] (maybe) When the Haiku tagger fails or hits its cap, `?submit=` falls back to a SQL guess instead of an empty
      labels box. Build only after the empty box shows up as a real complaint.
  1. Candidates: `stat_tag` tags that equal a title word or a `meta[name=keywords]`/`article:tag` value, plus the top
     tags that humans (`created_by !~ '^bot_'`) put on public root posts with the same `~domain`.
  2. Minus your ▼'d tags. Order by domain count, then `posts_count`. Limit 3.
  3. Weakness: no synonyms, and a title word can match a generic tag such as `#new`.

- [ ] You paste a link into compose and get tag chips to click, instead of typing labels from memory.
  1. `GET /t?url=` returns up to 3 tags from the `?submit=` tagger in `GET /` (Haiku over `stat_tag` + your ▲ − your ▼).
     Move the tagger out of the `sharing` promise into a function, now that it has a second call site.
  2. Cache by URL in an isolate-local Map with a bound (200 entries, drop oldest) — a suggestion endpoint must never
     become a per-keystroke fetch of a foreign site.
  3. `public/client.js`: on paste or blur of the textarea, if it holds a URL, fetch and render the chips into the
     existing `.tag-presets` container; a click appends `#tag` to the labels input.
  4. A failed or empty suggestion renders nothing. This is the one place silence is correct — a suggestion that could
     not be computed is a decline, not an error.

- [ ] You scroll a feed of square cards: each post fills its tile with an image (og:image, a screenshot of the link, or
      an uploaded image), the title, and an article excerpt. Decision: the grid wins over the "craigslist density"
      direction, so text-only posts get a quiet default tile instead of a dense row.
  1. `public/style.css`: `.feed { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)) }`,
     `.thumb { aspect-ratio: 1 }`, one column under 480px. Cells must not depend on body length — clamp the title to 2
     lines and the excerpt to 3 with `-webkit-line-clamp`.
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
  5. Test: a root post whose link has no og:image and no readable article still renders a tile (favicon + no excerpt) —
     the grid must never collapse.

- [ ] You cannot make a bot fetch a private address by posting its URL. `fetchPage` and `GET /img` already refuse them
      through `fetchPublic`; the bots still call bare `fetch` on user-posted URLs.
  1. Move `fetchPublic` and `fetchGuard` from `server.tsx` to `bots.ts` (the server imports `bots.ts`; the reverse
     import would be a cycle), and export them.
  2. Use it in `imageMentionBot` (`fetch(src)`, which also has no timeout: give it 15s) and in `extractArticle` (no
     timeout either: 10s). Both fetch URLs that users posted.
  3. Test: an `@dither` mention of `http://169.254.169.254/x.png` posts no reply and logs "not a public address".

- [ ] You post, vote, and read your notifications from a script, in JSON, over `api.ding.bar` with Basic Auth.
      `readme.md` still says `http POST ding.bar ... # TODO`.
  1. `POST /c`, `POST /p`, and `GET /n` answer JSON on `api.ding.bar` or `Accept: application/json`, the same content
     negotiation `GET /c` already uses. Return the created row or the new pref state, not a redirect.
  2. Replace the readme `# TODO` with one working `http` example per route.
  3. Test: each route answers JSON with Basic Auth and rejects bad credentials with 401.

- [ ] You record a voice memo or a video clip from compose, like attaching an image.
  1. `MediaRecorder` in `client.js` → blob → the existing `POST /i` path.
  2. Button in `ComposeTools`; a stop button; hard 60s cap (the recorder stops itself, and the cap is in the message
     when it fires).
  3. Pick the extension from the recorder's actual `mimeType` — iOS Safari records `audio/mp4`, not webm. Hardcoding
     webm ships a feature that works only on your laptop.
  4. Audio needs its own extensions (`m4a` for `audio/mp4`, `weba` for `audio/webm`) in `IMG_EXT_RE`/`MIME_BY_EXT`, and
     `formatBody` renders them as `<audio controls>`. Today mp4/webm render as MUTED looping video, so a voice memo
     there plays silence.

- [ ] You hit `remix` on any image, audio, or video and reply with a mangled copy of it — dithered, pixelsorted,
      lowpoly, glitched, chipmunked, reversed, deepfried. The transforms already exist as bots; today they only fire
      from an `@dither` mention and take up to 5 minutes. This makes them a button. Build the voice-memo entry first.
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

- [ ] You are a moderator with a Slack export and you move your community to ding in an afternoon. Decision: one-shot
      import only. A live two-way bridge means tokens, rate limits, and dedup loops forever.
  1. `import.ts` + `deno task import <export.zip> *org`: channels → `#tag`, `thread_ts` → `parent_cid`, users →
     unverified `usr` rows `invited_by` the importer, source timestamps → `created_at`.
  2. Idempotent and resumable like `backfill.ts`. Add `com.src text unique` holding `slack:<team>:<ts>` and skip on
     conflict. Do not reuse `com.hash`: it must keep meaning "dht content hash" or the dht projection invariant rots.
  3. Private channels import as `*org`, never as public roots. An import that leaks a private channel is worse than no
     import.
  4. Bound it: refuse an export over 200k messages up front, with the count in the message. Half an import is worse than
     none.
  5. Test: a fixture export with one public channel, one private channel, and one thread imports twice into the same
     rows.

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

## Blocked on you

- [ ] You see all bots finish a run every hour, so the status condition "Every bot in bots/mod.ts finished a run in the
      past hour." scores 1.0 (now 0.86 = 39 of 45).
  1. Cause (partly known): six bots have no `beat` row in production, ever: `album`, `bestof`, `grouch`, `hypebot`,
     `replyguy`, `welcome`. `runBotFleet` writes `beat('bot:<name>')` only after the bot returns without error. So each
     of the six is skipped or throws on every tick. The other 39 beat within the hour. The Deno Deploy logs are the
     missing evidence.
  2. Already ruled out: all six have `BOT_<NAME>_EMAIL` and `_PASSWORD` in local `bots.env`; each pair matches its `usr`
     row (`password = crypt(...)`); all six `bot_*` users exist. `critic` also uses `verdictBot` and beats, so a missing
     Anthropic key does not explain it. `bot_grouch`, `bot_hypebot` and `bot_replyguy` have 0 posts ever; `bot_album`
     last posted 2026-09-14; `bot_bestof` 2026-07-27; `bot_welcome` 2026-08-09 (it posts only for a fresh signup, but it
     still beats on a no-op run).
  3. In Deno Deploy logs, search the last tick for `bot album`, `bot welcome`, and so on. A line that starts with
     `no BOT_<NAME>_EMAIL/_PASSWORD` means the env is missing: upload `bots.env` to the Deploy project env. A line that
     starts with `bot <name> failed:` means a code error: fix the bot and add a regression test in `bots.test.ts`.
  4. Fix the status message too: `checks` should name the stale bots (`select name from beat ...`), because "a bot
     threw" gives no name today.

- [ ] You read ding's graded production status in snitch's 4:30 report. The code is in, and production has run
      `migrate.sql`; the deploy is left.
  1. `deno task deploy`.
  2. `deno task status` prints a JSON report (exit 1 is expected while goals fail). The "DNS lookups answer" condition
     must score at least 1: below that, `Deno.resolveDns` fails on Deploy and every link preview and `/img` request is
     refused.
  3. `ssh pc "psql snitch -c \"select * from latest where project = 'ding'\""` shows a row.

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

- [ ] You take the Slack migration guide to 20 target communities (r/True\* subreddits, small Discords, academic Zulip
      refugees). Waits on the Slack import entry. Keep the target list in `*ding`, not in this file.
  1. Write the migration guide as a post on ding.
  2. Post it where each community gathers.
