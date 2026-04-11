import { botInit, getLastPostAge, post, seededRng, todaySeed } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("AQUARIUM");

const SWIMMERS = ["🐟", "🐠", "🐡", "🦈", "🦑", "🐡"];
const BOTTOM_DWELLERS = ["🐌", "🦀", "🐙"];
const PLANTS = ["🌿", "🪸", "🌱"];
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

async function main() {
  const ageMs = await getLastPostAge(auth, botUsername, apiUrl);
  if (ageMs / 3_600_000 < 20) {
    console.log("Too soon, skipping");
    return;
  }

  const scene = generateAquarium();
  console.log(scene);
  await post(auth, apiUrl, scene, "#emoji #aquarium #bot");
}

main();
