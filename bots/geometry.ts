import { botInit, getLastPostAge, post, seededRng, todaySeed, uploadToR2 } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("GEOMETRY");

const W = 256, H = 256;
const PALETTE_SIZE = 16;

function makePalette(rng: () => number): number[][] {
  const palette: number[][] = [[0, 0, 0]];
  for (let i = 1; i < PALETTE_SIZE; i++) {
    palette.push([
      Math.floor(rng() * 256),
      Math.floor(rng() * 256),
      Math.floor(rng() * 256),
    ]);
  }
  return palette;
}

function concentricCircles(frame: number, totalFrames: number, rng: () => number): Uint8Array {
  const pixels = new Uint8Array(W * H);
  const cx = W / 2, cy = H / 2;
  const phase = (frame / totalFrames) * Math.PI * 2;
  const spacing = 8 + Math.floor(rng() * 12);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const ring = Math.floor((d + phase * spacing) / spacing);
      pixels[y * W + x] = (ring % (PALETTE_SIZE - 1)) + 1;
    }
  }
  return pixels;
}

function rotatingPolygon(frame: number, totalFrames: number, rng: () => number): Uint8Array {
  const pixels = new Uint8Array(W * H);
  const cx = W / 2, cy = H / 2;
  const sides = 3 + Math.floor(rng() * 5);
  const angle = (frame / totalFrames) * Math.PI * 2;
  const radius = 80 + Math.floor(rng() * 30);
  const verts: [number, number][] = [];
  for (let i = 0; i < sides; i++) {
    const a = angle + (i / sides) * Math.PI * 2;
    verts.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let inside = false;
      for (let i = 0, j = sides - 1; i < sides; j = i++) {
        const [xi, yi] = verts[i], [xj, yj] = verts[j];
        if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
          inside = !inside;
      }
      if (inside) {
        const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        pixels[y * W + x] = (Math.floor(d / 10) % (PALETTE_SIZE - 1)) + 1;
      }
    }
  }
  return pixels;
}

function spiral(frame: number, totalFrames: number, rng: () => number): Uint8Array {
  const pixels = new Uint8Array(W * H);
  const cx = W / 2, cy = H / 2;
  const phase = (frame / totalFrames) * Math.PI * 2;
  const arms = 2 + Math.floor(rng() * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = Math.atan2(dy, dx) + phase;
      const v = Math.floor((a * arms / (Math.PI * 2) + d / 15) * 2) % PALETTE_SIZE;
      pixels[y * W + x] = ((v % (PALETTE_SIZE - 1)) + PALETTE_SIZE) % (PALETTE_SIZE - 1) + 1;
    }
  }
  return pixels;
}

function checkerboard(frame: number, totalFrames: number, rng: () => number): Uint8Array {
  const pixels = new Uint8Array(W * H);
  const size = 16 + Math.floor(rng() * 16);
  const offset = Math.floor((frame / totalFrames) * size);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = Math.floor((x + offset) / size);
      const cy = Math.floor((y + offset) / size);
      pixels[y * W + x] = ((cx + cy) % 2 === 0) ? 1 : (((cx * 3 + cy * 7) % (PALETTE_SIZE - 1)) + 1);
    }
  }
  return pixels;
}

function moire(frame: number, totalFrames: number, rng: () => number): Uint8Array {
  const pixels = new Uint8Array(W * H);
  const phase = (frame / totalFrames) * Math.PI * 2;
  const freq = 0.05 + rng() * 0.05;
  const cx1 = W / 2, cy1 = H / 2;
  const cx2 = W / 2 + Math.cos(phase) * 40, cy2 = H / 2 + Math.sin(phase) * 40;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d1 = Math.sqrt((x - cx1) ** 2 + (y - cy1) ** 2);
      const d2 = Math.sqrt((x - cx2) ** 2 + (y - cy2) ** 2);
      const v = Math.sin(d1 * freq) + Math.sin(d2 * freq);
      const idx = Math.floor(((v + 2) / 4) * (PALETTE_SIZE - 1)) + 1;
      pixels[y * W + x] = Math.min(PALETTE_SIZE - 1, Math.max(1, idx));
    }
  }
  return pixels;
}

const PATTERNS = [concentricCircles, rotatingPolygon, spiral, checkerboard, moire];

