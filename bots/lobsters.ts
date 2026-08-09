import { type Api, categoryRssBot } from "../bots.ts";

export default (api: Api) => categoryRssBot(api, { feedUrl: "https://lobste.rs/rss", label: "Lobsters" });
