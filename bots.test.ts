import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type Api,
  decodeEntities,
  extractPubDate,
  isFresh,
  isLinkPost,
  MAX_AGE_MS,
  mentionResponderBot,
  paginate,
  pickCandidates,
  type Post,
  scanBot,
  verdictBot,
} from "./bots.ts";
import grouch from "./bots/grouch.ts";
import { toBraille } from "./bots/dither.ts";
import sharp from "sharp";

Deno.test("isLinkPost: bare url → true", () => {
  assertEquals(isLinkPost("https://example.com/foo"), true);
});

Deno.test("isLinkPost: url + short blurb → true", () => {
  assertEquals(isLinkPost("fascinating read: https://example.com/foo"), true);
});

Deno.test("isLinkPost: no url → false", () => {
  assertEquals(isLinkPost("just some prose with no links at all here"), false);
});

Deno.test("isLinkPost: url + long commentary → false", () => {
  const body = "Here is a deep analysis of the piece. The author argues " +
    "three distinct points, each worth examining. First, the epistemic frame. " +
    "Second, the causal claim. Third, the implications. See https://example.com/a";
  assertEquals(isLinkPost(body), false);
});

Deno.test("isLinkPost: empty body → false", () => {
  assertEquals(isLinkPost(""), false);
});

Deno.test("isLinkPost: multiple urls, minimal text → true", () => {
  assertEquals(isLinkPost("https://a.com https://b.com see"), true);
});

// ---- isFresh ----

Deno.test("isFresh: now → true", () => {
  assertEquals(isFresh(Date.now()), true);
});

Deno.test("isFresh: 1h ago → true", () => {
  assertEquals(isFresh(Date.now() - 60 * 60_000), true);
});

Deno.test("isFresh: just past MAX_AGE_MS → false", () => {
  assertEquals(isFresh(Date.now() - MAX_AGE_MS - 1000), false);
});

Deno.test("isFresh: invalid timestamp → throws", () => {
  assertThrows(() => isFresh("not-a-date"), Error, "invalid timestamp");
});

Deno.test("isFresh: future timestamp → true (clock skew tolerant)", () => {
  assertEquals(isFresh(Date.now() + 60_000), true);
});

// ---- extractPubDate ----

Deno.test("extractPubDate: pubDate", () => {
  assertEquals(
    extractPubDate("<item><pubDate>Wed, 01 Jan 2026 00:00:00 GMT</pubDate></item>"),
    "Wed, 01 Jan 2026 00:00:00 GMT",
  );
});

Deno.test("extractPubDate: published (atom)", () => {
  assertEquals(
    extractPubDate("<entry><published>2026-01-01T00:00:00Z</published></entry>"),
    "2026-01-01T00:00:00Z",
  );
});

Deno.test("extractPubDate: dc:date", () => {
  assertEquals(extractPubDate("<item><dc:date>2026-01-01</dc:date></item>"), "2026-01-01");
});

Deno.test("extractPubDate: missing → null", () => {
  assertEquals(extractPubDate("<item><title>x</title></item>"), null);
});

// ---- decodeEntities ----

Deno.test("decodeEntities: named", () => {
  assertEquals(decodeEntities("Style &amp; Emacs"), "Style & Emacs");
});

Deno.test("decodeEntities: decimal", () => {
  assertEquals(decodeEntities("Diel&#39;s daydreams"), "Diel's daydreams");
});

Deno.test("decodeEntities: hex", () => {
  assertEquals(decodeEntities("Diel&#x27;s daydreams"), "Diel's daydreams");
});

Deno.test("decodeEntities: double-encoded", () => {
  assertEquals(decodeEntities("don&amp;#39;t"), "don't");
});

Deno.test("decodeEntities: unknown entity left intact", () => {
  assertEquals(decodeEntities("a &bogus; b"), "a &bogus; b");
});

Deno.test("decodeEntities: plain string unchanged", () => {
  assertEquals(decodeEntities("Bird Stories"), "Bird Stories");
});

