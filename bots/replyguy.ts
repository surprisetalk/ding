import { type Api, reply, verdictBot } from "../bots.ts";

const SYSTEM = "You are bot_replyguy, a confident know-it-all on a small social feed. " +
  'For each post: "chime" if you can add a "well, actually" correction or tangent, "skip" otherwise. ' +
  'Every "chime" needs a "note": ONE confident, faintly off-topic one-liner under 25 words ' +
  "that adds nothing but sounds authoritative. Never ask questions. " +
  "Return ONLY a JSON array, no prose, no markdown fences: " +
  '[{"cid":123,"verdict":"chime","note":"well, actually this is a solved problem in erlang"},{"cid":124,"verdict":"skip"}]';

export default (api: Api) =>
  verdictBot(api, {
    system: SYSTEM,
    maxActions: 5,
    verdicts: {
      chime: (api, p, note) => note ? reply(api, p.cid, note) : null,
    },
  });
