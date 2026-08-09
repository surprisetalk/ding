import { type Api, dailyPostBot, dupeLayers, glitchTwemojiToR2, noiseRects } from "../bots.ts";

const CODEPOINTS =
  "1f600 1f60d 1f47b 1f525 1f680 1f308 1f34e 1f40d 1f996 1f419 1f47e 1f916 1f3a8 1f52e 1f48e 1f30b 1f30a 1f300 1f344 1f335 1f577 1f987 1f451 1f3af 2604 1f4a3 1f40c 1f9e0 1f3b8 1f5ff"
    .split(" ");

export default (api: Api) =>
  dailyPostBot(api, {
    tags: "#emoji #glitch #bot",
    make: async () => {
      const cp = CODEPOINTS[Math.floor(Math.random() * CODEPOINTS.length)];
      const emoji = String.fromCodePoint(parseInt(cp, 16));
      const { r2Url, src } = await glitchTwemojiToR2(cp, Math.random, "emojiglitch", {
        pathProb: 0.08,
        pathAmp: 6,
        hexProb: 0.15,
        hexShift: 3,
        decorate: (out, rng) =>
          noiseRects(rng, {
            count: 1 + Math.floor(rng() * 2),
            w: () => 36,
            h: () => 1,
            opacity: () => 0.03 + rng() * 0.1,
          }) + dupeLayers(out, rng, { count: Math.floor(rng() * 2), jitter: 10, rotate: 7, scale: true }),
      });
      return `${emoji}\n\n${r2Url}\n\nsource: ${src}`;
    },
  });
