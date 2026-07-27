import { type Api, parseTitleLinkComments, rssBot } from "../bots.ts";

export default (api: Api) =>
  rssBot(api, {
    feedUrl: "https://lobste.rs/rss",
    parseItem: (x) => {
      const { title, link, comments } = parseTitleLinkComments(x);
      if (!title || !link) return null;
      const cats = (x.match(/<category>(.*?)<\/category>/g) || [])
        .map((t) => t.replace(/<\/?category>/g, "").toLowerCase());
      const tags = `${cats.map((t) => `#${t}`).join(" ")} #bot`.trim();
      return {
        link,
        commentsUrl: comments,
        body: `${title}\n\n${link}\n\nLobsters: ${comments}`,
        tags,
      };
    },
  });