function lzwCompress(pixels: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const output: number[] = [];

  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  const table = new Map<string, number>();

  function initTable() {
    table.clear();
    for (let i = 0; i < clearCode; i++) table.set(String(i), i);
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  }

  let bitBuffer = 0;
  let bitCount = 0;
  const bytes: number[] = [];

  function writeBits(code: number, size: number) {
    bitBuffer |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  }

  initTable();
  writeBits(clearCode, codeSize);

  let current = String(pixels[0]);
  for (let i = 1; i < pixels.length; i++) {
    const next = current + "," + pixels[i];
    if (table.has(next))
      current = next;
    else {
      writeBits(table.get(current)!, codeSize);
      if (nextCode < 4096) {
        table.set(next, nextCode++);
        if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        writeBits(clearCode, codeSize);
        initTable();
      }
      current = String(pixels[i]);
    }
  }

  writeBits(table.get(current)!, codeSize);
  writeBits(eoiCode, codeSize);
  if (bitCount > 0) bytes.push(bitBuffer & 0xff);

  const subBlocked: number[] = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    subBlocked.push(chunk.length, ...chunk);
  }
  subBlocked.push(0);

  output.push(minCodeSize, ...subBlocked);
  return new Uint8Array(output);
}

function encodeGif(frames: Uint8Array[], palette: number[][], delayCs: number): Uint8Array {
  const parts: number[] = [];

  parts.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // GIF89a

  // Logical Screen Descriptor
  parts.push(W & 0xff, W >> 8, H & 0xff, H >> 8);
  const palBits = Math.ceil(Math.log2(PALETTE_SIZE)) - 1;
  parts.push(0x80 | (palBits << 4) | palBits); // packed: GCT flag, color res, sort=0, GCT size
  parts.push(0); // bg color
  parts.push(0); // pixel aspect

  // Global Color Table
  for (let i = 0; i < (1 << (palBits + 1)); i++) {
    const c = palette[i] || [0, 0, 0];
    parts.push(c[0], c[1], c[2]);
  }

  // NETSCAPE2.0 Application Extension (loop forever)
  parts.push(0x21, 0xff, 0x0b);
  const ns = "NETSCAPE2.0";
  for (let i = 0; i < 11; i++) parts.push(ns.charCodeAt(i));
  parts.push(0x03, 0x01, 0x00, 0x00, 0x00); // sub-block: loop count = 0

  const minCodeSize = palBits + 1;
  for (const frame of frames) {
    // Graphic Control Extension
    parts.push(0x21, 0xf9, 0x04);
    parts.push(0x04); // disposal: restore to bg, no transparency
    parts.push(delayCs & 0xff, (delayCs >> 8) & 0xff); // delay
    parts.push(0x00); // transparent color index (unused)
    parts.push(0x00); // block terminator

    // Image Descriptor
    parts.push(0x2c);
    parts.push(0, 0, 0, 0); // left, top
    parts.push(W & 0xff, W >> 8, H & 0xff, H >> 8);
    parts.push(0x00); // packed: no local color table

    const compressed = lzwCompress(frame, minCodeSize);
    for (let i = 0; i < compressed.length; i++) parts.push(compressed[i]);
  }

  parts.push(0x3b); // Trailer
  return new Uint8Array(parts);
}

async function main() {
  const ageMs = await getLastPostAge(auth, botUsername, apiUrl);
  if (ageMs / 3_600_000 < 20) {
    console.log("Too soon, skipping");
    return;
  }

  const seed = todaySeed();
  const rng = seededRng(seed);
  const patternFn = PATTERNS[seed % PATTERNS.length];
  const palette = makePalette(rng);
  const frameCount = 8 + Math.floor(rng() * 9);

  const frames: Uint8Array[] = [];
  for (let f = 0; f < frameCount; f++)
    frames.push(patternFn(f, frameCount, seededRng(seed)));

  const gif = encodeGif(frames, palette, 10);
  const date = new Date().toISOString().slice(0, 10);
  const r2Url = await uploadToR2(gif, `geometry-${date}.gif`, "image/gif");

  console.log(`Posting: ${r2Url}`);
  const ok = await post(auth, apiUrl, r2Url, "#art #geometry #bot");
  if (!ok) Deno.exit(1);
  console.log("Posted!");
}

main();
