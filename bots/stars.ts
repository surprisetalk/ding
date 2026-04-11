import { botInit, getLastPostAge, post, seededRng, todaySeed } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("STARS");

const STAR_CHARS = ["✦", "✧", "⋆", "˚", "∘", "·", "★", "☆", "✶", "✸"];
const SYLLABLES = ["or", "us", "ium", "ax", "en", "al", "is", "ar", "el", "on", "um", "ix", "an", "os", "ur"];
const CONNECTORS: Record<string, string> = {
  "0,1": "│", "0,-1": "│",
  "1,0": "─", "-1,0": "─",
  "1,1": "╲", "-1,-1": "╲",
  "1,-1": "╱", "-1,1": "╱",
};

function generate(): { name: string; grid: string } {
  const rng = seededRng(todaySeed());
  const W = 30, H = 15;
  const cells: string[][] = Array.from({ length: H }, () => Array(W).fill(" "));

  const stars: [number, number][] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (rng() < 0.06) {
        cells[y][x] = STAR_CHARS[Math.floor(rng() * STAR_CHARS.length)];
        stars.push([x, y]);
      }

  for (let i = 0; i < stars.length; i++) {
    if (rng() > 0.4) continue;
    const [x1, y1] = stars[i];
    let best = -1, bestDist = Infinity;
    for (let j = i + 1; j < stars.length; j++) {
      const dx = Math.abs(stars[j][0] - x1), dy = Math.abs(stars[j][1] - y1);
      const dist = dx + dy;
      if (dist >= 2 && dist <= 5 && dist < bestDist && (dx === 0 || dy === 0 || dx === dy)) {
        best = j;
        bestDist = dist;
      }
    }
    if (best === -1) continue;
    const [x2, y2] = stars[best];
    const dx = Math.sign(x2 - x1), dy = Math.sign(y2 - y1);
    const key = `${dx},${dy}`;
    const ch = CONNECTORS[key];
    if (!ch) continue;
    let cx = x1 + dx, cy = y1 + dy;
    while (cx !== x2 || cy !== y2) {
      if (cells[cy][cx] === " ") cells[cy][cx] = ch;
      cx += dx;
      cy += dy;
    }
  }

  const nameLen = 2 + Math.floor(rng() * 2);
  const name = Array.from({ length: nameLen }, () => SYLLABLES[Math.floor(rng() * SYLLABLES.length)]).join("");
  const capitalized = name[0].toUpperCase() + name.slice(1);

  return { name: capitalized, grid: cells.map((r) => r.join("")).join("\n").replace(/\s+$/gm, "").replace(/\n+$/, "") };
}

async function main() {
  const ageMs = await getLastPostAge(auth, botUsername, apiUrl);
  if (ageMs / 3_600_000 < 20) {
    console.log("Too soon, skipping");
    return;
  }

  const { name, grid } = generate();
  const body = `${name}\n\n${grid}`;
  console.log(body);
  await post(auth, apiUrl, body, "#stars #unicode #bot");
}

main();
