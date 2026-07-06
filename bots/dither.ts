import { imageMentionBot } from "../bots.ts";
import sharp from "sharp";

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

imageMentionBot({
  envPrefix: "DITHER",
  transform: async (bytes, post) => {
    const braille = await toBraille(bytes);
    console.log(`cid=${post.cid}: ${braille.length} chars`);
    return braille;
  },
});
