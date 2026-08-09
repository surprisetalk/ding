import {
  type Api,
  extractImageUrl,
  getAnsweredCids,
  getJson,
  getLastPostAge,
  isFresh,
  MAX_AGE_MS,
  pick,
  type Post as BotPost,
  reply,
} from "../bots.ts";

const IMAGE_BOTS = ["@bot_lowpoly", "@bot_pixelsort", "@bot_dither"];
const TEXT_BOTS = ["@bot_cowsay", "@bot_upgoerfive"];

type Post = BotPost & { child_comments: { body: string; created_by: string }[] };

const hasBotMention = (p: Post) =>
  p.child_comments.some((c) => c.created_by.startsWith("bot_") || /@bot_\w+/.test(c.body));

export default async (api: Api) => {
  const age = await getLastPostAge(api, { replies: true });
  if (age < 7200000) {
    console.log(`Last post ${Math.round(age / 60000)}m ago, skipping`);
    return;
  }

  const posts = await getJson<Post[]>(api, `/c?sort=new&limit=50`);
  const answered = await getAnsweredCids(api, { since: Date.now() - MAX_AGE_MS });

  const eligible = posts.filter((p) =>
    p.created_by !== api.botUsername && !answered.has(p.cid) && isFresh(p.created_at) && !hasBotMention(p)
  );

  const imagePosts = eligible.filter((p) => extractImageUrl(p.body));
  const textPosts = eligible.filter((p) => !extractImageUrl(p.body));

  let summoned = 0;
  if (imagePosts.length) {
    const p = pick(imagePosts), bot = pick(IMAGE_BOTS);
    console.log(`Summoning ${bot} on cid=${p.cid}`);
    if (await reply(api, p.cid, bot)) summoned++;
  }
  if (textPosts.length) {
    const p = pick(textPosts), bot = pick(TEXT_BOTS);
    console.log(`Summoning ${bot} on cid=${p.cid}`);
    if (await reply(api, p.cid, bot)) summoned++;
  }

  console.log(`Summoned ${summoned} bots`);
};
