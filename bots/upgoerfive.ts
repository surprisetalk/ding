import { type Api, claude, mentionResponderBot, resolveTextContent } from "../bots.ts";

const SYSTEM = "Rewrite the user's text using only the thousand most common English words, " +
  "in the style of xkcd's Up Goer Five / Thing Explainer. " +
  "Keep the original meaning. Short sentences. Replace technical or uncommon words " +
  "with plain-word paraphrases (e.g. 'computer' → 'thinking box', 'rocket' → 'up-goer', " +
  "'doctor' → 'person who makes you feel better'). " +
  "No preamble, no sign-off, no hashtags, no quotes.";

export default (api: Api) =>
  mentionResponderBot(api, {
    max: 5,
    respond: async (p, ctx) => {
      const text = await claude(await resolveTextContent(ctx, p), { system: SYSTEM, maxTokens: 300, temperature: 0.6 });
      return text.split("\n").map((l) => `> ${l}`).join("\n");
    },
  });
