// Reddit r/hmmm image bot — posts images from the r/hmmm subreddit.

import { botInit, getPostedUrls, isFresh, parseRedditEntries, post, redditFetch, type RedditItem } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("HMMM");

const FEED_URL = "https://www.reddit.com/r/hmmm/.rss";
async function fetchRedditFeed(): Promise<RedditItem[]> {
  const res = await redditFetch(FEED_URL);
  if (!res.ok) {
    console.error(`Failed to fetch feed: ${res.status}`);
    return [];
  }
  return parseRedditEntries(await res.text());
}

async function main() {
  const postedUrls = await getPostedUrls(auth, apiUrl, botUsername);
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
    if (!await post(auth, apiUrl, lines.join("\n"), "#hmmm #reddit #bot"))
      console.error(`Failed to post: ${item.title}`);
  }
}

main().catch((err) => {
  console.error(`hmmm bot failed gracefully: ${err?.message || err}`);
  Deno.exit(0);
});
