import { botInit, getAnsweredCids, reply, resolveImageUrl, uploadToR2 } from "../bots.ts";
import sharp from "npm:sharp@0.33";

const { apiUrl, auth, botUsername } = botInit("LOWPOLY");

function sampleColor(pixels: Uint8Array, w: number, h: number, channels: number, cx: number, cy: number, radius: number): [number, number, number] {
  let r = 0, g = 0, b = 0, count = 0;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(w - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(h - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * channels;
      r += pixels[i];
      g += pixels[i + 1];
      b += pixels[i + 2];
      count++;
    }
  }
  if (count === 0) return [128, 128, 128];
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

function triangleCentroid(p0: [number, number], p1: [number, number], p2: [number, number]): [number, number] {
  return [(p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3];
}

async function lowpoly(imageBytes: Uint8Array): Promise<string> {
  const img = sharp(imageBytes);
  const meta = await img.metadata();
  const maxDim = 800;
  const scale = Math.min(1, maxDim / Math.max(meta.width!, meta.height!));
  const w = Math.round(meta.width! * scale);
  const h = Math.round(meta.height! * scale);

  const { data, info } = await img.resize(w, h).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const channels = info.channels;

  const cols = 30;
  const rows = Math.round(cols * (h / w));
  const cellW = w / cols;
  const cellH = h / rows;

  const rng = () => Math.random();

  // Generate jittered grid points
  const points: [number, number][] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      let px = c * cellW;
      let py = r * cellH;
      if (r > 0 && r < rows && c > 0 && c < cols) {
        px += (rng() - 0.5) * cellW * 0.8;
        py += (rng() - 0.5) * cellH * 0.8;
      }
      points.push([Math.max(0, Math.min(w, px)), Math.max(0, Math.min(h, py))]);
    }
  }

  // Grid-based triangulation: each grid cell -> 2 triangles
  const polys: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tl = r * (cols + 1) + c;
      const tr = tl + 1;
      const bl = (r + 1) * (cols + 1) + c;
      const br = bl + 1;

      for (const [i0, i1, i2] of [[tl, tr, bl], [tr, br, bl]] as const) {
        const p0 = points[i0], p1 = points[i1], p2 = points[i2];
        const [cx, cy] = triangleCentroid(p0, p1, p2);
        const [cr, cg, cb] = sampleColor(pixels, w, h, channels, cx, cy, Math.min(cellW, cellH) * 0.3);
        polys.push(`<polygon points="${p0[0].toFixed(1)},${p0[1].toFixed(1)} ${p1[0].toFixed(1)},${p1[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}" fill="rgb(${cr},${cg},${cb})" stroke="rgb(${cr},${cg},${cb})" stroke-width="0.5"/>`);
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n${polys.join("\n")}\n</svg>`;
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
    if (!imgRes.ok) { console.error(`Failed to fetch image: HTTP ${imgRes.status}`); continue; }
    const imageBytes = new Uint8Array(await imgRes.arrayBuffer());

    const svg = await lowpoly(imageBytes);
    const svgBytes = new TextEncoder().encode(svg);
    const filename = `lowpoly-${post.cid}-${Date.now()}.svg`;
    const url = await uploadToR2(svgBytes, filename, "image/svg+xml");

    console.log(`cid=${post.cid}: uploaded ${url}`);
    await reply(auth, apiUrl, post.cid, url);
  }
}

main();
