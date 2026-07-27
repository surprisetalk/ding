import { type Api, dailyPostBot, seededRng, todaySeed } from "../bots.ts";

const SWIMMERS = ["🐟", "🐠", "🐡", "🦈", "🦑", "🐡"];
const BOTTOM_DWELLERS = ["🐌", "🦀", "🐙"];
const GROUND = ["🪨", "🪸", "🌿", "🌱"];
const BUBBLES = ["🫧", "○"];

function generateAquarium(): string {
  const rng = seededRng(todaySeed());
  const cols = 12, rows = 6;
  const grid: string[][] = [];

  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    const isBottom = r >= 4;
    for (let c = 0; c < cols; c++) {
      const roll = rng();
      if (isBottom) {
        if (roll < 0.3) row.push(GROUND[Math.floor(rng() * GROUND.length)]);
        else if (roll < 0.45) row.push(BOTTOM_DWELLERS[Math.floor(rng() * BOTTOM_DWELLERS.length)]);
        else row.push("  ");
      } else {
        if (roll < 0.15) row.push(SWIMMERS[Math.floor(rng() * SWIMMERS.length)]);
        else if (roll < 0.22) row.push(BUBBLES[Math.floor(rng() * BUBBLES.length)]);
        else row.push("  ");
      }
    }
    grid.push(row);
  }

  return grid.map((row) => row.join("")).join("\n");
}

export default (api: Api) =>
  dailyPostBot(api, {
    tags: "#emoji #aquarium #bot",
    make: () => {
      const scene = generateAquarium();
      console.log(scene);
      return scene;
    },
  });
