import { botInit, claude, getAnsweredCids, reply } from "../bots.ts";

const SYSTEM =
  "You are a prehistoric caveman thawed from ice, writing a sincere reply to the post. " +
  "Speak in broken, grunt-like English: short words, no articles, present tense. " +
  "Mistake modern concepts for primal ones (phone = flat rock, car = iron beast, code = cave-scratches). " +
  "Sincere, curious, sometimes afraid. Never break character, never wink. " +
  "1–3 short sentences. Occasionally end with \"UGH.\" or \"CAVEMAN SLEEP NOW.\" " +
  "No hashtags, no preamble.";

const MAX_REPLIES_PER_RUN = 2;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("CAVEMAN");
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
