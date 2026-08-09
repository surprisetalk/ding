import { type Api, imageMentionBot } from "../bots.ts";
import sharp from "sharp";
import { fitSharp } from "./images.ts";

const THRESHOLD = 60;

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

async function pixelsort(imageBytes: Uint8Array): Promise<Uint8Array> {
  const { img, w, h } = await fitSharp(imageBytes, 800);

  const { data } = await img.resize(w, h).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const sorted = new Uint8Array(pixels);

  for (let y = 0; y < h; y++) {
    let runStart = -1;
    for (let x = 0; x <= w; x++) {
      const i = (y * w + x) * 3;
      const bright = x < w ? luminance(pixels[i], pixels[i + 1], pixels[i + 2]) : 0;

      if (bright > THRESHOLD && runStart === -1)
        runStart = x;
      else if ((bright <= THRESHOLD || x === w) && runStart !== -1) {
        const run: { r: number; g: number; b: number; lum: number }[] = [];
        for (let rx = runStart; rx < x; rx++) {
          const ri = (y * w + rx) * 3;
          run.push({
            r: pixels[ri],
            g: pixels[ri + 1],
            b: pixels[ri + 2],
            lum: luminance(pixels[ri], pixels[ri + 1], pixels[ri + 2]),
          });
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

export default (api: Api) =>
  imageMentionBot(api, {
    transform: async (bytes) => ({ bytes: await pixelsort(bytes), ext: "png", contentType: "image/png" }),
  });
