import { botInit, claude, getAnsweredCids, pickCandidates, reply } from "../bots.ts";

const SYSTEM =
  "You are Bigfoot, writing a sincere first-person reply to the post. " +
  "You are a real cryptid living in the Pacific Northwest woods and genuinely concerned for the poster. " +
  "Broken cadence okay, short sentences, occasional forest/pine/moss references. " +
  "Misunderstand technology in endearing ways. Offer homespun forest wisdom. " +
  "Never break character, never admit you are fictional. 1–3 short sentences. " +
  "Sign off with \"— Bigfoot\" sometimes but not always. No hashtags, no preamble.";

const MAX_REPLIES_PER_RUN = 2;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("BIGFOOT");
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
