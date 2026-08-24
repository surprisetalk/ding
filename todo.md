- [ ] You run `deno task status` (or `GET /status`) and see every likely failure mode graded, where 1.0 is the minimum
      pass and 0.0 is total failure. Today ding has no status check at all: a dead bot fleet, a stalled `Deno.cron`, and
      zero humans posting all look identical to a healthy server.
  1. `create table beat (name text primary key, at timestamptz not null)`. Every `Deno.cron` upserts its name on each
     tick. This is the only way to see a cron that silently stopped firing.
  2. `create table status_run (at timestamptz not null default now(), cond text not null, grade real not null)`, index
     `(cond, at desc)`. Add both to `db.sql` AND `migrate.sql` (the schema is duplicated on purpose).
  3. `checks` in `server.tsx`: one SQL per condition, `grade = actual / threshold`, never clamped (45.3 means 45x the
     bar). Conditions, each a sentence:
     - "5 humans posted in the past 24h." (`created_by not like 'bot_%'`)
     - "3 humans besides taylor posted this week."
     - "Somebody verified their email this week."
     - "Somebody paid for an org this month."
     - "Every bot in `bots/mod.ts` posted in the past 24h." (grade = bots that posted / bots registered)
     - "Every cron ran inside its own period." (from `beat`; bots 5m, stats 10m, checkmark 1h, prune 24h)
     - "The frontpage query finishes in 300ms." (time the anonymous `GET /` query)
     - "The dht ingested a row in the past 24h."
     - "Postgres is under 80% of the Neon free-tier storage."
  4. `GET /status` returns `{ "<cond>": { "0": <now>, "3600": <1h ago>, "86400": <24h ago> } }`, reading older offsets
     from `status_run`. A `ding-status` cron every 5 min writes the new row.
  5. `deno task status` is the same code against `DATABASE_URL`, exiting nonzero when any grade < 1.0.
  6. Move the old backlog goals here, not into feature entries: "attract 100 daily active users" is the DAU condition
     with the threshold raised, nothing else.

- [ ] You get an email when ding stops answering or a status condition fails, without opening ding. A log line is not an
      alert, and an in-process cron cannot page you about its own death.
  1. The `ding-status` cron (above) emails surprisetalk@gmail.com via the existing Resend helper when any grade < 1.0.
     Subject carries the worst condition verbatim.
  2. Dedupe: at most one alert per condition per 24h, read from `status_run` — a flapping check must not mailbomb.
  3. External uptime ping (the isolate cannot report that it is gone): a 5-minute GitHub Actions cron hits
     `GET /status`, and fails the job on non-200 or on any grade < 1.0. Actions emails on job failure.
  4. Resource alarm: Neon and Deno Deploy both have built-in usage alerts — set CPU, storage, and spend limits in their
     consoles and point them at the same address. Note in `claude.md` that they exist outside this repo.

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
  3. Excerpt: `resolveThumbnail` already fetched and read the page. Reuse that same HTML with `linkedom` +
     `@mozilla/readability` (already deps — see `bots.ts:471`) and store 200 chars in a new `com.excerpt` column. One
     fetch, not two, and it must stay outside the transaction like the rest of `deriveBody`.
  4. `Post` renders excerpt under the title. `GET /` selects the new column; `/c` shares the fragment builders, so add
     it in one place.
  5. Test: a root post whose link has no og:image and no readable article still renders a tile (favicon + no excerpt) —
     the grid must never collapse.

- [ ] You paste a link into compose and get tag chips to click, instead of typing labels from memory.
  1. `GET /t?url=` returns up to 6 tags: `stat_tag` rows whose tag appears in the page title or the URL host, plus your
     ▲'d tags, minus your ▼'d ones (a ▼ must suppress here too, like everywhere else).
  2. Cache by URL in an isolate-local Map with a bound (200 entries, drop oldest) — a suggestion endpoint must never
     become a per-keystroke fetch of a foreign site. 3s timeout.
  3. `public/client.js`: on paste or blur of the textarea, if it holds a URL, fetch and render the chips into the
     existing `.tag-presets` container; a click appends `#tag` to the labels input.
  4. A failed or empty suggestion renders nothing. This is the one place silence is correct — a suggestion that could
     not be computed is a decline, not an error.

- [ ] You drag a slider on `/u` and decide how much the feed personalizes for you. The ranking half already ships (label
      prefs + the `mine`/`cand`/`pick` chain); only the dial is missing.
  1. `alter table usr add pref_weight real not null default 1` (bounded 0–2, checked in SQL) in `db.sql` +
     `migrate.sql`.
  2. `/u` renders `<input type=range min=0 max=2 step=0.25>` inside the existing bio form — `POST /u` already redirects
     back, so no new route.
  3. `GET /` hot branch multiplies the pref boost in `pick` by `pref_weight`. Keep it inside `pick`, above the window,
     so the three correlated `aggCols` subqueries still run on 25 rows and not 300.
  4. Test: `pref_weight = 0` returns exactly the anonymous global order, and 2 doubles the boost. That test is what
     stops the slider from quietly becoming a no-op.

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
     many are in it. Degrading to a worse mesh instead is how this becomes unusable and unfixable.
  5. Compose: a `room` button beside draw/attach in `ComposeTools` mints an 8-char id and inserts the URL into the
     textarea, exactly like the image upload flow. `formatBody` renders an 800.ding.bar URL as a room card with the live
     count.
  6. Ranking: `deriveBody` extracts room ids into a new `com.rooms text[]` (GIN indexed), and `refresh_score` gains
     `+ interval '6 hours' * ln(live_peers + 1)` from a `room_agg` CTE joining `room_peer`. Boost by live participants,
     not by pinning — an empty room must fall.
  7. A `ding-rooms` cron every minute deletes stale `room_peer` rows and re-scores the posts that hold live rooms.
     Without it an emptied room keeps its boost forever, which is the whole failure mode of this feature.

