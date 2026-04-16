import { botInit, extractImageUrl, getAnsweredCids, getJson, reply } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("SUMMONER");

const IMAGE_BOTS = ["@bot_lowpoly", "@bot_pixelsort", "@bot_dither"];
const TEXT_BOTS = ["@bot_cowsay", "@bot_upgoerfive"];

type Post = {
  cid: number;
  body: string;
  created_by: string;
  created_at: string;
  child_comments: { body: string; created_by: string }[];
};

const hasBotMention = (p: Post) =>
  p.child_comments.some((c) => c.created_by.startsWith("bot_") || /@bot_\w+/.test(c.body));

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

async function main() {
  const recent = await getJson<{ created_at: string }[]>(
    `/c?usr=${botUsername}&comments=1&limit=1`,
    auth,
    apiUrl,
  );
  const age = recent.length ? Date.now() - new Date(recent[0].created_at).getTime() : Infinity;
  if (age < 7200000) {
    console.log(`Last post ${Math.round(age / 60000)}m ago, skipping`);
    return;
  }

  const posts = await getJson<Post[]>(`/c?sort=new&limit=50`, auth, apiUrl);
  const answered = await getAnsweredCids(auth, botUsername, apiUrl);

  const eligible = posts.filter((p) =>
    p.created_by !== botUsername && !answered.has(p.cid) && !hasBotMention(p)
  );

  const imagePosts = eligible.filter((p) => extractImageUrl(p.body));
  const textPosts = eligible.filter((p) => !extractImageUrl(p.body));

  let summoned = 0;
  if (imagePosts.length) {
    const p = pick(imagePosts), bot = pick(IMAGE_BOTS);
    console.log(`Summoning ${bot} on cid=${p.cid}`);
    if (await reply(auth, apiUrl, p.cid, bot)) summoned++;
  }
  if (textPosts.length) {
    const p = pick(textPosts), bot = pick(TEXT_BOTS);
    console.log(`Summoning ${bot} on cid=${p.cid}`);
    if (await reply(auth, apiUrl, p.cid, bot)) summoned++;
  }

  console.log(`Summoned ${summoned} bots`);
}

main();