// ---- paginate ----

// The Api context carries its own fetch, so pagination is testable without
// monkey-patching the global.
const fakeApi = (pages: unknown[][]): Api => {
  let i = 0;
  return {
    apiUrl: "http://x",
    auth: "auth",
    botUsername: "bot_test",
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(pages[i++] ?? []), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
  };
};

Deno.test("paginate: stops on short page", async () => {
  const out = await paginate<{ x: number }>(
    fakeApi([Array(100).fill({ x: 1 }), Array(50).fill({ x: 2 })]),
    (p) => `/c?p=${p}`,
    { pageSize: 100 },
  );
  assertEquals(out.length, 150);
});

Deno.test("paginate: stops on empty page", async () => {
  const out = await paginate<{ x: number }>(
    fakeApi([Array(100).fill({ x: 1 }), []]),
    (p) => `/c?p=${p}`,
    { pageSize: 100 },
  );
  assertEquals(out.length, 100);
});

Deno.test("paginate: until() short-circuits mid-page", async () => {
  const out = await paginate<{ id: number }>(
    fakeApi([[{ id: 5 }, { id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }]]),
    (p) => `/c?p=${p}`,
    { pageSize: 5, until: (it) => it.id < 3 },
  );
  assertEquals(out.map((x) => x.id), [5, 4, 3]);
});

Deno.test("paginate: throws past maxPages", async () => {
  await assertRejects(
    () =>
      paginate(
        fakeApi(Array(10).fill(Array(100).fill({ x: 1 }))),
        (p) => `/c?p=${p}`,
        { pageSize: 100, maxPages: 3 },
      ),
    Error,
    "maxPages=3",
  );
});

// ---- mentionResponderBot ----

// Routes the two calls the harness makes: `/c?usr=…` (getAnsweredCids' dedup walk) and
// `/c?mention=…` (the trigger query). POST /c/<cid> records a reply.
const mentionApi = (opts: {
  mentions: Partial<Post>[];
  answered?: { parent_cid: number; created_at: string }[];
  replyFails?: number[];
}) => {
  const replies: number[] = [];
  const api: Api = {
    apiUrl: "http://x",
    auth: "auth",
    botUsername: "bot_test",
    fetch: (input, init) => {
      const url = new URL(input);
      if (init?.method === "POST") {
        const cid = Number(url.pathname.split("/")[2]);
        if (opts.replyFails?.includes(cid)) return Promise.resolve(new Response("nope", { status: 500 }));
        replies.push(cid);
        return Promise.resolve(new Response("", { status: 200 }));
      }
      // The real `/c` treats `comments=1` as comments INSTEAD OF roots, so the harness must
      // issue both queries; serving mentions from only the root call proves it does.
      const rows = url.searchParams.has("mention")
        ? (url.searchParams.has("comments") ? [] : opts.mentions)
        : (opts.answered ?? []);
      return Promise.resolve(
        new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } }),
      );
    },
  };
  return { api, replies };
};

const mention = (cid: number, over: Partial<Post> = {}): Post => ({
  cid,
  parent_cid: null,
  body: "@bot_test do the thing",
  created_by: "alice",
  created_at: new Date().toISOString(),
  ...over,
});

// The reported bug: the old harness logged `#<tag>` while cowsay et al. answer @mentions.
Deno.test("mentionResponderBot: logs the @handle, not a #tag", async () => {
  const { api } = mentionApi({ mentions: [mention(1)] });
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await mentionResponderBot(api, { respond: () => "hi" });
  } finally {
    console.log = orig;
  }
  assertEquals(lines.includes("Found 1 unanswered @bot_test posts"), true, lines.join("\n"));
});

Deno.test("mentionResponderBot: replies to a fresh mention", async () => {
  const { api, replies } = mentionApi({ mentions: [mention(1)] });
  await mentionResponderBot(api, { respond: () => "hi" });
  assertEquals(replies, [1]);
});

