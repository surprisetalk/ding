// Multi-subreddit Reddit bot — samples from a list, posts freshest unseen items.

import { botInit, getPostedUrls, post, slugTag } from "../bots.ts";

const SUBREDDITS = [
  "me_irl",
  "okbuddyretard",
  "comedyheaven",
  "woahdude",
  "nextfuckinglevel",
  "wholesomememes",
  "wizardposting",
  "gifs",
  "WritingPrompts",
  "aww",
  "DIY",
  "books",
  "science",
  "wallstreetbets",
  "PrequelMemes",
  "math",
  "Documentaries",
  "Advice",
  "DesignPorn",
  "Design",
  "memes_of_the_dank",
  "gamephysics",
  "madlads",
  "perfectlycutscreams",
  "softwaregore",
  "teenagers",
  "BoneHurtingJuice",
  "the_pack",
  "youtubehaiku",
  "tiltshift",
  "Ooer",
  "emojipasta",
  "surrealmemes",
  "AlbumArtPorn",
  "graphic_design",
  "heavymind",
  "Illustration",
  "fashion",
];

const SAMPLE = 12;
const CONCURRENCY = 4;
const MAX_POSTS = 3;
const FETCH_TIMEOUT_MS = 15_000;
const UA = "ding-bot/1.0 (+https://ding.bar; contact: taylor@ding.bar)";

const { apiUrl, auth, botUsername } = botInit("REDDIT");

const unesc = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

const extractImg = (html: string): string | null => {
  const u = unesc(html);
  const raw = u.match(/https:\/\/i\.redd\.it\/[^\s"'<>]+/)?.[0] ??
    u.match(/https:\/\/i\.imgur\.com\/[^\s"'<>]+/)?.[0] ??
    u.match(/<img[^>]+src="([^"]+)"/)?.[1] ??
    null;
  return raw ? unesc(raw) : null;
};

type Item = { sub: string; title: string; link: string; imageUrl: string | null; author: string; published: number };

const fetchSelftext = async (link: string): Promise<string> => {
  try {
    const res = await fetch(link.replace(/\/?$/, "/") + ".json", {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": UA, "Accept": "application/json" },
    });
    if (!res.ok) {
      console.warn(`selftext fetch failed for ${link}: ${res.status}`);
      return "";
    }
    const data = await res.json();
    return (data?.[0]?.data?.children?.[0]?.data?.selftext ?? "").trim();
  } catch (err) {
    console.warn(`selftext fetch error for ${link}: ${(err as Error).message}`);
    return "";
  }
};

const fetchSub = async (sub: string): Promise<Item[]> => {
  const url = `https://www.reddit.com/r/${sub}/.rss`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*" },
      });
    } catch (err) {
      console.warn(`r/${sub} fetch error: ${(err as Error).message}`);
      return [];
    }
    if (res.status === 429 && attempt === 0) {
      const ra = parseInt(res.headers.get("retry-after") || "5", 10);
      console.warn(`r/${sub} 429, sleeping ${ra}s`);
      await new Promise((r) => setTimeout(r, Math.min(ra, 30) * 1000));
      continue;
    }
    if (!res.ok) {
      console.warn(`r/${sub} fetch failed: ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const items: Item[] = [];
    for (const entry of xml.match(/<entry>[\s\S]*?<\/entry>/g) || []) {
      const title = unesc(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").trim();
      const link = entry.match(/<link[^>]+href="([^"]+)"/)?.[1] || "";
      const content = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || "";
      const author = entry.match(/<author>[\s\S]*?<name>([^<]+)<\/name>/)?.[1]?.trim() || "";
      const pubStr = entry.match(/<published>([^<]+)<\/published>/)?.[1] ??
        entry.match(/<updated>([^<]+)<\/updated>/)?.[1] ??
        "";
      const published = pubStr ? +new Date(pubStr) : 0;
      if (title && link) items.push({ sub, title, link, imageUrl: extractImg(content), author, published });
    }
    return items;
  }
  return [];
};

const shuffled = [...SUBREDDITS];
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const sample = shuffled.slice(0, SAMPLE);
console.log(`Sampling ${sample.length} of ${SUBREDDITS.length} subreddits: ${sample.join(", ")}`);

let idx = 0;
const newestPerSub: Item[] = [];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (idx < sample.length) {
      const items = await fetchSub(sample[idx++]);
      items.sort((a, b) => b.published - a.published);
      if (items[0]) newestPerSub.push(items[0]);
    }
  }),
);
console.log(`Fetched ${newestPerSub.length} newest entries`);

const posted = await getPostedUrls(auth, apiUrl, botUsername);
const todo = newestPerSub
  .filter((i) => !posted.has(i.link))
  .sort((a, b) => b.published - a.published);
console.log(`${todo.length} new items after dedup; posting up to ${MAX_POSTS}`);

for (const it of todo.slice(0, MAX_POSTS)) {
  const selftext = await fetchSelftext(it.link);
  const lines = [it.title];
  if (selftext) lines.push("", selftext);
  lines.push("", it.link);
  if (it.imageUrl) lines.push("", it.imageUrl);
  lines.push("", `via ${it.author} on r/${it.sub}`);
  const tags = `#reddit #${slugTag(it.sub)} #bot`;
  console.log(`Posting: ${it.title.slice(0, 60)}... (r/${it.sub})`);
  await post(auth, apiUrl, lines.join("\n"), tags);
}
