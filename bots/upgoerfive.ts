import { type Api, claude, getAnsweredCids, getJson, isFresh, MAX_AGE_MS, reply, resolveTextContent } from "../bots.ts";

const SYSTEM = "Rewrite the user's text using only the thousand most common English words, " +
  "in the style of xkcd's Up Goer Five / Thing Explainer. " +
  "Keep the original meaning. Short sentences. Replace technical or uncommon words " +
  "with plain-word paraphrases (e.g. 'computer' → 'thinking box', 'rocket' → 'up-goer', " +
  "'doctor' → 'person who makes you feel better'). " +
  "No preamble, no sign-off, no hashtags, no quotes.";

const MAX_REPLIES_PER_RUN = 5;

export default async (api: Api) => {
  const answered = await getAnsweredCids(api, { since: Date.now() - MAX_AGE_MS });

  const posts = await getJson<
    { cid: number; parent_cid: number | null; body: string; created_by: string; created_at: string }[]
  >(api, `/c?mention=${api.botUsername}&comments=1&sort=new&limit=20`);

  const unanswered = posts.filter((p) =>
    p.created_by !== api.botUsername && !answered.has(p.cid) && isFresh(p.created_at)
  );
  console.log(`Found ${unanswered.length} unanswered mentions`);

  for (const p of unanswered.slice(0, MAX_REPLIES_PER_RUN)) {
    const content = await resolveTextContent(api, p);
    const text = await claude(content, { system: SYSTEM, maxTokens: 300, temperature: 0.6 });
    const body = text.split("\n").map((l) => `> ${l}`).join("\n");
    await reply(api, p.cid, body);
    console.log(`Replied to cid=${p.cid}: ${text.slice(0, 60)}...`);
  }
};
