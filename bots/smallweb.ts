import { type Api, decodeEntities, rssBot } from "../bots.ts";

export default (api: Api) =>
  rssBot(api, {
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
