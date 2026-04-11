import { botInit, getAnsweredCids, reply, resolveImageUrl, uploadToR2 } from "../bots.ts";
import sharp from "npm:sharp@0.33";

const { apiUrl, auth, botUsername } = botInit("PIXELSORT");

const THRESHOLD = 60;

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

async function pixelsort(imageBytes: Uint8Array): Promise<Uint8Array> {
  const img = sharp(imageBytes);
  const meta = await img.metadata();
  const maxDim = 800;
  const scale = Math.min(1, maxDim / Math.max(meta.width!, meta.height!));
  const w = Math.round(meta.width! * scale);
  const h = Math.round(meta.height! * scale);

  const { data } = await img.resize(w, h).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const sorted = new Uint8Array(pixels);

  for (let y = 0; y < h; y++) {
    let runStart = -1;
    for (let x = 0; x <= w; x++) {
      const i = (y * w + x) * 3;
      const bright = x < w ? luminance(pixels[i], pixels[i + 1], pixels[i + 2]) : 0;

      if (bright > THRESHOLD && runStart === -1) {
        runStart = x;
      } else if ((bright <= THRESHOLD || x === w) && runStart !== -1) {
        const run: { r: number; g: number; b: number; lum: number }[] = [];
        for (let rx = runStart; rx < x; rx++) {
          const ri = (y * w + rx) * 3;
          run.push({ r: pixels[ri], g: pixels[ri + 1], b: pixels[ri + 2], lum: luminance(pixels[ri], pixels[ri + 1], pixels[ri + 2]) });
        }
        run.sort((a, b) => a.lum - b.lum);
        for (let j = 0; j < run.length; j++) {
          const di = (y * w + runStart + j) * 3;
          sorted[di] = run[j].r;
          sorted[di + 1] = run[j].g;
          sorted[di + 2] = run[j].b;
        }
        runStart = -1;
      }
    }
  }

  return new Uint8Array(await sharp(sorted, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer());
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

    const pngBytes = await pixelsort(imageBytes);
    const filename = `pixelsort-${post.cid}-${Date.now()}.png`;
    const url = await uploadToR2(new Uint8Array(pngBytes), filename, "image/png");

    console.log(`cid=${post.cid}: uploaded ${url}`);
    await reply(auth, apiUrl, post.cid, url);
  }
}

main();
