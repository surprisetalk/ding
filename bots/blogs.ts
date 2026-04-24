import { botInit, firstMatch as m, getPostedUrls, post, slugTag } from "../bots.ts";

type Blog = { url: string; title: string; feed?: string };
type Item = { link: string; title: string; pubDate: Date; blogTitle: string };

const BLOGS_URL = "https://raw.githubusercontent.com/surprisetalk/blogs.hn/main/blogs.json";
const SAMPLE = 60;
const CONCURRENCY = 20;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_POSTS = 5;
const FRESHNESS_MS = 48 * 60 * 60 * 1000;
const UA = "Mozilla/5.0 ding-blogs-bot";

const { apiUrl, auth, botUsername } = botInit("BLOGS");

const blogsRes = await fetch(BLOGS_URL, { headers: { "user-agent": UA } });
if (!blogsRes.ok) throw new Error(`blogs.json fetch failed: HTTP ${blogsRes.status}`);
const all: Blog[] = await blogsRes.json();
const pool = all.filter((b) => b.feed);
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const sample = pool.slice(0, SAMPLE);
console.log(`Sampling ${sample.length} of ${pool.length} feeds`);

const parseItems = (xml: string, b: Blog): Item[] => {
  const out: Item[] = [];
  for (const c of xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []) {
    const title = (m(/<title>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/title>/, c) ||
      m(/<title>([\s\S]*?)<\/title>/, c)).trim();
    const link = m(/<link>([\s\S]*?)<\/link>/, c).trim();
    const pub = m(/<pubDate>([\s\S]*?)<\/pubDate>/, c) ||
      m(/<dc:date>([\s\S]*?)<\/dc:date>/, c);
    if (!title || !link || !pub) continue;
    const d = new Date(pub);
    if (isNaN(+d)) continue;
    out.push({ link, title, pubDate: d, blogTitle: b.title });
  }
  for (const c of xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []) {
    const title = (m(/<title[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/title>/, c) ||
      m(/<title[^>]*>([\s\S]*?)<\/title>/, c)).trim();
    const linkAttrs = [...c.matchAll(/<link\s+([^>]*?)\/?>/g)].map((x) => x[1])
      .find((a) => !/rel=["']self["']/i.test(a) && /href=/.test(a)) ?? "";
    const link = m(/href=["']([^"']+)["']/, linkAttrs);
    const pub = m(/<updated>([\s\S]*?)<\/updated>/, c) ||
      m(/<published>([\s\S]*?)<\/published>/, c);
    if (!title || !link || !pub) continue;
    const d = new Date(pub);
    if (isNaN(+d)) continue;
    out.push({ link, title, pubDate: d, blogTitle: b.title });
  }
  return out;
};

const fetchFeed = async (b: Blog): Promise<Item[]> => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(b.feed!, {
      signal: ac.signal,
      headers: {
        "user-agent": UA,
        accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5",
      },
      redirect: "follow",
    });
    if (!res.ok) return [];
    return parseItems(await res.text(), b);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
};

const cutoff = Date.now() - FRESHNESS_MS;
let idx = 0;
const newestPerFeed: Item[] = [];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (idx < sample.length) {
      const items = await fetchFeed(sample[idx++]);
      const recent = items.filter((i) => +i.pubDate > cutoff);
      recent.sort((a, b) => +b.pubDate - +a.pubDate);
      if (recent[0]) newestPerFeed.push(recent[0]);
    }
  }),
);
console.log(`Found ${newestPerFeed.length} recent items across sampled feeds`);

const LOW_SIGNAL_TITLE = /^(mastodon post|note|micropost|untitled)\b|^\d{4}-\d{2}-\d{2}$/i;

const posted = await getPostedUrls(auth, apiUrl, botUsername);
const todo = newestPerFeed
  .filter((i) => !posted.has(i.link))
  .filter((i) => !LOW_SIGNAL_TITLE.test(i.title.trim()))
  .sort((a, b) => +b.pubDate - +a.pubDate);
console.log(`${todo.length} items after dedup; posting up to ${MAX_POSTS}`);

for (const it of todo.slice(0, MAX_POSTS)) {
  const body = `${it.title}\n\n${it.link}\n\nvia ${it.blogTitle}`;
  const blogTag = slugTag(it.blogTitle);
  const tags = `#blog #bot${blogTag ? ` #${blogTag}` : ""}`;
  console.log(`Posting: ${body.slice(0, 80)}`);
  await post(auth, apiUrl, body, tags);
}
