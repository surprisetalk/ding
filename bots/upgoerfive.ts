import { botInit, claude, getAnsweredCids, getJson, reply, resolveTextContent } from "../bots.ts";

const SYSTEM = "Rewrite the user's text using only the thousand most common English words, " +
  "in the style of xkcd's Up Goer Five / Thing Explainer. " +
  "Keep the original meaning. Short sentences. Replace technical or uncommon words " +
  "with plain-word paraphrases (e.g. 'computer' → 'thinking box', 'rocket' → 'up-goer', " +
  "'doctor' → 'person who makes you feel better'). " +
  "No preamble, no sign-off, no hashtags, no quotes.";

const MAX_REPLIES_PER_RUN = 5;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("UPGOERFIVE");
  const answered = await getAnsweredCids(auth, botUsername, apiUrl);

  const posts = await getJson<
    { cid: number; parent_cid: number | null; body: string; created_by: string }[]
  >(`/c?mention=${botUsername}&comments=1&sort=new&limit=20`, auth, apiUrl);

  const unanswered = posts.filter((p) => p.created_by !== botUsername && !answered.has(p.cid));
  console.log(`Found ${unanswered.length} unanswered mentions`);

  for (const p of unanswered.slice(0, MAX_REPLIES_PER_RUN)) {
    const content = await resolveTextContent(auth, apiUrl, p);
    const text = await claude(content, { system: SYSTEM, maxTokens: 300, temperature: 0.6 });
    const body = text.split("\n").map((l) => `> ${l}`).join("\n");
    await reply(auth, apiUrl, p.cid, body);
    console.log(`Replied to cid=${p.cid}: ${text.slice(0, 60)}...`);
  }
}

main();
