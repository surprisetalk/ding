// Kagi Small Web bot for ding
// Posts interesting finds from independent websites via Kagi's Small Web feed

const DING_API_URL = Deno.env.get("DING_API_URL") || "https://ding.bar";
const BOT_EMAIL = Deno.env.get("BOT_SMALLWEB_EMAIL") || "";
const BOT_PASSWORD = Deno.env.get("BOT_SMALLWEB_PASSWORD") || "";

const auth = btoa(`${BOT_EMAIL}:${BOT_PASSWORD}`);

// Fetch bot's latest posts to find watermark
async function getPostedUrls(): Promise<Set<string>> {
  const res = await fetch(`${DING_API_URL}/c?uid=3&limit=100`, {
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

// Parse Kagi Small Web Atom feed
interface SmallwebItem {
  title: string;
  link: string;
  author: string;
}

async function fetchSmallwebFeed(): Promise<SmallwebItem[]> {
  const res = await fetch("https://kagi.com/api/v1/smallweb/feed");
  const xml = await res.text();
  const items: SmallwebItem[] = [];

  // Atom uses <entry> instead of RSS <item>
  // Entry tags may have attributes like xml:base="..."
  const entryMatches = xml.match(/<entry[^>]*>[\s\S]*?<\/entry>/g) || [];
  for (const entryXml of entryMatches) {
    // Title may be CDATA-wrapped or plain
    const title =
      entryXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
      entryXml.match(/<title[^>]*>(.*?)<\/title>/)?.[1] || "";

    // Atom links use href attribute: <link href="..." />
    const link = entryXml.match(/<link[^>]*href="([^"]+)"/)?.[1] || "";

    // Author is nested: <author><name>...</name></author>
    const author = entryXml.match(/<author>[\s\S]*?<name>(.*?)<\/name>/)?.[1] ||
      "";

    if (title && link) {
      items.push({ title, link, author });
    }
  }
  return items;
}

// Post a single item to ding
async function postItem(item: SmallwebItem): Promise<boolean> {
  const attribution = item.author
    ? `via ${item.author} on Kagi Small Web`
    : "via Kagi Small Web";
  const body = `${item.title}\n\n${item.link}\n\n${attribution}`;

  const formData = new FormData();
  formData.append("body", body);
  formData.append("tags", "#smallweb #bot");

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
    console.error("Missing BOT_SMALLWEB_EMAIL or BOT_SMALLWEB_PASSWORD");
    Deno.exit(1);
  }

  const postedUrls = await getPostedUrls();
  console.log(`Found ${postedUrls.size} previously posted URLs`);

  const items = await fetchSmallwebFeed();
  console.log(`Fetched ${items.length} items from Kagi Small Web`);

  // Filter to new items only
  const newItems = items.filter((item) => !postedUrls.has(item.link));
  console.log(`Found ${newItems.length} new items to post`);

  // Post up to 10 per run
  for (const item of newItems.slice(0, 10)) {
    console.log(`Posting: ${item.title}`);
    const ok = await postItem(item);
    if (!ok) console.error(`Failed to post: ${item.title}`);
  }
}

main();
