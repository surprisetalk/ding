import { type Api, dailyPostBot, dupeLayers, glitchTwemojiToR2, noiseRects, seededRng, todaySeed } from "../bots.ts";

const TWEMOJI_CODEPOINTS = [
  "1f600",
  "1f34e",
  "1f680",
  "1f308",
  "1f525",
  "1f40d",
  "1f344",
  "1f30b",
  "1f3b8",
  "1f9e0",
  "1f47e",
  "1f916",
  "1f3a8",
  "1f52e",
  "1f4a1",
  "1f335",
  "1f40c",
  "1f987",
  "1f996",
  "1f419",
  "1f577",
  "1f3d4",
  "1f30a",
  "1f300",
  "1f311",
  "1f319",
  "2604",
  "1f3f0",
  "1f5ff",
  "1f3ad",
  "1f3b2",
  "1f0cf",
  "1f48e",
  "1f4d0",
  "1f50d",
  "1f4bf",
  "1f4f7",
  "1f3af",
  "1f3a3",
  "2693",
  "1f6f8",
  "1f9f2",
  "1f4a3",
  "1f9ea",
  "1f52c",
  "1f52d",
  "1f9ec",
  "2699",
  "1f451",
  "1f3fa",
];

export default (api: Api) =>
  dailyPostBot(api, {
    tags: "#art #glitch #bot",
    make: async () => {
      const seed = todaySeed();
      const cp = TWEMOJI_CODEPOINTS[seed % TWEMOJI_CODEPOINTS.length];
      const { r2Url, src } = await glitchTwemojiToR2(cp, seededRng(seed), "clipart", {
        pathProb: 0.05,
        pathAmp: 4,
        hexProb: 0.1,
        hexShift: 4,
        decorate: (out, rng) =>
          dupeLayers(out, rng, { count: Math.floor(rng() * 2), jitter: 6, rotate: 5 }) +
          noiseRects(rng, {
            count: Math.floor(rng() * 2),
            x: () => Math.floor(rng() * 36),
            w: () => 2 + Math.floor(rng() * 8),
            h: () => 1 + Math.floor(rng() * 2),
            opacity: () => 0.05 + rng() * 0.15,
          }),
      });
      return `${r2Url}\n\nglitched clipart\n\nsource: ${src}`;
    },
  });
