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
  const cols = 40;
  const rows = 20;
  const w = cols * 2;
  const h = rows * 4;

  const { data } = await sharp(imageBytes)
    .resize(w, h, { fit: "fill" })
    .grayscale()
    .normalize()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buf = new Float32Array(data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = buf[i];
      const nw = old < 128 ? 0 : 255;
      buf[i] = nw;
      const err = old - nw;
      if (x + 1 < w) buf[i + 1] += err * 7 / 16;
      if (y + 1 < h) {
        if (x > 0) buf[i + w - 1] += err * 3 / 16;
        buf[i + w] += err * 5 / 16;
        if (x + 1 < w) buf[i + w + 1] += err * 1 / 16;
      }
    }
  }

  const lines: string[] = [];
  for (let by = 0; by < rows; by++) {
    let line = "";
    for (let bx = 0; bx < cols; bx++) {
      let code = 0;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 2; c++)
          if (buf[(by * 4 + r) * w + (bx * 2 + c)] < 128) code |= BRAILLE_MAP[r][c];
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

  const res = await fetch(`${apiUrl}/c?mention=${botUsername}&comments=1&sort=new&limit=20`, {
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
    if (!imgRes.ok) {
      console.error(`Failed to fetch image: HTTP ${imgRes.status}`);
      continue;
    }
    const imageBytes = new Uint8Array(await imgRes.arrayBuffer());

    const braille = await toBraille(imageBytes);
    console.log(`cid=${post.cid}: ${braille.length} chars`);
    await reply(auth, apiUrl, post.cid, braille);
  }
}

main();
