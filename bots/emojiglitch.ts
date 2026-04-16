import { botInit, getLastPostAge, post, uploadToR2 } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("EMOJIGLITCH");

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

function glitchSvg(svg: string, rng: () => number): string {
  let out = svg;

  out = out.replace(/\bd="([^"]+)"/g, (_match, d: string) => {
    const glitched = d.replace(/-?\d+\.?\d*/g, (n: string) => {
      if (rng() < 0.08) return String(parseFloat(n) + (rng() - 0.5) * 6);
      return n;
    });
    return `d="${glitched}"`;
  });

  out = out.replace(/#([0-9a-fA-F]{6})/g, (_match, hex: string) => {
    if (rng() < 0.15) {
      const chars = hex.split("").map((c: string) => {
        const v = (parseInt(c, 16) + Math.floor(rng() * 3)) % 16;
        return v.toString(16);
      }).join("");
      return `#${chars}`;
    }
    return `#${hex}`;
  });

  const closingTag = "</svg>";
  const insertIdx = out.lastIndexOf(closingTag);
  if (insertIdx === -1) return out;

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

  return out.slice(0, insertIdx) + extras + out.slice(insertIdx);
}

async function main() {
  const ageMs = await getLastPostAge(auth, botUsername, apiUrl);
  if (ageMs / 3_600_000 < 20) {
    console.log("Too soon, skipping");
    return;
  }

  const rng = Math.random;
  const [cp, emoji] = EMOJI_MAP[Math.floor(rng() * EMOJI_MAP.length)];
  const url = `https://raw.githubusercontent.com/twitter/twemoji/master/assets/svg/${cp}.svg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch twemoji ${cp}: HTTP ${res.status}`);
  const svgText = await res.text();

  const glitched = glitchSvg(svgText, rng);
  const data = new TextEncoder().encode(glitched);
  const date = new Date().toISOString().slice(0, 10);
  const r2Url = await uploadToR2(data, `emojiglitch-${date}.svg`, "image/svg+xml");

  console.log(`Posting: ${emoji} -> ${r2Url}`);
  const src = `https://github.com/twitter/twemoji/blob/master/assets/svg/${cp}.svg`;
  const ok = await post(auth, apiUrl, `${emoji}\n\n${r2Url}\n\nsource: ${src}`, "#emoji #glitch #bot");
  if (!ok) Deno.exit(1);
  console.log("Posted!");
}

main();
