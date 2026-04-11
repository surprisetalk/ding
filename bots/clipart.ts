import { botInit, getLastPostAge, post, uploadToR2, seededRng, todaySeed } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("CLIPART");

const TWEMOJI_CODEPOINTS = [
  "1f600", "1f34e", "1f680", "1f308", "1f525", "1f40d", "1f344", "1f30b",
  "1f3b8", "1f9e0", "1f47e", "1f916", "1f3a8", "1f52e", "1f4a1", "1f335",
  "1f40c", "1f987", "1f996", "1f419", "1f577", "1f3d4", "1f30a", "1f300",
  "1f311", "1f319", "2604", "1f3f0", "1f5ff", "1f3ad", "1f3b2", "1f0cf",
  "1f48e", "1f4d0", "1f50d", "1f4bf", "1f4f7", "1f3af", "1f3a3", "2693",
  "1f6f8", "1f9f2", "1f4a3", "1f9ea", "1f52c", "1f52d", "1f9ec", "2699",
  "1f451", "1f3fa",
];

function glitchSvg(svg: string, rng: () => number): string {
  let out = svg;

  out = out.replace(/\bd="([^"]+)"/g, (_match, d: string) => {
    const glitched = d.replace(/-?\d+\.?\d*/g, (n: string) => {
      if (rng() < 0.3) return String(parseFloat(n) + (rng() - 0.5) * 20);
      return n;
    });
    return `d="${glitched}"`;
  });

  out = out.replace(/#([0-9a-fA-F]{6})/g, (_match, hex: string) => {
    if (rng() < 0.4) {
      const scrambled = hex.split("").map((c: string) => {
        const v = (parseInt(c, 16) + Math.floor(rng() * 8)) % 16;
        return v.toString(16);
      }).join("");
      return `#${scrambled}`;
    }
    return `#${hex}`;
  });

  const closingTag = "</svg>";
  const insertIdx = out.lastIndexOf(closingTag);
  if (insertIdx !== -1) {
    let extras = "";
    const dupeCount = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < dupeCount; i++) {
      const tx = (rng() - 0.5) * 30;
      const ty = (rng() - 0.5) * 30;
      const rot = Math.floor(rng() * 360);
      extras += `<g transform="translate(${tx.toFixed(1)},${ty.toFixed(1)}) rotate(${rot})" opacity="${(0.2 + rng() * 0.4).toFixed(2)}">`;
      const pathMatch = out.match(/<path[^>]*\/>/);
      if (pathMatch) extras += pathMatch[0];
      extras += `</g>`;
    }
    const rectCount = 3 + Math.floor(rng() * 5);
    for (let i = 0; i < rectCount; i++) {
      const x = Math.floor(rng() * 36);
      const y = Math.floor(rng() * 36);
      const w = 2 + Math.floor(rng() * 20);
      const h = 1 + Math.floor(rng() * 4);
      const r = Math.floor(rng() * 256);
      const g = Math.floor(rng() * 256);
      const b = Math.floor(rng() * 256);
      extras += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgb(${r},${g},${b})" opacity="${(0.1 + rng() * 0.5).toFixed(2)}"/>`;
    }
    out = out.slice(0, insertIdx) + extras + out.slice(insertIdx);
  }

  return out;
}

async function main() {
  const ageMs = await getLastPostAge(auth, botUsername, apiUrl);
  if (ageMs / 3_600_000 < 20) {
    console.log("Too soon, skipping");
    return;
  }

  const rng = seededRng(todaySeed());
  const cp = TWEMOJI_CODEPOINTS[Math.floor(rng() * TWEMOJI_CODEPOINTS.length)];
  const url = `https://raw.githubusercontent.com/twitter/twemoji/master/assets/svg/${cp}.svg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch twemoji ${cp}: HTTP ${res.status}`);
  const svgText = await res.text();

  const glitched = glitchSvg(svgText, rng);
  const data = new TextEncoder().encode(glitched);
  const date = new Date().toISOString().slice(0, 10);
  const r2Url = await uploadToR2(data, `clipart-${date}.svg`, "image/svg+xml");

  console.log(`Posting: ${r2Url}`);
  const ok = await post(auth, apiUrl, `${r2Url}\n\nglitched clipart`, "#art #glitch #bot");
  if (!ok) Deno.exit(1);
  console.log("Posted!");
}

main();
