import { botInit, getLastPostAge, post, seededRng, todaySeed } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("AQUARIUM");

const FISH = ["🐟", "🐠", "🐡", "🐙", "🦑", "🦈"];
const PLANTS = ["🌿", "🪸", "🌱"];
const GROUND = ["🐚", "🪨", "💎", "🏴‍☠️"];
const BUBBLES = ["🫧", "○"];

function generateAquarium(): string {
  const rng = seededRng(todaySeed());
  const cols = 12, rows = 6;
  const grid: string[][] = [];

  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) {
      const roll = rng();
      const isBottom = r === rows - 1;
      const isTop = r <= 1;

      if (isBottom) {
        if (roll < 0.25) row.push(GROUND[Math.floor(rng() * GROUND.length)]);
        else if (roll < 0.4) row.push(PLANTS[Math.floor(rng() * PLANTS.length)]);
        else row.push("🌊");
      } else if (isTop) {
        if (roll < 0.08) row.push(FISH[Math.floor(rng() * FISH.length)]);
        else if (roll < 0.15) row.push(BUBBLES[Math.floor(rng() * BUBBLES.length)]);
        else row.push(roll < 0.5 ? "🌊" : "  ");
      } else {
        if (roll < 0.12) row.push(FISH[Math.floor(rng() * FISH.length)]);
        else if (roll < 0.18) row.push(BUBBLES[Math.floor(rng() * BUBBLES.length)]);
        else if (roll < 0.22) row.push(PLANTS[Math.floor(rng() * PLANTS.length)]);
        else row.push(roll < 0.6 ? "🌊" : "  ");
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
