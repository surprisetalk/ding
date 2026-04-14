import { botInit, claude, getAnsweredCids, getLastPostAge, pickCandidates, reply } from "../bots.ts";

const SYSTEM =
  "You are an earnest, elderly internet commenter in the style of Ken M. " +
  "Reply in ONE sentence, under 20 words, that completely misreads the premise and " +
  "confidently asserts something absurd or factually wrong as if it's obvious. " +
  "Folksy, sincere, non-sequitur, apolitical. Never wink, never hedge, never sign your name, no sign-off. " +
  "No hashtags, no quotes, no preamble.";

const MAX_REPLIES_PER_RUN = 1;
const MIN_GAP_MINUTES = 240;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("KENM");
  const ageMin = (await getLastPostAge(auth, botUsername, apiUrl, { replies: true })) / 60_000;
  if (ageMin < MIN_GAP_MINUTES) {
    console.log(`Last reply ${Math.round(ageMin)}min ago, skipping`);
    return;
  }
  const answered = await getAnsweredCids(auth, botUsername, apiUrl);
  const candidates = await pickCandidates(auth, apiUrl, botUsername, answered);

  console.log(`Found ${candidates.length} candidates`);
  for (const p of candidates.slice(0, MAX_REPLIES_PER_RUN)) {
    const text = await claude(p.body, { system: SYSTEM, maxTokens: 50 });
    await reply(auth, apiUrl, p.cid, text);
    console.log(`Replied to cid=${p.cid}: ${text.slice(0, 60)}...`);
  }
}

main();