Deno.test("mentionResponderBot: skips own posts, answered cids, and stale mentions", async () => {
  const { api, replies } = mentionApi({
    mentions: [
      mention(1, { created_by: "bot_test" }),
      mention(2),
      mention(3, { created_at: new Date(Date.now() - MAX_AGE_MS - 1000).toISOString() }),
      mention(4),
    ],
    answered: [{ parent_cid: 4, created_at: new Date().toISOString() }],
  });
  await mentionResponderBot(api, { respond: () => "hi" });
  assertEquals(replies, [2]);
});

Deno.test("mentionResponderBot: a null respond skips without spending the max budget", async () => {
  const { api, replies } = mentionApi({ mentions: [mention(1), mention(2)] });
  await mentionResponderBot(api, { max: 1, respond: (p) => p.cid === 1 ? null : "hi" });
  assertEquals(replies, [2]);
});

Deno.test("mentionResponderBot: max caps successful replies", async () => {
  const { api, replies } = mentionApi({ mentions: [mention(1), mention(2), mention(3)] });
  await mentionResponderBot(api, { max: 2, respond: () => "hi" });
  assertEquals(replies, [1, 2]);
});

Deno.test("mentionResponderBot: a failed reply doesn't count toward max", async () => {
  const { api, replies } = mentionApi({ mentions: [mention(1), mention(2)], replyFails: [1] });
  await mentionResponderBot(api, { max: 1, respond: () => "hi" });
  assertEquals(replies, [2]);
});

Deno.test("mentionResponderBot: no mentions → no replies", async () => {
  const { api, replies } = mentionApi({ mentions: [] });
  await mentionResponderBot(api, { respond: () => "hi" });
  assertEquals(replies, []);
});

// Let it crash: a broken respond must surface to the fleet runner, not be swallowed.
Deno.test("mentionResponderBot: a throwing respond propagates", async () => {
  const { api } = mentionApi({ mentions: [mention(1)] });
  await assertRejects(
    () =>
      mentionResponderBot(api, {
        respond: () => {
          throw new Error("respond exploded");
        },
      }),
    Error,
    "respond exploded",
  );
});

Deno.test("mentionResponderBot: a mention with an unparseable timestamp throws", async () => {
  const { api } = mentionApi({ mentions: [mention(1, { created_at: "not-a-date" })] });
  await assertRejects(() => mentionResponderBot(api, { respond: () => "hi" }), Error, "invalid timestamp");
});

Deno.test("mentionResponderBot: throws when every reply attempt bounces", async () => {
  const { api, replies } = mentionApi({ mentions: [mention(1), mention(2)], replyFails: [1, 2] });
  await assertRejects(
    () => mentionResponderBot(api, { respond: () => "hi" }),
    Error,
    "@bot_test: 2 replies attempted, none landed",
  );
  assertEquals(replies, []);
});

Deno.test("mentionResponderBot: all-null responds is quiet, not an error", async () => {
  const { api } = mentionApi({ mentions: [mention(1)] });
  await mentionResponderBot(api, { respond: () => null });
});

// ---- verdictBot ----

// Routes the harness's four GETs: answered walk (`usr&comments=1`), reacted walk
// (`usr&reactions=1`), and the two fetchFreshPosts feeds. POST /c/<cid> records {cid, body}.
const verdictApi = (opts: {
  fresh: Post[];
  reacted?: { parent_cid: number; created_at: string }[];
}) => {
  const posts: { cid: number; body: string }[] = [];
  const api: Api = {
    apiUrl: "http://x",
    auth: "auth",
    botUsername: "bot_test",
    fetch: (input, init) => {
      const url = new URL(input);
      if (init?.method === "POST") {
        posts.push({
          cid: Number(url.pathname.split("/")[2]),
          body: (init.body as FormData).get("body")?.toString() ?? "",
        });
        return Promise.resolve(new Response("", { status: 200 }));
      }
      const rows = url.searchParams.has("reactions")
        ? (opts.reacted ?? [])
        : url.searchParams.has("usr") || url.searchParams.has("comments")
        ? []
        : opts.fresh;
      return Promise.resolve(
        new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } }),
      );
    },
  };
  return { api, posts };
};

