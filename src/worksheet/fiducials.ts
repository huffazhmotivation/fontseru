import type { TemplatePoint } from "./types";

export interface FiducialCandidate {
  center: TemplatePoint;
  /** Bounding box side length (px, in the image this was detected on). */
  size: number;
}

const INK_THRESHOLD = 130;

/** Grayscale + fixed threshold -> boolean ink grid. Deliberately simple/fixed (not adaptive) since fiducials are printed solid black on white paper — high, reliable contrast even under uneven scan/photo lighting in practice; the confidence check in detectRasterWorksheet.ts is what actually guards against false positives, not this threshold. */
function toInkGrid(imgd: ImageData): Uint8Array {
  const { data, width, height } = imgd;
  const grid = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < data.length; p += 4, i++) {
    const lum = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    grid[i] = data[p + 3] > 32 && lum < INK_THRESHOLD ? 1 : 0;
  }
  return grid;
}

/** Iterative (non-recursive) 4-connectivity flood fill labeling, returning each ink component's pixel bounding box + pixel count. */
function findInkComponents(grid: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(width * height);
  const components: { minX: number; minY: number; maxX: number; maxY: number; area: number }[] = [];
  const stack: number[] = [];

  for (let start = 0; start < grid.length; start++) {
    if (!grid[start] || visited[start]) continue;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    let minX = width, minY = height, maxX = 0, maxY = 0, area = 0;

    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % width;
      const y = (idx / width) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0 && grid[idx - 1] && !visited[idx - 1]) { visited[idx - 1] = 1; stack.push(idx - 1); }
      if (x < width - 1 && grid[idx + 1] && !visited[idx + 1]) { visited[idx + 1] = 1; stack.push(idx + 1); }
      if (y > 0 && grid[idx - width] && !visited[idx - width]) { visited[idx - width] = 1; stack.push(idx - width); }
      if (y < height - 1 && grid[idx + width] && !visited[idx + width]) { visited[idx + width] = 1; stack.push(idx + width); }
    }
    components.push({ minX, minY, maxX, maxY, area });
  }
  return components;
}

/** Fraction of ink pixels sampled around the ring roughly 65-90% out from center to corner of `box` — the fiducial's design (solid outer square, white ring, black center dot) makes this near 0 for a genuine fiducial and near 1 for a plain solid blob (e.g. a filled-in letter like "O" or a photo shadow). */
function ringInkFraction(grid: Uint8Array, width: number, height: number, box: { minX: number; minY: number; maxX: number; maxY: number }): number {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const halfW = (box.maxX - box.minX) / 2;
  const halfH = (box.maxY - box.minY) / 2;
  let inkCount = 0;
  let total = 0;
  const samples = 24;
  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * Math.PI * 2;
    for (const r of [0.7, 0.8]) {
      const x = Math.round(cx + Math.cos(angle) * halfW * r);
      const y = Math.round(cy + Math.sin(angle) * halfH * r);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      total++;
      if (grid[y * width + x]) inkCount++;
    }
  }
  return total === 0 ? 1 : inkCount / total;
}

/** Ink fraction at the very center — should be near 1 for a genuine fiducial (the printed center dot). */
function centerInkFraction(grid: Uint8Array, width: number, height: number, box: { minX: number; minY: number; maxX: number; maxY: number }): number {
  const cx = Math.round((box.minX + box.maxX) / 2);
  const cy = Math.round((box.minY + box.maxY) / 2);
  const r = Math.max(1, Math.round(Math.min(box.maxX - box.minX, box.maxY - box.minY) * 0.08));
  let inkCount = 0;
  let total = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      total++;
      if (grid[y * width + x]) inkCount++;
    }
  }
  return total === 0 ? 0 : inkCount / total;
}

/**
 * Finds candidate bullseye fiducial markers (solid black square, white
 * ring, black center dot — see fontseruClassicA4.ts) in a binarized image.
 * Deliberately geometry-only: square-ish aspect ratio, mostly-filled outer
 * blob, light ring, dark center. No text/character recognition anywhere in
 * this path.
 */
export function findFiducialCandidates(imgd: ImageData): FiducialCandidate[] {
  const { width, height } = imgd;
  const grid = toInkGrid(imgd);
  const components = findInkComponents(grid, width, height);

  const minSide = Math.min(width, height) * 0.015;
  const maxSide = Math.min(width, height) * 0.12;

  const candidates: FiducialCandidate[] = [];
  for (const box of components) {
    const w = box.maxX - box.minX + 1;
    const h = box.maxY - box.minY + 1;
    if (w < minSide || h < minSide || w > maxSide || h > maxSide) continue;
    const aspect = w / h;
    if (aspect < 0.75 || aspect > 1.33) continue;
    const bboxArea = w * h;
    const fillRatio = box.area / bboxArea;
    if (fillRatio < 0.45) continue; // outer ring alone (not the solid corners+dot) won't fill enough of the bbox

    const ring = ringInkFraction(grid, width, height, box);
    const center = centerInkFraction(grid, width, height, box);
    if (ring > 0.3) continue; // ring should be mostly white
    if (center < 0.5) continue; // center dot should be mostly black

    candidates.push({ center: { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }, size: (w + h) / 2 });
  }
  return candidates;
}

/**
 * Picks the 4 extreme candidates that best form the page's outer corners
 * and labels them TL/TR/BL/BR, tolerant of light rotation/perspective
 * (score-based extremes rather than requiring an exact right angle) and of
 * extra false-positive candidates elsewhere in the image (only the 4 most
 * extreme ones are used). Returns null if fewer than 4 distinct candidates
 * are available.
 */
export function pickPageCorners(candidates: FiducialCandidate[]): { tl: TemplatePoint; tr: TemplatePoint; bl: TemplatePoint; br: TemplatePoint } | null {
  if (candidates.length < 4) return null;

  const bySum = [...candidates].sort((a, b) => a.center.x + a.center.y - (b.center.x + b.center.y));
  const byDiff = [...candidates].sort((a, b) => a.center.x - a.center.y - (b.center.x - b.center.y));

  const tl = bySum[0].center;
  const br = bySum[bySum.length - 1].center;
  const tr = byDiff[byDiff.length - 1].center;
  const bl = byDiff[0].center;

  // Reject degenerate picks (e.g. two corners resolving to the same candidate).
  const pts = [tl, tr, bl, br];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x;
      const dy = pts[i].y - pts[j].y;
      if (Math.sqrt(dx * dx + dy * dy) < 4) return null;
    }
  }

  return { tl, tr, bl, br };
}
