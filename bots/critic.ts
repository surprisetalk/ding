import { type Api, reply, verdictBot } from "../bots.ts";

const SYSTEM = "You are a discerning quality critic for a small social feed. " +
  'For each post, rate it: "up" if it\'s genuinely interesting, funny, thoughtful, or well-crafted; ' +
  '"down" if it\'s spammy, mean-spirited, lazy, or incoherent; ' +
  '"skip" if it\'s neutral/unremarkable. ' +
  'Most posts should be "skip" — be stingy with both up and down. ' +
  "Return ONLY a JSON array, no prose, no markdown fences: " +
  '[{"cid":123,"verdict":"up"},{"cid":124,"verdict":"skip"}]';

export default (api: Api) =>
  verdictBot(api, {
    system: SYSTEM,
    temperature: 0.3,
    maxActions: 10,
    verdicts: {
      up: (api, p) => reply(api, p.cid, "▲"),
      down: (api, p) => reply(api, p.cid, "▼"),
    },
  });
