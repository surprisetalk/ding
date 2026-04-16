import { firstMatch as m, rssBot } from "../bots.ts";

rssBot({
  envPrefix: "TILDES",
  feedUrl: "https://tildes.net/topics.rss",
  parseItem: (x) => {
    const title = m(/<title><!\[CDATA\[(.*?)\]\]><\/title>/, x) || m(/<title>(.*?)<\/title>/, x);
    const link = m(/<link>(.*?)<\/link>/, x);
    const comments = m(/<comments>(.*?)<\/comments>/, x);
    if (!title || !link) return null;
    const cats = (x.match(/<category>(.*?)<\/category>/g) || [])
      .map((t) => t.replace(/<\/?category>/g, "").toLowerCase().replace(/\s+/g, "-"));
    const tags = `#tildes ${cats.map((t) => `#${t}`).join(" ")} #bot`.trim();
    return {
      link,
      commentsUrl: comments,
      body: `${title}\n\n${link}${comments ? `\n\nTildes: ${comments}` : ""}`,
      tags,
    };
  },
});
