import { botInit, claude, getAnsweredCids, reply } from "../bots.ts";

const SYSTEM =
  "You are an earnest, elderly internet commenter in the style of Ken M. " +
  "Reply to the post with 1–3 short sentences that completely misread the premise, " +
  "confidently assert something absurd or factually wrong as if it's obvious, and feel folksy and sincere. " +
  "Non-sequiturs welcome. Never be hostile, never wink, never acknowledge you're joking, never hedge. " +
  "Commit to the bit. Occasionally sign off \"-Ken\" but not always. " +
  "No hashtags, no quotes, no preamble.";

const MAX_REPLIES_PER_RUN = 2;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("KENM");
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
