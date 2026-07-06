import { parseTitleLinkComments, rssBot } from "../bots.ts";

rssBot({
  envPrefix: "TILDES",
  feedUrl: "https://tildes.net/topics.rss",
  parseItem: (x) => {
    const { title, link, comments } = parseTitleLinkComments(x);
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
