import { type Api, parseTitleLinkComments, rssBot } from "../bots.ts";

export default (api: Api) =>
  rssBot(api, {
    feedUrl: "https://hnrss.org/frontpage",
    parseItem: (x) => {
      const { title, link, comments } = parseTitleLinkComments(x);
      const points = parseInt(x.match(/<description>[\s\S]*?Points:\s*(\d+)[\s\S]*?<\/description>/)?.[1] || "0");
      const ccount = parseInt(x.match(/<description>[\s\S]*?Comments:\s*(\d+)[\s\S]*?<\/description>/)?.[1] || "0");
      if (!title || !link) return null;
      return {
        link,
        commentsUrl: comments,
        body: `${title}\n\n${link}\n\nHN: ${comments}\n(${points} points, ${ccount} comments)`,
        tags: "#hn #bot",
      };
    },
  });
