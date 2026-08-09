import {
  type Api,
  atomTitleLink,
  fetchFeedText,
  firstMatch as m,
  getPostedUrls,
  post,
  shuffle,
  slugTag,
  sweepFeeds,
} from "../bots.ts";

type Blog = { url: string; title: string; feed?: string };
type Item = { link: string; title: string; pubDate: Date; blogTitle: string };

const BLOGS_URL = "https://raw.githubusercontent.com/surprisetalk/blogs.hn/main/blogs.json";
const SAMPLE = 60;
const CONCURRENCY = 20;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_POSTS = 5;
const FRESHNESS_MS = 24 * 60 * 60 * 1000;
const UA = "Mozilla/5.0 ding-blogs-bot";
const LOW_SIGNAL_TITLE = /^(mastodon post|note|micropost|untitled)\b|^\d{4}-\d{2}-\d{2}$/i;

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
    const { title, link } = atomTitleLink(c);
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
  const xml = await fetchFeedText(
    b.feed!,
    UA,
    "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5",
    FETCH_TIMEOUT_MS,
  );
  return xml ? parseItems(xml, b) : [];
};

export default async (api: Api) => {
  const blogsRes = await fetch(BLOGS_URL, { headers: { "user-agent": UA } });
  if (!blogsRes.ok) throw new Error(`blogs.json fetch failed: HTTP ${blogsRes.status}`);
  const all: Blog[] = await blogsRes.json();
  const pool = shuffle(all.filter((b) => b.feed));
  const sample = pool.slice(0, SAMPLE);
  console.log(`Sampling ${sample.length} of ${pool.length} feeds`);

  const cutoff = Date.now() - FRESHNESS_MS;
  const newestPerFeed = await sweepFeeds(sample, CONCURRENCY, fetchFeed, (i) => +i.pubDate, cutoff);
  console.log(`Found ${newestPerFeed.length} recent items across sampled feeds`);

  const posted = await getPostedUrls(api);
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
    await post(api, body, tags);
  }
};
