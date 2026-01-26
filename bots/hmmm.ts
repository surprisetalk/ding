// Reddit r/hmmm image bot for ding
// Posts images from r/hmmm subreddit

const DING_API_URL = Deno.env.get("DING_API_URL") || "https://ding.bar";
const BOT_EMAIL = Deno.env.get("BOT_HMMM_EMAIL") || "";
const BOT_PASSWORD = Deno.env.get("BOT_HMMM_PASSWORD") || "";

const auth = btoa(`${BOT_EMAIL}:${BOT_PASSWORD}`);

const FEED_URL = "https://www.reddit.com/r/hmmm/.rss";

// Fetch bot's latest posts to find watermark
async function getPostedUrls(): Promise<Set<string>> {
  const res = await fetch(`${DING_API_URL}/c?usr=hmmm&limit=100`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) return new Set();
  const posts: { body: string }[] = await res.json();
  const urls = new Set<string>();
  for (const post of posts) {
    const matches = post.body.match(/https?:\/\/[^\s]+/g) || [];
    for (const url of matches) urls.add(url);
  }
  return urls;
}

interface RedditItem {
  title: string;
  link: string;
  imageUrl: string | null;
  author: string;
}

// Extract image URL from Reddit HTML content
function extractImageUrl(html: string): string | null {
  // Unescape HTML entities first
  const unescaped = html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');

  // Look for i.redd.it images (most common on r/hmmm)
  const reddItMatch = unescaped.match(/https:\/\/i\.redd\.it\/[^\s"'<>]+/);
  if (reddItMatch) return reddItMatch[0];

  // Look for imgur images
  const imgurMatch = unescaped.match(/https:\/\/i\.imgur\.com\/[^\s"'<>]+/);
  if (imgurMatch) return imgurMatch[0];

  // Fallback: any img src
  const imgSrcMatch = unescaped.match(/<img[^>]+src="([^"]+)"/);
  if (imgSrcMatch) return imgSrcMatch[1];

  return null;
}

// Parse Reddit Atom feed
async function fetchRedditFeed(): Promise<RedditItem[]> {
  const res = await fetch(FEED_URL, {
    headers: {
      "User-Agent": "ding-bot/1.0 (https://ding.bar)",
    },
  });
  if (!res.ok) {
    console.error(`Failed to fetch feed: ${res.status}`);
    return [];
  }

  const xml = await res.text();
  const items: RedditItem[] = [];

  // Reddit uses Atom format with <entry> elements
  const entryMatches = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  for (const entryXml of entryMatches) {
    const title = entryXml.match(/<title>([\s\S]*?)<\/title>/)?.[1]
      ?.replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim() || "";

    // Atom uses <link href="..."/> format
    const link = entryXml.match(/<link[^>]+href="([^"]+)"/)?.[1] || "";

    // Content contains the HTML with image
    const content = entryXml.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || "";
    const imageUrl = extractImageUrl(content);

    // Author is in <author><name>/u/username</name></author>
    const author = entryXml.match(/<author>[\s\S]*?<name>([^<]+)<\/name>/)?.[1]
      ?.trim() || "";

    if (title && link) {
      items.push({ title, link, imageUrl, author });
    }
  }

  return items;
}

// Post a single item to ding
async function postItem(item: RedditItem): Promise<boolean> {
  const lines = [
    item.title,
    "",
    item.link,
  ];

  // Add image URL if found
  if (item.imageUrl) {
    lines.push("", item.imageUrl);
  }

  // Attribution
  lines.push("", `via ${item.author} on r/hmmm`);

  const body = lines.join("\n");
  const tags = "#hmmm #reddit #bot";

  const formData = new FormData();
  formData.append("body", body);
  formData.append("tags", tags);

  const res = await fetch(`${DING_API_URL}/c`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: formData,
  });

  return res.ok;
}

// Main
async function main() {
  if (!BOT_EMAIL || !BOT_PASSWORD) {
    console.error("Missing BOT_HMMM_EMAIL or BOT_HMMM_PASSWORD");
    Deno.exit(1);
  }

  const postedUrls = await getPostedUrls();
  console.log(`Found ${postedUrls.size} previously posted URLs`);

  const items = await fetchRedditFeed();
  console.log(`Fetched ${items.length} items from r/hmmm`);

  // Filter to new items only (dedup by Reddit post URL)
  const newItems = items.filter((item) => !postedUrls.has(item.link));
  console.log(`Found ${newItems.length} new items to post`);

  // Post up to 10 per run
  for (const item of newItems.slice(0, 10)) {
    console.log(`Posting: ${item.title.slice(0, 60)}...`);
    const ok = await postItem(item);
    if (!ok) console.error(`Failed to post: ${item.title}`);
  }
}

main();
