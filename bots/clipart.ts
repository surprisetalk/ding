import { dailyPostBot, glitchTwemojiToR2, seededRng, todaySeed } from "../bots.ts";

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

dailyPostBot({
  envPrefix: "CLIPART",
  tags: "#art #glitch #bot",
  make: async () => {
    const seed = todaySeed();
    const cp = TWEMOJI_CODEPOINTS[seed % TWEMOJI_CODEPOINTS.length];
    const { r2Url, src } = await glitchTwemojiToR2(cp, seededRng(seed), "clipart", {
      pathProb: 0.05,
      pathAmp: 4,
      hexProb: 0.1,
      hexShift: 4,
      decorate: (out, rng) => {
        let extras = "";
        const dupeCount = Math.floor(rng() * 2);
        for (let i = 0; i < dupeCount; i++) {
          const tx = (rng() - 0.5) * 6;
          const ty = (rng() - 0.5) * 6;
          const rot = Math.floor(rng() * 10 - 5);
          extras += `<g transform="translate(${tx.toFixed(1)},${ty.toFixed(1)}) rotate(${rot})" opacity="${
            (0.1 + rng() * 0.2).toFixed(2)
          }">`;
          const pathMatch = out.match(/<path[^>]*\/>/);
          if (pathMatch) extras += pathMatch[0];
          extras += `</g>`;
        }
        const rectCount = Math.floor(rng() * 2);
        for (let i = 0; i < rectCount; i++) {
          const x = Math.floor(rng() * 36);
          const y = Math.floor(rng() * 36);
          const w = 2 + Math.floor(rng() * 8);
          const h = 1 + Math.floor(rng() * 2);
          const r = Math.floor(rng() * 256);
          const g = Math.floor(rng() * 256);
          const b = Math.floor(rng() * 256);
          extras += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgb(${r},${g},${b})" opacity="${
            (0.05 + rng() * 0.15).toFixed(2)
          }"/>`;
        }
        return extras;
      },
    });
    return `${r2Url}\n\nglitched clipart\n\nsource: ${src}`;
  },
});
