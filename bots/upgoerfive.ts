import {
  botInit,
  claude,
  getAnsweredCids,
  getLastPostAge,
  pickCandidates,
  reply,
  resolveTextContent,
} from "../bots.ts";

const SYSTEM = "Rewrite the user's text using only the thousand most common English words, " +
  "in the style of xkcd's Up Goer Five / Thing Explainer. " +
  "Keep the original meaning. Short sentences. Replace technical or uncommon words " +
  "with plain-word paraphrases (e.g. 'computer' → 'thinking box', 'rocket' → 'up-goer', " +
  "'doctor' → 'person who makes you feel better'). " +
  "No preamble, no sign-off, no hashtags, no quotes.";

const MAX_REPLIES_PER_RUN = 1;
const MIN_GAP_MINUTES = 60;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("UPGOERFIVE");
  const ageMin = (await getLastPostAge(auth, botUsername, apiUrl, { replies: true })) / 60_000;
  if (ageMin < MIN_GAP_MINUTES) {
    console.log(`Last reply ${Math.round(ageMin)}min ago, skipping`);
    return;
  }
  const answered = await getAnsweredCids(auth, botUsername, apiUrl);
  const candidates = await pickCandidates(auth, apiUrl, botUsername, answered);

  console.log(`Found ${candidates.length} candidates`);
  for (const p of candidates.slice(0, MAX_REPLIES_PER_RUN)) {
    const content = await resolveTextContent(auth, apiUrl, p);
    const text = await claude(content, { system: SYSTEM, maxTokens: 300, temperature: 0.6 });
    const body = text.split("\n").map((l) => `> ${l}`).join("\n");
    await reply(auth, apiUrl, p.cid, body);
    console.log(`Replied to cid=${p.cid}: ${text.slice(0, 60)}...`);
  }
}

main();