- [ ] You record a voice memo or a video clip from compose, like attaching an image.
  1. `MediaRecorder` in `client.js` → blob → the existing `POST /i` path. `IMG_EXT_RE`/`MIME_BY_EXT` already accept
     `mp4`/`webm`, and `formatBody` already renders them as muted looping video.
  2. Button in `ComposeTools`; a stop button; hard 60s cap (the recorder stops itself, and the cap is in the message
     when it fires).
  3. Pick the extension from the recorder's actual `mimeType` — iOS Safari records `audio/mp4`, not webm. Hardcoding
     webm ships a feature that works only on your laptop.

- [ ] You hit `remix` on any image, audio, or video and reply with a mangled copy of it — dithered, pixelsorted,
      lowpoly, glitched, chipmunked, reversed, deepfried. The transforms already exist as bots; today they only fire
      from an `@dither` mention and take up to 5 minutes. This makes them a button.
  1. Re-export the transform functions that already ship: `toBraille` (`bots/dither.ts`), `pixelsort`, `lowpoly`, and
     `glitchSvg`/`dupeLayers`/`noiseRects` (`bots.ts`). `bots/mod.ts` is statically imported by the server, so sharp is
     already bundled on Deploy — this adds no dependency and no new image code.
  2. `POST /r` takes `{url, tool}`, dispatches through a flat `REMIX` record of `{name → fn}`, uploads the result to R2
     with a fresh 8-char id on the existing `POST /i` path, and returns the new URL for the compose box.
  3. Call `directImageUrl(url)` FIRST. `i.ding.bar` is the same Deploy project, so an in-isolate fetch of a ding-hosted
     image must be rewritten — that exact bug silently killed dither/pixelsort/lowpoly on every image posted through
     `POST /i` while they kept working on `i.redd.it`. The test for this entry is a remix of an `i.ding.bar` URL, not an
     external one.
  4. Audio and video remixes run in the browser, not on the server: Deno Deploy has no ffmpeg. `WebAudio` for speed /
     pitch / reverse, a canvas filter for video, `MediaRecorder` to re-encode — the same recorder plumbing as the
     voice-memo entry, so build that one first.
  5. UI: a `remix` button in `ComposeTools` and on every post that holds media, opening a strip of tool chips. The
     result posts as a reply, so `parent_cid` already records what was remixed from what. Do not add a `remix_of` column
     — the thread IS the lineage.
  6. Bound every tool: 5 MB input, `fitSharp`'s max dimension, 15s. A transform that throws returns 400 naming the tool
     and the input size, never a bare 500 — half these tools will die on a weird alpha channel or a 1-pixel image, and
     the message is what makes that a five-minute fix.
  7. Keep the tools quirky and few. A remix strip of 8 named things people repeat is worth more than 30 sliders, and
     every tool is a permanent maintenance surface.

- [ ] You are a moderator with a Slack or Discord export and you move your community to ding in an afternoon. Decision:
      one-shot import only. A live two-way bridge means tokens, rate limits, and dedup loops forever.
  1. `import.ts` + `deno task import <export.zip> *org`: channels → `#tag`, `thread_ts` → `parent_cid`, users →
     unverified `usr` rows `invited_by` the importer, source timestamps → `created_at`.
  2. Idempotent and resumable like `backfill.ts`. Add `com.src text unique` holding `slack:<team>:<ts>` and skip on
     conflict. It is a new column and therefore a tax; the alternative is reusing `com.hash`, which must keep meaning
     "dht content hash" or the dht projection invariant rots.
  3. Private channels import as `*org`, never as public roots. An import that leaks a private channel is worse than no
     import.
  4. Bound it: refuse an export over 200k messages up front, with the count in the message. Half an import is worse than
     none.
  5. Then write the migration guide as a post on ding and take it to 20 target communities (r/True\* subreddits, small
     Discords, academic Zulip refugees). Keep the target list in `*ding`, not in this file.

- [ ] You use ding from an iPhone app with real push notifications. Decision: native, not a PWA — push is the entire
      reason, and iOS web push needs the app installed anyway. This is a second codebase and App Store review on every
      release. Do it last.
  1. First finish the JSON API — `readme.md` still says `http POST ding.bar ... # TODO`. `api.ding.bar` must answer
     `POST /c`, `POST /p`, and `GET /n` in JSON. Basic Auth already works there.
  2. Backend push: `usr.apns_token`, and the notification insert path sends to APNs. Without this step the app is just a
     slower browser.
  3. `ding-ios` (new repo), SwiftUI, four screens: feed, thread, compose, notifications. Nothing else.
