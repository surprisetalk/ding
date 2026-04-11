import { botInit, getAnsweredCids, reply, extractImageUrl } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("SUMMONER");

const IMAGE_BOTS = ["@bot_lowpoly", "@bot_pixelsort", "@bot_dither"];
const TEXT_BOTS = ["@bot_cowsay"];

type Post = {
  cid: number;
  body: string;
  created_by: string;
  created_at: string;
  child_comments: { body: string; created_by: string }[];
};

function hasBotMention(post: Post): boolean {
  return post.child_comments.some((c) =>
    c.created_by.startsWith("bot_") || /@bot_\w+/.test(c.body)
  );
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function main() {
  // Summoner only posts replies, so check reply age (not top-level post age)
  const ageRes = await fetch(`${apiUrl}/c?usr=${botUsername}&comments=1&limit=1`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!ageRes.ok) throw new Error(`Failed to check age: ${ageRes.status}`);
  const recent: { created_at: string }[] = await ageRes.json();
  const age = recent.length ? Date.now() - new Date(recent[0].created_at).getTime() : Infinity;
  if (age < 7200000) {
    console.log(`Last post ${Math.round(age / 60000)}m ago, skipping`);
    return;
  }

  const res = await fetch(`${apiUrl}/c?sort=new&limit=50`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch posts: ${res.status}`);
  const posts: Post[] = await res.json();

  const answeredCids = await getAnsweredCids(auth, botUsername, apiUrl);

  const eligible = posts.filter((p) =>
    p.created_by !== botUsername &&
    !answeredCids.has(p.cid) &&
    !hasBotMention(p)
  );

  const imagePosts = eligible.filter((p) => extractImageUrl(p.body));
  const textPosts = eligible.filter((p) => !extractImageUrl(p.body));

  let summoned = 0;

  if (imagePosts.length) {
    const p = pick(imagePosts);
    const bot = pick(IMAGE_BOTS);
    console.log(`Summoning ${bot} on cid=${p.cid}`);
    if (await reply(auth, apiUrl, p.cid, bot)) summoned++;
  }

  if (textPosts.length) {
    const p = pick(textPosts);
    const bot = pick(TEXT_BOTS);
    console.log(`Summoning ${bot} on cid=${p.cid}`);
    if (await reply(auth, apiUrl, p.cid, bot)) summoned++;
  }

  console.log(`Summoned ${summoned} bots`);
}

main();
