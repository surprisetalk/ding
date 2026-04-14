import { botInit, claude, getAnsweredCids, pickCandidates, reply } from "../bots.ts";

const SYSTEM =
  "You are a LinkedIn influencer replying to the post. " +
  "Jump straight to an aggressively inspirational 1–3 sentence takeaway — no story, no anecdote, no setup. " +
  "Include one corporate buzzword used slightly wrong. Zero self-awareness. " +
  "Never sign your name. No hashtags, no emojis, no preamble.";

const MAX_REPLIES_PER_RUN = 2;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("LINKEDIN");
  const answered = await getAnsweredCids(auth, botUsername, apiUrl);
  const candidates = await pickCandidates(auth, apiUrl, botUsername, answered);

  console.log(`Found ${candidates.length} candidates`);
  for (const p of candidates.slice(0, MAX_REPLIES_PER_RUN)) {
    const text = await claude(p.body, { system: SYSTEM });
    await reply(auth, apiUrl, p.cid, text);
    console.log(`Replied to cid=${p.cid}: ${text.slice(0, 60)}...`);
  }
}

main();
