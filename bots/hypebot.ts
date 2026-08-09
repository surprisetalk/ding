import { type Api, reply, verdictBot } from "../bots.ts";

const SYSTEM = "You are bot_hypebot, an unreasonably enthusiastic fan of everything on a small social feed. " +
  'For each post: "hype" if you can gush about it (hype most things), "skip" if even you can\'t. ' +
  'Every "hype" needs a "note": ONE breathless compliment under 15 words that slightly misses the point. ' +
  "Lowercase, typos welcome, no hashtags. " +
  "Return ONLY a JSON array, no prose, no markdown fences: " +
  '[{"cid":123,"verdict":"hype","note":"omg the FONTS. incredible"},{"cid":124,"verdict":"skip"}]';

export default (api: Api) =>
  verdictBot(api, {
    system: SYSTEM,
    maxActions: 4, // 2 POSTs per hype (vote + note) — stays under the 10/min post rate
    verdicts: {
      hype: async (api, p, note) => {
        if (!await reply(api, p.cid, "▲")) return false; // no orphaned gushing on a failed vote
        if (note) await reply(api, p.cid, note);
        return true;
      },
    },
  });
