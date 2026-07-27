import { type Api, dailyPostBot, glitchTwemojiToR2 } from "../bots.ts";

const EMOJI_MAP: [string, string][] = [
  ["1f600", "\u{1f600}"],
  ["1f60d", "\u{1f60d}"],
  ["1f47b", "\u{1f47b}"],
  ["1f525", "\u{1f525}"],
  ["1f680", "\u{1f680}"],
  ["1f308", "\u{1f308}"],
  ["1f34e", "\u{1f34e}"],
  ["1f40d", "\u{1f40d}"],
  ["1f996", "\u{1f996}"],
  ["1f419", "\u{1f419}"],
  ["1f47e", "\u{1f47e}"],
  ["1f916", "\u{1f916}"],
  ["1f3a8", "\u{1f3a8}"],
  ["1f52e", "\u{1f52e}"],
  ["1f48e", "\u{1f48e}"],
  ["1f30b", "\u{1f30b}"],
  ["1f30a", "\u{1f30a}"],
  ["1f300", "\u{1f300}"],
  ["1f344", "\u{1f344}"],
  ["1f335", "\u{1f335}"],
  ["1f577", "\u{1f577}"],
  ["1f987", "\u{1f987}"],
  ["1f451", "\u{1f451}"],
  ["1f3af", "\u{1f3af}"],
  ["2604", "\u{2604}"],
  ["1f4a3", "\u{1f4a3}"],
  ["1f40c", "\u{1f40c}"],
  ["1f9e0", "\u{1f9e0}"],
  ["1f3b8", "\u{1f3b8}"],
  ["1f5ff", "\u{1f5ff}"],
];

export default (api: Api) =>
  dailyPostBot(api, {
    tags: "#emoji #glitch #bot",
    make: async () => {
      const [cp, emoji] = EMOJI_MAP[Math.floor(Math.random() * EMOJI_MAP.length)];
      const { r2Url, src } = await glitchTwemojiToR2(cp, Math.random, "emojiglitch", {
        pathProb: 0.08,
        pathAmp: 6,
        hexProb: 0.15,
        hexShift: 3,
        decorate: (out, rng) => {
          let extras = "";
          const scanLines = 1 + Math.floor(rng() * 2);
          for (let i = 0; i < scanLines; i++) {
            const y = Math.floor(rng() * 36);
            const r = Math.floor(rng() * 256);
            const g = Math.floor(rng() * 256);
            const b = Math.floor(rng() * 256);
            extras += `<rect x="0" y="${y}" width="36" height="1" fill="rgb(${r},${g},${b})" opacity="${
              (0.03 + rng() * 0.1).toFixed(2)
            }"/>`;
          }
          const layers = Math.floor(rng() * 2);
          for (let i = 0; i < layers; i++) {
            const tx = (rng() - 0.5) * 10;
            const ty = (rng() - 0.5) * 10;
            const rot = Math.floor(rng() * 14 - 7);
            const scale = 0.8 + rng() * 0.3;
            extras += `<g transform="translate(${tx.toFixed(1)},${ty.toFixed(1)}) rotate(${rot}) scale(${
              scale.toFixed(2)
            })" opacity="${(0.1 + rng() * 0.2).toFixed(2)}">`;
            const pathMatch = out.match(/<path[^>]*\/>/);
            if (pathMatch) extras += pathMatch[0];
            extras += `</g>`;
          }
          return extras;
        },
      });
      return `${emoji}\n\n${r2Url}\n\nsource: ${src}`;
    },
  });
