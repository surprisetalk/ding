import { type Api, dailyPostBot, seededRng, todaySeed } from "../bots.ts";

const STAR_CHARS = ["✦", "✧", "⋆", "˚", "∘", "·", "★", "☆", "✶", "✸"];
const SYLLABLES = ["or", "us", "ium", "ax", "en", "al", "is", "ar", "el", "on", "um", "ix", "an", "os", "ur"];
function generate(): { name: string; grid: string } {
  const rng = seededRng(todaySeed());
  const W = 30, H = 15;
  const cells: string[][] = Array.from({ length: H }, () => Array(W).fill(" "));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (rng() < 0.06)
        cells[y][x] = STAR_CHARS[Math.floor(rng() * STAR_CHARS.length)];
    }
  }

  const nameLen = 2 + Math.floor(rng() * 2);
  const name = Array.from({ length: nameLen }, () => SYLLABLES[Math.floor(rng() * SYLLABLES.length)]).join("");
  const capitalized = name[0].toUpperCase() + name.slice(1);

  return { name: capitalized, grid: cells.map((r) => r.join("")).join("\n").replace(/\s+$/gm, "").replace(/\n+$/, "") };
}

export default (api: Api) =>
  dailyPostBot(api, {
    tags: "#stars #unicode #bot",
    make: () => {
      const { name, grid } = generate();
      const body = `${name}\n\n${grid}`;
      console.log(body);
      return body;
    },
  });
