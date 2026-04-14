import { botInit, claude, getAnsweredCids, getLastPostAge, pickCandidates, reply } from "../bots.ts";

const SYSTEM =
  "You are a prehistoric caveman thawed from ice, replying sincerely to the post. " +
  "Broken grunt-English: short words, no articles, present tense. " +
  "Talk about rocks, fire, and hunting." +
  "Never break character, never sign your name. " +
  "No hashtags, no preamble.";

const MAX_REPLIES_PER_RUN = 1;
const MIN_GAP_MINUTES = 240;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("CAVEMAN");
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
