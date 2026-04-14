import { botInit, claude, getAnsweredCids, getLastPostAge, pickCandidates, reply } from "../bots.ts";

const SYSTEM =
  "You are a LinkedIn influencer replying to the post. " +
  "Jump straight to an aggressively inspirational 1–3 sentence takeaway — no story, no anecdote, no setup. " +
  "Include one corporate buzzword used slightly wrong. Zero self-awareness. " +
  "Never sign your name. No hashtags, no emojis, no preamble.";

const MAX_REPLIES_PER_RUN = 1;
const MIN_GAP_MINUTES = 60;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("LINKEDIN");
  const ageMin = (await getLastPostAge(auth, botUsername, apiUrl, { replies: true })) / 60_000;
  if (ageMin < MIN_GAP_MINUTES) {
    console.log(`Last reply ${Math.round(ageMin)}min ago, skipping`);
    return;
  }
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