const freshPost = (cid: number): Post => ({
  cid,
  parent_cid: null,
  body: `post ${cid}: some perfectly ordinary prose content here`,
  created_by: "alice",
  created_at: new Date().toISOString(),
});

// claude() reads globalThis.fetch and ANTHROPIC_API_KEY at call time — that's the seam.
const withClaude = async (reply: string, f: () => Promise<unknown>) => {
  const origFetch = globalThis.fetch;
  const origKey = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.set("ANTHROPIC_API_KEY", "test");
  globalThis.fetch =
    ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("api.anthropic.com")
        ? Promise.resolve(new Response(JSON.stringify({ content: [{ text: reply }] }), { status: 200 }))
        : origFetch(input, init)) as typeof fetch;
  try {
    await f();
  } finally {
    globalThis.fetch = origFetch;
    if (origKey === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", origKey);
  }
};

Deno.test("verdictBot: dispatches verdicts to actions", async () => {
  const { api, posts } = verdictApi({ fresh: [freshPost(1), freshPost(2)] });
  await withClaude('[{"cid":1,"verdict":"hype","note":"WOW"},{"cid":2,"verdict":"skip"}]', () =>
    verdictBot(api, {
      system: "judge",
      verdicts: {
        hype: async (api2, p, note) => {
          await (api2.fetch(`http://x/c/${p.cid}`, { method: "POST", body: toForm({ body: "▲" }) }));
          if (note) await api2.fetch(`http://x/c/${p.cid}`, { method: "POST", body: toForm({ body: note }) });
        },
      },
    }));
  assertEquals(posts, [{ cid: 1, body: "▲" }, { cid: 1, body: "WOW" }]);
});

const toForm = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

// Pins the critic toggle-bug fix: a cid the bot already REACTED to (single-grapheme
// reply, invisible to the comments=1 dedup) must never be judged again.
Deno.test("verdictBot: reacted cids are excluded from candidates", async () => {
  const { api, posts } = verdictApi({
    fresh: [freshPost(1), freshPost(2)],
    reacted: [{ parent_cid: 1, created_at: new Date().toISOString() }],
  });
  let prompt = "";
  await withClaude('[{"cid":1,"verdict":"up"},{"cid":2,"verdict":"up"}]', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.anthropic.com"))
        prompt = JSON.parse(String(init?.body)).messages[0].content;
      return origFetch(input, init);
    }) as typeof fetch;
    try {
      await verdictBot(api, {
        system: "judge",
        verdicts: {
          up: (api2, p) => api2.fetch(`http://x/c/${p.cid}`, { method: "POST", body: toForm({ body: "▲" }) }),
        },
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });
  assertEquals(prompt.includes("cid=1"), false, `reacted cid leaked into prompt: ${prompt}`);
  assertEquals(posts, [{ cid: 2, body: "▲" }]); // verdict for cid=1 exists but has no candidate
});

Deno.test("verdictBot: non-JSON verdicts reject", async () => {
  const { api } = verdictApi({ fresh: [freshPost(1)] });
  await withClaude("I refuse to answer in JSON today", () =>
    assertRejects(
      () => verdictBot(api, { system: "judge", verdicts: {} }),
      Error,
      "non-JSON",
    ));
});

// grouch hard-caps ▼ at 2 per run no matter how grumpy the model feels.
Deno.test("grouch: at most 2 downvotes per run", async () => {
  const { api, posts } = verdictApi({ fresh: [1, 2, 3, 4, 5].map(freshPost) });
  await withClaude(JSON.stringify([1, 2, 3, 4, 5].map((cid) => ({ cid, verdict: "down" }))), () => grouch(api));
  assertEquals(posts.map((p) => p.body), ["▼", "▼"]);
});

