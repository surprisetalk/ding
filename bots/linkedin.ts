import { botInit, claude, getAnsweredCids, reply } from "../bots.ts";

const SYSTEM =
  "You are a LinkedIn influencer replying to the post. " +
  "Turn whatever it's about into a sincere, over-the-top motivational parable. " +
  "Short paragraphs, one sentence per line. Must include: a humble-brag, a fabricated anecdote " +
  "(often ending \"and then the little boy said…\"), at least one corporate buzzword used wrong, " +
  "and an aggressively inspirational closing line. " +
  "Zero self-awareness. No hashtags, no emojis, no preamble.";

const MAX_REPLIES_PER_RUN = 2;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("LINKEDIN");
  const answered = await getAnsweredCids(auth, botUsername, apiUrl);

  const res = await fetch(`${apiUrl}/c?sort=new&limit=30`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch feed: HTTP ${res.status} ${await res.text()}`);
  const posts: { cid: number; created_by: string; body: string }[] = await res.json();

  const candidates = posts.filter((p) =>
    p.created_by !== botUsername
    && !answered.has(p.cid)
    && p.body.replace(/https?:\S+/g, "").trim().length >= 30
  );

  console.log(`Found ${candidates.length} candidates`);
  for (const p of candidates.slice(0, MAX_REPLIES_PER_RUN)) {
    const text = await claude(p.body, { system: SYSTEM });
    await reply(auth, apiUrl, p.cid, text);
    console.log(`Replied to cid=${p.cid}: ${text.slice(0, 60)}...`);
  }
}

main();
