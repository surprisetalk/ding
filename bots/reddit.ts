// Multi-subreddit Reddit bot — samples from a list, posts freshest unseen items.

import {
  type Api,
  getPostedUrls,
  parseRedditEntries,
  post,
  redditFetch,
  type RedditItem,
  shuffle,
  slugTag,
  sweepFeeds,
} from "../bots.ts";

const SUBREDDITS = [
  "me_irl",
  "okbuddyretard",
  "comedyheaven",
  "woahdude",
  "nextfuckinglevel",
  "wholesomememes",
  "wizardposting",
  "gifs",
  "WritingPrompts",
  "aww",
  "DIY",
  "books",
  "science",
  "wallstreetbets",
  "PrequelMemes",
  "math",
  "Documentaries",
  "Advice",
  "DesignPorn",
  "Design",
  "memes_of_the_dank",
  "gamephysics",
  "madlads",
  "perfectlycutscreams",
  "softwaregore",
  "teenagers",
  "BoneHurtingJuice",
  "the_pack",
  "youtubehaiku",
  "tiltshift",
  "Ooer",
  "emojipasta",
  "surrealmemes",
  "AlbumArtPorn",
  "graphic_design",
  "heavymind",
  "Illustration",
  "fashion",
];

const SAMPLE = 12;
const CONCURRENCY = 4;
const MAX_POSTS = 3;
const FETCH_TIMEOUT_MS = 15_000;
const FRESHNESS_MS = 24 * 60 * 60 * 1000;
const UA = "ding-bot/1.0 (+https://ding.bar; contact: taylor@ding.bar)";

type Item = RedditItem & { sub: string };

const fetchSelftext = async (link: string): Promise<string> => {
  try {
    const res = await fetch(link.replace(/\/?$/, "/") + ".json", {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": UA, "Accept": "application/json" },
    });
    if (!res.ok) {
      console.warn(`selftext fetch failed for ${link}: ${res.status}`);
      return "";
    }
    const data = await res.json();
    return (data?.[0]?.data?.children?.[0]?.data?.selftext ?? "").trim();
  } catch (err) {
    console.warn(`selftext fetch error for ${link}: ${(err as Error).message}`);
    return "";
  }
};

const fetchSub = async (sub: string): Promise<Item[]> => {
  try {
    const res = await redditFetch(`https://www.reddit.com/r/${sub}/.rss`, FETCH_TIMEOUT_MS);
    if (!res.ok) {
      console.warn(`r/${sub} fetch failed: ${res.status}`);
      return [];
    }
    return parseRedditEntries(await res.text()).map((i) => ({ sub, ...i }));
  } catch (err) {
    console.warn(`r/${sub} fetch error: ${(err as Error).message}`);
    return [];
  }
};

export default async (api: Api) => {
  const sample = shuffle([...SUBREDDITS]).slice(0, SAMPLE);
  console.log(`Sampling ${sample.length} of ${SUBREDDITS.length} subreddits: ${sample.join(", ")}`);

  const cutoff = Date.now() - FRESHNESS_MS;
  const newestPerSub = await sweepFeeds(sample, CONCURRENCY, fetchSub, (i) => i.published, cutoff);
  console.log(`Fetched ${newestPerSub.length} newest entries`);

  const posted = await getPostedUrls(api);
  const todo = newestPerSub
    .filter((i) => !posted.has(i.link))
    .sort((a, b) => b.published - a.published);
  console.log(`${todo.length} new items after dedup; posting up to ${MAX_POSTS}`);

  for (const it of todo.slice(0, MAX_POSTS)) {
    const selftext = await fetchSelftext(it.link);
    const lines = [it.title];
    if (selftext) lines.push("", selftext);
    lines.push("", it.link);
    if (it.imageUrl) lines.push("", it.imageUrl);
    lines.push("", `via ${it.author} on r/${it.sub}`);
    const tags = `#reddit #${slugTag(it.sub)} #bot`;
    console.log(`Posting: ${it.title.slice(0, 60)}... (r/${it.sub})`);
    await post(api, lines.join("\n"), tags);
  }
};
