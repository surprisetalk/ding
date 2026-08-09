import { type Api, categoryRssBot } from "../bots.ts";

export default (api: Api) =>
  categoryRssBot(api, {
    feedUrl: "https://tildes.net/topics.rss",
    label: "Tildes",
    prefixTags: "#tildes",
    slugSpaces: true,
  });
