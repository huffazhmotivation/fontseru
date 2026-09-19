/**
 * Standalone from `trace/imageTrace.ts`'s `binarize` on purpose: that one
 * uses a user-controlled fixed threshold (appropriate for a clean
 * scan/drawing the user is actively tuning a slider for). Worksheet photos
 * arrive with uneven, unpredictable lighting and must binarize themselves
 * automatically before we can even detect the fiducials — hence Otsu's
 * method here instead of a fixed threshold.
 */
export function luminanceGrid(imgd: ImageData): Uint8ClampedArray {
  const { width, height, data } = imgd;
  const out = new Uint8ClampedArray(width * height);
  for (let p = 0, i = 0; p < data.length; p += 4, i++) {
    const a = data[p + 3];
    // Transparent pixels count as paper/background (white).
    const lum = a < 16 ? 255 : 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    out[i] = lum;
  }
  return out;
}

/** Otsu's method: finds the luminance threshold that best separates two populations (ink vs. paper) from the image's own histogram. */
export function otsuThreshold(gray: Uint8ClampedArray): number {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

/** Binary ink mask (1 = ink/dark, 0 = paper/light) from a grayscale grid and threshold. */
export function toInkMask(gray: Uint8ClampedArray, threshold: number): Uint8Array {
  const mask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) mask[i] = gray[i] < threshold ? 1 : 0;
  return mask;
}

export interface Component {
  pixelCount: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centroidX: number;
  centroidY: number;
  /** True if the component touches the image border (usually noise/edge artifacts, never a valid fiducial). */
  touchesBorder: boolean;
}

/**
 * 4-connected flood-fill labeling over a binary mask. Shared shape with
 * `trace/imageTrace.ts`'s `despeckleBinary` internals, but returns full
 * component stats (bbox, centroid) rather than just pruning small islands,
 * since fiducial/marker detection needs to reason about shape.
 */
export function labelComponents(mask: Uint8Array, width: number, height: number, wantValue: 0 | 1 = 1): Component[] {
  const total = width * height;
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  const components: Component[] = [];

  for (let start = 0; start < total; start++) {
    if (mask[start] !== wantValue || visited[start]) continue;
    let sp = 0;
    let count = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let sumX = 0, sumY = 0;
    let touchesBorder = false;
    stack[sp++] = start;
    visited[start] = 1;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width;
      const y = (p - x) / width;
      count++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      if (x > 0) { const n = p - 1; if (mask[n] === wantValue && !visited[n]) { visited[n] = 1; stack[sp++] = n; } }
      if (x < width - 1) { const n = p + 1; if (mask[n] === wantValue && !visited[n]) { visited[n] = 1; stack[sp++] = n; } }
      if (y > 0) { const n = p - width; if (mask[n] === wantValue && !visited[n]) { visited[n] = 1; stack[sp++] = n; } }
      if (y < height - 1) { const n = p + width; if (mask[n] === wantValue && !visited[n]) { visited[n] = 1; stack[sp++] = n; } }
    }
    components.push({
      pixelCount: count,
      minX, minY, maxX, maxY,
      centroidX: sumX / count,
      centroidY: sumY / count,
      touchesBorder,
    });
  }
  return components;
}

/** Bilinear-samples a source ImageData at fractional pixel coords; returns luminance 0-255 (255 = white/background outside bounds). */
export function bilinearLuminance(gray: Uint8ClampedArray, width: number, height: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 255;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const v00 = gray[y0 * width + x0];
  const v10 = gray[y0 * width + x1];
  const v01 = gray[y1 * width + x0];
  const v11 = gray[y1 * width + x1];
  const top = v00 * (1 - fx) + v10 * fx;
  const bottom = v01 * (1 - fx) + v11 * fx;
  return top * (1 - fy) + bottom * fy;
}
