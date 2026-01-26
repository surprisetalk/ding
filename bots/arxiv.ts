// arXiv computer science papers bot for ding
// Posts new papers from arXiv RSS feed

const DING_API_URL = Deno.env.get("DING_API_URL") || "https://ding.bar";
const BOT_EMAIL = Deno.env.get("BOT_ARXIV_EMAIL") || "";
const BOT_PASSWORD = Deno.env.get("BOT_ARXIV_PASSWORD") || "";

const auth = btoa(`${BOT_EMAIL}:${BOT_PASSWORD}`);

// Derive username from email: bot-arxiv@ding.bar → bot_arxiv
const BOT_USERNAME = BOT_EMAIL.split("@")[0].replace(/-/g, "_");

const CATEGORIES = ["cs"]; // Computer science; expand as needed

// Fetch bot's latest posts to find watermark
async function getPostedUrls(): Promise<Set<string>> {
  const res = await fetch(`${DING_API_URL}/c?usr=${BOT_USERNAME}&limit=100`, {
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

interface ArxivItem {
  title: string;
  link: string;
  authors: string;
  abstract: string;
  category: string; // e.g., "cs.AI"
}

// Parse arXiv RSS feed
async function fetchArxivFeed(category: string): Promise<ArxivItem[]> {
  const res = await fetch(`https://rss.arxiv.org/rss/${category}`);
  const xml = await res.text();
  const items: ArxivItem[] = [];

  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const itemXml of itemMatches) {
    // Title includes arXiv ID: "Paper Title. (arXiv:2401.12345v1 [cs.AI])"
    const rawTitle = itemXml.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "";
    // Clean up title - remove arXiv ID suffix and unescape
    const title = rawTitle
      .replace(/\s*\(arXiv:[^)]+\)\s*$/, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim();

    const link = itemXml.match(/<link>(.*?)<\/link>/)?.[1] || "";

    // Authors from dc:creator (Dublin Core namespace)
    const authors = itemXml.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/)?.[1]
      ?.replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim() || "";

    // Abstract from description
    const rawAbstract =
      itemXml.match(/<description>([\s\S]*?)<\/description>/)?.[1] || "";
    const abstract = rawAbstract
      .replace(/<[^>]+>/g, "") // Strip HTML tags
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .trim();

    // Primary category from arxiv:primary_category
    const primaryCategory =
      itemXml.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)?.[1] ||
      category;

    if (title && link) {
      items.push({
        title,
        link,
        authors,
        abstract,
        category: primaryCategory,
      });
    }
  }
  return items;
}

// Split "cs.AI" into ["cs", "ai"] for hashtags
function categoryToTags(category: string): string {
  const parts = category.toLowerCase().split(".");
  return parts.map((t) => `#${t}`).join(" ");
}

// Post a single item to ding
async function postItem(item: ArxivItem): Promise<boolean> {
  // Truncate abstract to ~1000 chars
  const truncatedAbstract = item.abstract.length > 1000
    ? item.abstract.slice(0, 997) + "..."
    : item.abstract;

  const body = [
    item.title,
    "",
    item.link,
    "",
    `Authors: ${item.authors}`,
    "",
    truncatedAbstract,
  ].join("\n");

  const tags = `${categoryToTags(item.category)} #arxiv #bot`;

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
    console.error("Missing BOT_ARXIV_EMAIL or BOT_ARXIV_PASSWORD");
    Deno.exit(1);
  }

  const postedUrls = await getPostedUrls();
  console.log(`Found ${postedUrls.size} previously posted URLs`);

  // Fetch from all categories
  const allItems: ArxivItem[] = [];
  for (const category of CATEGORIES) {
    const items = await fetchArxivFeed(category);
    console.log(`Fetched ${items.length} items from arXiv/${category}`);
    allItems.push(...items);
  }

  // Filter to new items only
  const newItems = allItems.filter((item) => !postedUrls.has(item.link));
  console.log(`Found ${newItems.length} new items to post`);

  // Post up to 10 per run
  for (const item of newItems.slice(0, 10)) {
    console.log(`Posting: ${item.title.slice(0, 60)}...`);
    const ok = await postItem(item);
    if (!ok) console.error(`Failed to post: ${item.title}`);
  }
}

main();
