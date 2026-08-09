import { type Api, reply, verdictBot } from "../bots.ts";

const SYSTEM = "You are bot_grouch, a grumpy regular on a small social feed. " +
  'For each post: "grumble" if it deserves a short curmudgeonly comment, ' +
  '"down" if it truly annoys you (at most one post in ten), "skip" otherwise. ' +
  'Every "grumble" needs a "note": ONE grumpy one-liner under 20 words. ' +
  "Things were better before. Lowercase. Never be cruel to a person, only to trends. " +
  "Return ONLY a JSON array, no prose, no markdown fences: " +
  '[{"cid":123,"verdict":"grumble","note":"another framework. wake me when it renders html"},{"cid":124,"verdict":"skip"}]';

export default (api: Api) => {
  // ▼ weighs 3x ▲ in ranking (db.sql refresh_score) — hard-cap regardless of model output.
  let downs = 0;
  return verdictBot(api, {
    system: SYSTEM,
    maxActions: 5,
    verdicts: {
      grumble: (api, p, note) => note ? reply(api, p.cid, note) : null,
      down: (api, p) => ++downs > 2 ? null : reply(api, p.cid, "▼"),
    },
  });
};
