// Reddit r/hmmm image bot — posts images from the r/hmmm subreddit.

import { type Api, MAX_AGE_MS, redditBot } from "../bots.ts";

export default (api: Api) =>
  redditBot(api, {
    subs: ["hmmm"],
    maxPosts: 1,
    freshnessMs: MAX_AGE_MS,
    selftext: false,
    perFeed: "all",
    tags: () => "#hmmm #reddit #bot",
  });
