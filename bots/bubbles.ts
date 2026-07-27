import { type Api, atomTitleLink, decodeEntities, firstMatch as m, rssBot } from "../bots.ts";

export default (api: Api) =>
  rssBot(api, {
    feedUrl: "https://bubbles.town/feed",
    itemRe: /<entry[^>]*>[\s\S]*?<\/entry>/g,
    parseItem: (x) => {
      const { title: rawTitle, link } = atomTitleLink(x);
      const title = decodeEntities(rawTitle);
      if (!title || !link) return null;
      const author = decodeEntities(m(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/, x)).replace(/\s+/g, " ").trim();
      const permalink = m(/(https:\/\/bubbles\.town\/entry\/\d+)/, x);
      return {
        link,
        commentsUrl: permalink,
        body: `${title}\n\n${link}${permalink ? `\n\nBubbles: ${permalink}` : ""}${author ? `\n\nvia ${author}` : ""}`,
        tags: "#blog #bubbles #bot",
      };
    },
    max: 5,
  });
