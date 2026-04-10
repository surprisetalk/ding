// Tildes.net bot for ding
// Posts top stories from tildes.net

const DING_API_URL = Deno.env.get("DING_API_URL") || "https://ding.bar";
const BOT_EMAIL = Deno.env.get("BOT_TILDES_EMAIL") || "";
const BOT_PASSWORD = Deno.env.get("BOT_TILDES_PASSWORD") || "";

const auth = btoa(`${BOT_EMAIL}:${BOT_PASSWORD}`);
const BOT_USERNAME = BOT_EMAIL.split("@")[0].replace(/-/g, "_");

async function getPostedUrls(): Promise<Set<string>> {
  const res = await fetch(`${DING_API_URL}/c?usr=${BOT_USERNAME}&limit=100`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch posted URLs: HTTP ${res.status} ${await res.text()}`);
  const posts: { body: string }[] = await res.json();
  const urls = new Set<string>();
  for (const post of posts) {
    const matches = post.body.match(/https?:\/\/[^\s]+/g) || [];
    for (const url of matches) urls.add(url);
  }
  return urls;
}

interface TildesItem {
  title: string;
  link: string;
  comments: string;
  categories: string[];
}

async function fetchFeed(): Promise<TildesItem[]> {
  const res = await fetch("https://tildes.net/topics.rss");
  if (!res.ok) throw new Error(`Tildes RSS fetch failed: HTTP ${res.status}`);
  const xml = await res.text();
  const items: TildesItem[] = [];

  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const itemXml of itemMatches) {
    const title = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
      itemXml.match(/<title>(.*?)<\/title>/)?.[1] || "";
    const link = itemXml.match(/<link>(.*?)<\/link>/)?.[1] || "";
    const comments = itemXml.match(/<comments>(.*?)<\/comments>/)?.[1] || "";
    const catMatches = itemXml.match(/<category>(.*?)<\/category>/g) || [];
    const categories = catMatches.map((t) =>
      t.replace(/<\/?category>/g, "").toLowerCase().replace(/\s+/g, "-")
    );

    if (title && link) items.push({ title, link, comments, categories });
  }
  return items;
}

async function postItem(item: TildesItem): Promise<boolean> {
  const body = `${item.title}\n\n${item.link}${item.comments ? `\n\nTildes: ${item.comments}` : ""}`;
  const hashtags = item.categories.map((t) => `#${t}`).join(" ");
  const tags = `#tildes ${hashtags} #bot`.trim();

  const formData = new FormData();
  formData.append("body", body);
  formData.append("tags", tags);

  const res = await fetch(`${DING_API_URL}/c`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: formData,
  });
  if (!res.ok) console.error(`Failed to post "${item.title}": HTTP ${res.status}`);
  return res.ok;
}

async function main() {
  if (!BOT_EMAIL || !BOT_PASSWORD) {
    console.error("Missing BOT_TILDES_EMAIL or BOT_TILDES_PASSWORD");
    Deno.exit(1);
  }

  const postedUrls = await getPostedUrls();
  console.log(`Found ${postedUrls.size} previously posted URLs`);

  const items = await fetchFeed();
  console.log(`Fetched ${items.length} items from Tildes RSS`);

  const newItems = items.filter(
    (item) => !postedUrls.has(item.link) && !postedUrls.has(item.comments),
  );
  console.log(`Found ${newItems.length} new items to post`);

  for (const item of newItems.slice(0, 10)) {
    console.log(`Posting: ${item.title}`);
    const ok = await postItem(item);
    if (!ok) console.error(`Failed to post: ${item.title}`);
  }
}

main();
