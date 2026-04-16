import { firstMatch as m, rssBot } from "../bots.ts";

rssBot({
  envPrefix: "LOBSTERS",
  feedUrl: "https://lobste.rs/rss",
  parseItem: (x) => {
    const title = m(/<title><!\[CDATA\[(.*?)\]\]><\/title>/, x) || m(/<title>(.*?)<\/title>/, x);
    const link = m(/<link>(.*?)<\/link>/, x);
    const comments = m(/<comments>(.*?)<\/comments>/, x);
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
