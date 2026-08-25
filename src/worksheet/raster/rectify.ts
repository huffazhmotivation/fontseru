import type { Point } from "@/types/geometry";
import { bilinearLuminance } from "./binaryOps";

/**
 * Renders a `[u0,v0]..[u1,v1]` rectangle of template-normalized page space
 * (as produced by `squareToQuad`'s inverse use — see caller) into a fixed
 * `outSize x outSize` grayscale raster, by inverse-mapping every
 * destination pixel through the page transform and bilinear-sampling the
 * source photo. This is what turns an arbitrarily rotated/scaled/
 * mild-perspective photo into a clean, axis-aligned raster per cell —
 * everything downstream (Otsu threshold, despeckle, imagetracer) then
 * operates on a normal-looking little bitmap exactly like a manually
 * cropped Trace Image upload would.
 */
export function rectifyRegionToGray(
  sourceGray: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  pageToSource: (u: number, v: number) => Point,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  outSize: number
): { gray: Uint8ClampedArray; width: number; height: number } {
  const out = new Uint8ClampedArray(outSize * outSize);
  for (let py = 0; py < outSize; py++) {
    const v = v0 + ((py + 0.5) / outSize) * (v1 - v0);
    for (let px = 0; px < outSize; px++) {
      const u = u0 + ((px + 0.5) / outSize) * (u1 - u0);
      const src = pageToSource(u, v);
      out[py * outSize + px] = bilinearLuminance(sourceGray, sourceWidth, sourceHeight, src.x, src.y);
    }
  }
  return { gray: out, width: outSize, height: outSize };
}

/** Wraps a grayscale raster into a proper black/white RGBA ImageData, ready for `despeckleBinary` + `traceBinaryImage` from `trace/imageTrace.ts` (both expect that exact pre-binarized RGBA shape). */
export function grayToBinaryImageData(gray: Uint8ClampedArray, width: number, height: number, threshold: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gray.length; i++) {
    const ink = gray[i] < threshold;
    const o = i * 4;
    const v = ink ? 0 : 255;
    data[o] = v;
    data[o + 1] = v;
    data[o + 2] = v;
    data[o + 3] = 255;
  }
  return new ImageData(data, width, height);
}

/**
 * Forces a `bandPx`-wide strip around the very edge of a binarized raster
 * back to background (white). Second line of defense after the writing
 * box's own inset crop (see `raster/detectRasterWorksheet.ts`): if the
 * printed guide border, a neighboring cell's ink, or a crop-edge artifact
 * still reaches the very edge of the raster, it's cleared here before
 * despeckle/trace ever sees it, so it can never end up as part of the
 * traced glyph shape.
 */
export function clearBinaryImageDataBorder(imgd: ImageData, bandPx: number): void {
  const { width, height, data } = imgd;
  const band = Math.max(0, Math.min(bandPx, Math.floor(Math.min(width, height) / 2)));
  if (band === 0) return;
  const setWhite = (x: number, y: number) => {
    const o = (y * width + x) * 4;
    data[o] = 255;
    data[o + 1] = 255;
    data[o + 2] = 255;
    data[o + 3] = 255;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < band; x++) setWhite(x, y);
    for (let x = width - band; x < width; x++) setWhite(x, y);
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < band; y++) setWhite(x, y);
    for (let y = height - band; y < height; y++) setWhite(x, y);
  }
}
