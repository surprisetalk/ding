// Reddit r/hmmm image bot — posts images from the r/hmmm subreddit.

import { type Api, getPostedUrls, isFresh, parseRedditEntries, post, redditFetch, type RedditItem } from "../bots.ts";

const FEED_URL = "https://www.reddit.com/r/hmmm/.rss";
async function fetchRedditFeed(): Promise<RedditItem[]> {
  const res = await redditFetch(FEED_URL);
  if (!res.ok) {
    console.error(`Failed to fetch feed: ${res.status}`);
    return [];
  }
  return parseRedditEntries(await res.text());
}

export default async (api: Api) => {
  const postedUrls = await getPostedUrls(api);
  console.log(`Found ${postedUrls.size} previously posted URLs`);

  const items = await fetchRedditFeed();
  console.log(`Fetched ${items.length} items from r/hmmm`);

  const newItems = items
    .filter((i) => i.published > 0 && isFresh(i.published))
    .filter((i) => !postedUrls.has(i.link));
  console.log(`Found ${newItems.length} new items to post`);

  for (const item of newItems.slice(0, 1)) {
    const lines = [item.title, "", item.link];
    if (item.imageUrl) lines.push("", item.imageUrl);
    lines.push("", `via ${item.author} on r/hmmm`);
    console.log(`Posting: ${item.title.slice(0, 60)}...`);
    if (!await post(api, lines.join("\n"), "#hmmm #reddit #bot"))
      console.error(`Failed to post: ${item.title}`);
  }
};
