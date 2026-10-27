import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Api } from "../bots.ts";
import lectures, { formatLecture, LECTURES_PATH, parseLectures, pickLecture, unpostedCount } from "./lectures.ts";

const P = "bots/data/lectures.tsv";
const row = (...c: string[]) => c.join("\t");
const A = row("https://a.example/1", "Ann", "", "First", "", "");
const B = row("https://b.example/2", "Bob", "bob.example", "Second", "design clojure", "1");

Deno.test("parseLectures: rows decode into records", () => {
  assertEquals(parseLectures(`${A}\n${B}\n`, P), [
    { url: "https://a.example/1", speaker: "Ann", handle: "", title: "First", tags: [], fave: false },
    {
      url: "https://b.example/2",
      speaker: "Bob",
      handle: "bob.example",
      title: "Second",
      tags: ["design", "clojure"],
      fave: true,
    },
  ]);
});

Deno.test("parseLectures: bad rows name the line, the rule, and the fix", () => {
  assertThrows(
    () => parseLectures(`${A}\n${A.replace("https://a.example/1", "https://c.example/3")}\nx\ty\tz\tw\n`, P),
    Error,
    `${P} line 3: expected 6 tab-separated columns (url, speaker, handle, title, tags, fave), got 4. Fix the row.`,
  );
  assertThrows(
    () => parseLectures(`${A}\n${B}\n${A}\n`, P),
    Error,
    `${P} lines 1 and 3 share https://a.example/1: delete one.`,
  );
  assertThrows(
    () => parseLectures(`${A}\n${B.replace(/1$/, "yes")}\n`, P),
    Error,
    `${P} line 2: fave must be "" or "1", got "yes".`,
  );
  assertThrows(
    () => parseLectures(row("ftp://x", "Ann", "", "T", "", ""), P),
    Error,
    `${P} line 1: url must start with http:// or https://, got "ftp://x". Fix the row.`,
  );
});

Deno.test("formatLecture: with and without a handle", () => {
  const [a, b] = parseLectures(`${A}\n${B}\n`, P);
  assertEquals(formatLecture(a), "Ann: First https://a.example/1");
  assertEquals(formatLecture(b), "Bob (@bob.example): Second https://b.example/2");
});

Deno.test("pickLecture: unposted fave first, else first unposted, else throw", () => {
  const rows = parseLectures(`${A}\n${B}\n`, P);
  assertEquals(pickLecture(rows, new Set())?.title, "Second");
  assertEquals(pickLecture(rows, new Set(["https://b.example/2"]))?.title, "First");
  assertEquals(pickLecture(rows, new Set(["https://b.example/2", "https://a.example/1"])), undefined);
  assertEquals(unpostedCount(rows, new Set(["https://b.example/2"])), 1);
});

// Serves the two reads the bot makes: the last-post probe (limit 1) and the full-history walk.
const botApi = (history: { body: string; created_at: string }[]) => {
  const posts: { body: string; labels?: string }[] = [];
  const api: Api = {
    botUsername: "bot_lectures",
    orgsR: [],
    users: () => Promise.resolve([]),
    feed: (q) => Promise.resolve(q.limit === 1 ? history.slice(0, 1) : history),
    post: (body, o) => {
      posts.push({ body, labels: o.labels });
      return Promise.resolve(true);
    },
  };
  return { api, posts };
};

Deno.test("lectures bot: posts the first unposted fave with lecture, bot and row tags", async () => {
  const { api, posts } = botApi([]);
  await lectures(api);
  assertEquals(posts.length, 1);
  assertEquals(posts[0].labels?.startsWith("#lecture #bot"), true);
  const rows = parseLectures(Deno.readTextFileSync(LECTURES_PATH), P);
  const want = rows.find((r) => r.fave) ?? rows[0];
  assertEquals(posts[0].body, formatLecture(want));
});

Deno.test("lectures bot: dedup reads history older than 30 days", async () => {
  const rows = parseLectures(Deno.readTextFileSync(LECTURES_PATH), P);
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const first = rows.find((r) => r.fave) ?? rows[0];
  const history = [{ body: formatLecture(first), created_at: old }];
  // The probe sees a post 400 days old, so the gap is open and the old URL must still dedupe.
  const { api, posts } = botApi(history);
  await lectures(api);
  assertEquals(posts.length, 1);
  assertEquals(posts[0].body.includes(first.url), false);
});

Deno.test("lectures bot: no row left throws with the count", async () => {
  const rows = parseLectures(Deno.readTextFileSync(LECTURES_PATH), P);
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const { api } = botApi(rows.map((r) => ({ body: formatLecture(r), created_at: old })).slice(0, 100));
  if (rows.length > 100) throw new Error("test fixture: history page holds 100 rows");
  await assertRejects(
    () => Promise.resolve(lectures(api)),
    Error,
    `bot_lectures: all ${rows.length} rows in ${P} are posted. Add rows.`,
  );
});

Deno.test("lectures.tsv: the committed catalog parses and holds at least 14 rows", () => {
  const rows = parseLectures(Deno.readTextFileSync(LECTURES_PATH), P);
  assertEquals(rows.length >= 14, true);
});
