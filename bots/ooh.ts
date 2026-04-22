import { firstMatch as m, rssBot } from "../bots.ts";

const CATEGORY_HREF = /href="https:\/\/ooh\.directory\/blogs\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)\/?"/g;

const extractCategoryTags = (item: string): string[] => {
  const slugs = new Set<string>();
  for (const match of item.matchAll(CATEGORY_HREF)) {
    for (const part of match[1].split("/")) if (part) slugs.add(part);
  }
  return [...slugs];
};

rssBot({
  envPrefix: "OOH",
  feedUrl: "https://ooh.directory/feeds/recently-added.xml",
  parseItem: (x) => {
    const title = (m(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/, x) ||
      m(/<title>([\s\S]*?)<\/title>/, x)).trim();
    const link = m(/<link>([\s\S]*?)<\/link>/, x).trim();
    if (!title || !link) return null;
    const tagline = m(/<q>([\s\S]*?)<\/q>/, x).replace(/\s+/g, " ").trim();
    const body = tagline
      ? `${title}\n\n${link}\n\n“${tagline}”`
      : `${title}\n\n${link}`;
    const cats = extractCategoryTags(x).map((s) => `#${s}`).join(" ");
    return { link, body, tags: `#blog #ooh ${cats} #bot`.replace(/\s+/g, " ").trim() };
  },
  max: 5,
});
