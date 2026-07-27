import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { type Api, decodeEntities, extractPubDate, isFresh, isLinkPost, MAX_AGE_MS, paginate } from "./bots.ts";

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