// Duplicate verdicts for one cid would toggle the vote back off (the same failure class
// as the critic dedup bug, one layer up) — the harness must act once per cid.
Deno.test("verdictBot: duplicate cids in one batch act only once", async () => {
  const { api, posts } = verdictApi({ fresh: [freshPost(1)] });
  await withClaude('[{"cid":1,"verdict":"up"},{"cid":1,"verdict":"up"}]', () =>
    verdictBot(api, {
      system: "judge",
      verdicts: { up: (api2, p) => api2.fetch(`http://x/c/${p.cid}`, { method: "POST", body: toForm({ body: "▲" }) }) },
    }));
  assertEquals(posts, [{ cid: 1, body: "▲" }]);
});

// A run where every action reports failure must throw, not report green.
Deno.test("verdictBot: rejects when actions are attempted but none land", async () => {
  const { api } = verdictApi({ fresh: [freshPost(1), freshPost(2)] });
  await withClaude('[{"cid":1,"verdict":"up"},{"cid":2,"verdict":"up"}]', () =>
    assertRejects(
      () => verdictBot(api, { system: "judge", verdicts: { up: () => false } }),
      Error,
      "none landed",
    ));
});

Deno.test("verdictBot: bracketed but invalid JSON rejects with the raw slice", async () => {
  const { api } = verdictApi({ fresh: [freshPost(1)] });
  await withClaude('[{"cid":1 "verdict":"up"]', () =>
    assertRejects(
      () => verdictBot(api, { system: "judge", verdicts: {} }),
      Error,
      "unparseable",
    ));
});

// String-typed cids from the model must still resolve to their candidate.
Deno.test("verdictBot: string cid is coerced", async () => {
  const { api, posts } = verdictApi({ fresh: [freshPost(7)] });
  await withClaude('[{"cid":"7","verdict":"up"}]', () =>
    verdictBot(api, {
      system: "judge",
      verdicts: { up: (api2, p) => api2.fetch(`http://x/c/${p.cid}`, { method: "POST", body: toForm({ body: "▲" }) }) },
    }));
  assertEquals(posts, [{ cid: 7, body: "▲" }]);
});

// Verdict bots never judge other bots' content — mutual-reply chains would never terminate.
Deno.test("verdictBot: bot-authored candidates are excluded", async () => {
  const { api, posts } = verdictApi({
    fresh: [{ ...freshPost(1), created_by: "bot_other" }, freshPost(2)],
  });
  await withClaude('[{"cid":1,"verdict":"up"},{"cid":2,"verdict":"up"}]', () =>
    verdictBot(api, {
      system: "judge",
      verdicts: { up: (api2, p) => api2.fetch(`http://x/c/${p.cid}`, { method: "POST", body: toForm({ body: "▲" }) }) },
    }));
  assertEquals(posts, [{ cid: 2, body: "▲" }]);
});

// ---- scanBot ----

// Routes the answered walk (usr&comments=1 -> []) and the /c?sort=new feed; POST records replies.
const scanApi = (fresh: Partial<Post>[]) => {
  const replies: { cid: number; body: string }[] = [];
  const api: Api = {
    apiUrl: "http://x",
    auth: "auth",
    botUsername: "bot_test",
    fetch: (input, init) => {
      const url = new URL(input);
      if (init?.method === "POST") {
        replies.push({
          cid: Number(url.pathname.split("/")[2]),
          body: (init.body as FormData).get("body")?.toString() ?? "",
        });
        return Promise.resolve(new Response("", { status: 200 }));
      }
      const rows = url.searchParams.has("usr") ? [] : fresh;
      return Promise.resolve(
        new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } }),
      );
    },
  };
  return { api, replies };
};

const scanPost = (cid: number, body: string, over: Partial<Post> = {}): Partial<Post> => ({
  cid,
  parent_cid: null,
  body,
  created_by: "alice",
  created_at: new Date().toISOString(),
  ...over,
});

