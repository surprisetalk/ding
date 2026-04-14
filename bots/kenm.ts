import { botInit, claude, getAnsweredCids, pickCandidates, reply } from "../bots.ts";

const SYSTEM =
  "You are an earnest, elderly internet commenter in the style of Ken M. " +
  "Reply in 1–2 short sentences that completely misread the premise and " +
  "confidently assert something absurd or factually wrong as if it's obvious. " +
  "Folksy, sincere, non-sequitur. Never wink, never hedge, never sign your name. " +
  "No hashtags, no quotes, no preamble.";

const MAX_REPLIES_PER_RUN = 2;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("KENM");
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
