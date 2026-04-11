import { botInit, getAnsweredCids, reply, resolveImageUrl } from "../bots.ts";
import sharp from "npm:sharp@0.33";

const { apiUrl, auth, botUsername } = botInit("DITHER");

// Braille dot bit positions for 2x4 grid: (col, row) -> bit
const BRAILLE_MAP = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

async function toBraille(imageBytes: Uint8Array): Promise<string> {
  const cols = 80;
  const rows = 40;
  const w = cols * 2;
  const h = rows * 4;

  const { data: pixels } = await sharp(imageBytes)
    .resize(w, h, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const lines: string[] = [];
  for (let by = 0; by < rows; by++) {
    let line = "";
    for (let bx = 0; bx < cols; bx++) {
      let code = 0;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 2; c++) {
          const px = bx * 2 + c;
          const py = by * 4 + r;
          if (pixels[py * w + px] < 128) code |= BRAILLE_MAP[r][c];
        }
      }
      line += String.fromCodePoint(0x2800 + code);
    }
    lines.push(line);
  }
  return lines.join("\n");
}

async function main() {
  const answeredCids = await getAnsweredCids(auth, botUsername, apiUrl);
  console.log(`Already answered ${answeredCids.size} posts`);

  const res = await fetch(`${apiUrl}/c?mention=${botUsername}&sort=new&limit=20`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch mentions: HTTP ${res.status}`);
  const posts: { cid: number; parent_cid: number | null; body: string; created_by: string }[] = await res.json();

  const unanswered = posts.filter((p) => p.created_by !== botUsername && !answeredCids.has(p.cid));
  console.log(`Found ${unanswered.length} unanswered mentions`);

  for (const post of unanswered.slice(0, 5)) {
    const imageUrl = await resolveImageUrl(auth, apiUrl, post);
    if (!imageUrl) {
      console.log(`cid=${post.cid}: no image found, skipping`);
      continue;
    }

    console.log(`cid=${post.cid}: processing ${imageUrl}`);
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) { console.error(`Failed to fetch image: HTTP ${imgRes.status}`); continue; }
    const imageBytes = new Uint8Array(await imgRes.arrayBuffer());

    const braille = await toBraille(imageBytes);
    console.log(`cid=${post.cid}: ${braille.length} chars`);
    await reply(auth, apiUrl, post.cid, braille);
  }
}

main();