Deno.test("scanBot: replies where match returns copy, skips where it returns null", async () => {
  const { api, replies } = scanApi([scanPost(1, "yes"), scanPost(2, "no")]);
  await scanBot(api, { match: (t) => t === "yes" ? "matched" : null });
  assertEquals(replies, [{ cid: 1, body: "matched" }]);
});

Deno.test("scanBot: match sees the body with urls and mentions stripped", async () => {
  const seen: string[] = [];
  const { api } = scanApi([scanPost(1, "hello https://a.example @bob world")]);
  await scanBot(api, {
    match: (t) => {
      seen.push(t);
      return null;
    },
  });
  assertEquals(seen, ["hello   world"]);
});

Deno.test("scanBot: bot authors and stale posts are skipped", async () => {
  const { api, replies } = scanApi([
    scanPost(1, "x", { created_by: "bot_other" }),
    scanPost(2, "x", { created_at: new Date(Date.now() - MAX_AGE_MS - 1000).toISOString() }),
    scanPost(3, "x"),
  ]);
  await scanBot(api, { match: () => "hi" });
  assertEquals(replies.map((r) => r.cid), [3]);
});

Deno.test("scanBot: honours max", async () => {
  const { api, replies } = scanApi([scanPost(1, "x"), scanPost(2, "x"), scanPost(3, "x")]);
  await scanBot(api, { max: 2, match: () => "hi" });
  assertEquals(replies.length, 2);
});

// ---- pickCandidates ----

Deno.test("pickCandidates: drops own posts, answered cids, and short bodies", async () => {
  const long = "a".repeat(40);
  const { api } = scanApi([
    scanPost(1, long, { created_by: "bot_test" }),
    scanPost(2, long),
    scanPost(3, "tiny"),
    scanPost(4, long),
  ]);
  const got = await pickCandidates(api, new Set([4]));
  assertEquals(got.map((p) => p.cid), [2]);
});

// minBodyLen measures prose, not raw length — a bare link must not qualify as commentary.
Deno.test("pickCandidates: url text does not count toward minBodyLen", async () => {
  const { api } = scanApi([scanPost(1, `https://example.com/${"x".repeat(60)}`)]);
  assertEquals(await pickCandidates(api, new Set(), { excludeLinkPosts: false }), []);
});

Deno.test("pickCandidates: excludeBots and reacted filter", async () => {
  const long = "a".repeat(40);
  const { api } = scanApi([scanPost(1, long, { created_by: "bot_x" }), scanPost(2, long), scanPost(3, long)]);
  const got = await pickCandidates(api, new Set(), { excludeBots: true, reacted: new Set([3]) });
  assertEquals(got.map((p) => p.cid), [2]);
});

// ---- dither ----

// toBraille indexes the raw buffer as one byte per pixel, so anything sharp does to the channel
// count garbles the art rather than failing. grayscale() drops alpha today — this pins that, so a
// sharp upgrade that changed it trips the byte-count guard here instead of in prod.
const halfSplitPng = async (channels: 3 | 4) => {
  const w = 80, h = 80;
  const raw = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * channels;
      raw[i] = raw[i + 1] = raw[i + 2] = y < h / 2 ? 0 : 255;
      if (channels === 4) raw[i + 3] = 255;
    }
  }
  return new Uint8Array(await sharp(raw, { raw: { width: w, height: h, channels } }).png().toBuffer());
};

Deno.test("toBraille: an RGBA source renders the same art as RGB", async () => {
  const rgba = await toBraille(await halfSplitPng(4));
  assertEquals(rgba, await toBraille(await halfSplitPng(3)), "alpha leaked into the gray plane");

  const lines = rgba.split("\n");
  assertEquals(lines.length, 20);
  assertEquals(lines[0].length, 40);
  assertEquals(lines[0], "⣿".repeat(40), "dark top half should be solid dots");
  assertEquals(lines[19], "⠀".repeat(40), "light bottom half should be blank");
});
