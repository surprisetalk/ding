import { botInit, getJson, post } from "../bots.ts";

const { auth, botUsername, apiUrl } = botInit("ARXIV");
const CATEGORIES = ["cs"];

interface ArxivItem {
  title: string;
  link: string;
  categories: string[];
}

async function fetchArxivFeed(category: string): Promise<ArxivItem[]> {
  const res = await fetch(`https://rss.arxiv.org/rss/${category}`);
  const xml = await res.text();
  const items: ArxivItem[] = [];
  for (const itemXml of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
    const title = (itemXml.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "")
      .replace(/\s*\(arXiv:[^)]+\)\s*$/, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      .trim();
    const link = itemXml.match(/<link>(.*?)<\/link>/)?.[1] || "";
    const cats = [
      ...(itemXml.matchAll(/<category>([^<]+)<\/category>/g) || []),
      ...(itemXml.matchAll(/<arxiv:primary_category[^>]*term="([^"]+)"/g) || []),
    ].map((m) => m[1].trim()).filter(Boolean);
    const categories = [...new Set(cats.length ? cats : [category])];
    if (title && link) items.push({ title, link, categories });
  }
  return items;
}

const categoryToTag = (c: string) => "#" + c.toLowerCase().replace(/\./g, "-");

async function hasDigestForToday(category: string): Promise<boolean> {
  const posts = await getJson<{ body: string; created_at: string }[]>(
    `/c?usr=${botUsername}&limit=10`,
    auth,
    apiUrl,
  ).catch(() => []);
  const today = new Date().toISOString().slice(0, 10);
  return posts.some((p) => p.body.startsWith(`arXiv ${category}`) && p.created_at?.slice(0, 10) === today);
}

function buildDigest(category: string, items: ArxivItem[]): { body: string; included: ArxivItem[] } {
  const header = `arXiv ${category} — ${new Date().toISOString().slice(0, 10)}`;
  let body = header;
  const included: ArxivItem[] = [];
  for (const item of items) {
    const title = item.title.length > 80 ? item.title.slice(0, 77) + "..." : item.title;
    const entry = `\n- ${title}\n  ${item.link}`;
    if (body.length + entry.length > 1400) {
      const remaining = items.length - included.length;
      if (remaining > 0) body += `\n\n...and ${remaining} more`;
      break;
    }
    body += entry;
    included.push(item);
  }
  return { body, included };
}

const MAX_SUBCAT_TAGS = 8;

async function main() {
  for (const category of CATEGORIES) {
    if (await hasDigestForToday(category)) {
      console.log(`Digest already posted for ${category} today`);
      continue;
    }
    const items = await fetchArxivFeed(category);
    console.log(`Fetched ${items.length} items from arXiv/${category}`);
    if (!items.length) continue;
    const { body, included } = buildDigest(category, items);
    const freq = new Map<string, number>();
    for (const i of included) for (const c of i.categories) freq.set(c, (freq.get(c) ?? 0) + 1);
    const catTags = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SUBCAT_TAGS)
      .map(([c]) => categoryToTag(c))
      .join(" ");
    const tags = `${catTags} #arxiv #bot`.replace(/\s+/g, " ").trim();
    if (await post(auth, apiUrl, body, tags)) console.log(`Posted digest for ${category}`);
    else console.error(`Failed to post digest for ${category}`);
  }
}

main();
