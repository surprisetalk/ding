// Hacker News frontpage bot for ding
// Posts top HN stories via hnrss.org

const DING_API_URL = Deno.env.get("DING_API_URL") || "https://ding.bar";
const BOT_EMAIL = Deno.env.get("BOT_EMAIL") || "";
const BOT_PASSWORD = Deno.env.get("BOT_PASSWORD") || "";

const auth = btoa(`${BOT_EMAIL}:${BOT_PASSWORD}`);

// Fetch bot's latest posts to find watermark
async function getPostedUrls(): Promise<Set<string>> {
  const res = await fetch(`${DING_API_URL}/c?uid=1`, {
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

// Parse HN RSS feed (simple regex-based XML parsing)
interface HNItem {
  title: string;
  link: string;
  comments: string;
  points: number;
  commentCount: number;
}

async function fetchHNFeed(): Promise<HNItem[]> {
  const res = await fetch("https://hnrss.org/frontpage");
  const xml = await res.text();
  const items: HNItem[] = [];

  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const itemXml of itemMatches) {
    const title = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
      itemXml.match(/<title>(.*?)<\/title>/)?.[1] || "";
    const link = itemXml.match(/<link>(.*?)<\/link>/)?.[1] || "";
    const comments = itemXml.match(/<comments>(.*?)<\/comments>/)?.[1] || "";
    const points = parseInt(
      itemXml.match(/<description>.*?Points:\s*(\d+).*?<\/description>/s)?.[1] ||
        "0",
    );
    const commentCount = parseInt(
      itemXml.match(/<description>.*?Comments:\s*(\d+).*?<\/description>/s)
          ?.[1] || "0",
    );

    if (title && link) {
      items.push({ title, link, comments, points, commentCount });
    }
  }
  return items;
}

// Post a single item to ding
async function postItem(item: HNItem): Promise<boolean> {
  const body =
    `${item.title}\n\n${item.link}\n\nHN: ${item.comments}\n(${item.points} points, ${item.commentCount} comments)`;

  const formData = new FormData();
  formData.append("body", body);
  formData.append("tags", "#hn #bot");

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

  const items = await fetchHNFeed();
  console.log(`Fetched ${items.length} items from HN RSS`);

  // Filter to new items only
  const newItems = items.filter(
    (item) => !postedUrls.has(item.link) && !postedUrls.has(item.comments),
  );
  console.log(`Found ${newItems.length} new items to post`);

  // Post newest first (reverse since RSS is newest-first already)
  for (const item of newItems.slice(0, 10)) {
    console.log(`Posting: ${item.title}`);
    const ok = await postItem(item);
    if (!ok) console.error(`Failed to post: ${item.title}`);
  }
}

main();
