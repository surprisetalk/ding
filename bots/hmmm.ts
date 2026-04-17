// Reddit r/hmmm image bot — posts images from the r/hmmm subreddit.

import { botInit, getPostedUrls, post } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("HMMM");

const FEED_URL = "https://www.reddit.com/r/hmmm/.rss";
const FETCH_TIMEOUT_MS = 15_000;

// Reddit throttles aggressively; descriptive UA + single retry on 429 is polite enough.
async function redditFetch(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": "ding-bot/1.0 (+https://ding.bar; contact: taylor@ding.bar)",
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
      },
    });
    if (res.status !== 429 || attempt === 1) return res;
    const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10);
    console.warn(`Reddit 429, sleeping ${retryAfter}s then retrying`);
    await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000));
  }
  throw new Error("unreachable");
}

interface RedditItem {
  title: string;
  link: string;
  imageUrl: string | null;
  author: string;
}

function extractImageUrl(html: string): string | null {
  const unescaped = html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  return unescaped.match(/https:\/\/i\.redd\.it\/[^\s"'<>]+/)?.[0] ??
    unescaped.match(/https:\/\/i\.imgur\.com\/[^\s"'<>]+/)?.[0] ??
    unescaped.match(/<img[^>]+src="([^"]+)"/)?.[1] ??
    null;
}

async function fetchRedditFeed(): Promise<RedditItem[]> {
  const res = await redditFetch(FEED_URL);
  if (!res.ok) {
    console.error(`Failed to fetch feed: ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const items: RedditItem[] = [];
  for (const entry of xml.match(/<entry>[\s\S]*?<\/entry>/g) || []) {
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]
      ?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim() || "";
    const link = entry.match(/<link[^>]+href="([^"]+)"/)?.[1] || "";
    const content = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || "";
    const imageUrl = extractImageUrl(content);
    const author = entry.match(/<author>[\s\S]*?<name>([^<]+)<\/name>/)?.[1]?.trim() || "";
    if (title && link) items.push({ title, link, imageUrl, author });
  }
  return items;
}

async function main() {
  const postedUrls = await getPostedUrls(auth, apiUrl, botUsername);
  console.log(`Found ${postedUrls.size} previously posted URLs`);

  const items = await fetchRedditFeed();
  console.log(`Fetched ${items.length} items from r/hmmm`);

  const newItems = items.filter((i) => !postedUrls.has(i.link));
  console.log(`Found ${newItems.length} new items to post`);

  for (const item of newItems.slice(0, 1)) {
    const lines = [item.title, "", item.link];
    if (item.imageUrl) lines.push("", item.imageUrl);
    lines.push("", `via ${item.author} on r/hmmm`);
    console.log(`Posting: ${item.title.slice(0, 60)}...`);
    if (!await post(auth, apiUrl, lines.join("\n"), "#hmmm #reddit #bot"))
      console.error(`Failed to post: ${item.title}`);
  }
}

main().catch((err) => {
  console.error(`hmmm bot failed gracefully: ${err?.message || err}`);
  Deno.exit(0);
});
