import sharp from "sharp";

// Shared prelude for the sharp-backed image bots: decode, then scale the long edge to maxDim.
// Lives here, not in bots.ts, so the shared module never pulls in sharp.
export const fitSharp = async (bytes: Uint8Array, maxDim: number) => {
  const img = sharp(bytes);
  const meta = await img.metadata();
  const scale = Math.min(1, maxDim / Math.max(meta.width!, meta.height!));
  return { img, w: Math.round(meta.width! * scale), h: Math.round(meta.height! * scale) };
};
