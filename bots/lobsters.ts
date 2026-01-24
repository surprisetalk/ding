// Lobste.rs frontpage bot for ding
// Posts top Lobsters stories

const DING_API_URL = Deno.env.get("DING_API_URL") || "https://ding.bar";
const BOT_EMAIL = Deno.env.get("BOT_EMAIL") || "";
const BOT_PASSWORD = Deno.env.get("BOT_PASSWORD") || "";

const auth = btoa(`${BOT_EMAIL}:${BOT_PASSWORD}`);

// Fetch bot's latest posts to find watermark
async function getPostedUrls(): Promise<Set<string>> {
  const res = await fetch(`${DING_API_URL}/c?uid=2&limit=100`, {
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

// Parse Lobsters RSS feed
interface LobstersItem {
  title: string;
  link: string;
  comments: string;
  tags: string[];
}

async function fetchLobstersFeed(): Promise<LobstersItem[]> {
  const res = await fetch("https://lobste.rs/rss");
  const xml = await res.text();
  const items: LobstersItem[] = [];

  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const itemXml of itemMatches) {
    const title = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
      itemXml.match(/<title>(.*?)<\/title>/)?.[1] || "";
    const link = itemXml.match(/<link>(.*?)<\/link>/)?.[1] || "";
    const comments = itemXml.match(/<comments>(.*?)<\/comments>/)?.[1] || "";

    // Extract category tags
    const tagMatches = itemXml.match(/<category>(.*?)<\/category>/g) || [];
    const tags = tagMatches.map((t) =>
      t.replace(/<\/?category>/g, "").toLowerCase()
    );

    if (title && link) {
      items.push({ title, link, comments, tags });
    }
  }
  return items;
}

// Post a single item to ding
async function postItem(item: LobstersItem): Promise<boolean> {
  const body = `${item.title}\n\n${item.link}\n\nLobsters: ${item.comments}`;

  // Build tags: RSS categories + #bot
  const hashtags = item.tags.map((t) => `#${t}`).join(" ");
  const tags = `${hashtags} #bot`.trim();

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
    console.error("Missing BOT_EMAIL or BOT_PASSWORD");
    Deno.exit(1);
  }

  const postedUrls = await getPostedUrls();
  console.log(`Found ${postedUrls.size} previously posted URLs`);

  const items = await fetchLobstersFeed();
  console.log(`Fetched ${items.length} items from Lobsters RSS`);

  // Filter to new items only
  const newItems = items.filter(
    (item) => !postedUrls.has(item.link) && !postedUrls.has(item.comments),
  );
  console.log(`Found ${newItems.length} new items to post`);

  // Post newest first (limit to 10 per run)
  for (const item of newItems.slice(0, 10)) {
    console.log(`Posting: ${item.title}`);
    const ok = await postItem(item);
    if (!ok) console.error(`Failed to post: ${item.title}`);
  }
}

main();
