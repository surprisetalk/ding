import { rssBot } from "../bots.ts";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s: string) => {
  for (let i = 0; i < 3; i++) {
    const next = s
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&([a-zA-Z]+);/g, (m, n) => ENTITIES[n] ?? m);
    if (next === s) return s;
    s = next;
  }
  return s;
};

rssBot({
  envPrefix: "SMALLWEB",
  feedUrl: "https://kagi.com/api/v1/smallweb/feed",
  itemRe: /<entry[^>]*>[\s\S]*?<\/entry>/g,
  parseItem: (x) => {
    const rawTitle = x.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
      x.match(/<title[^>]*>(.*?)<\/title>/)?.[1] || "";
    const link = x.match(/<link[^>]*href="([^"]+)"/)?.[1] || "";
    const rawAuthor = x.match(/<author>[\s\S]*?<name>(.*?)<\/name>/)?.[1] || "";
    const title = decodeEntities(rawTitle);
    const author = decodeEntities(rawAuthor);
    if (!title || !link) return null;
    const attribution = author ? `via ${author} on Kagi Small Web` : "via Kagi Small Web";
    return {
      link,
      body: `${title}\n\n${link}\n\n${attribution}`,
      tags: "#smallweb #bot",
    };
  },
});
