import type { Point } from "@/types/geometry";
import type { WorksheetFiducialSpec } from "@/worksheet/types";
import { labelComponents, otsuThreshold, toInkMask, type Component } from "./binaryOps";

export interface DetectedFiducial {
  id: 1 | 2 | 3 | 4;
  center: Point;
  sizePx: number;
}

const SQUARENESS_MIN = 0.55; // pixelCount / bboxArea — solid squares score high, glyph strokes score low.
const ASPECT_TOLERANCE = 1.6; // bboxW/bboxH (or inverse) must stay under this to count as "square-ish".

function isSquareish(c: Component): boolean {
  const w = c.maxX - c.minX + 1;
  const h = c.maxY - c.minY + 1;
  if (w < 6 || h < 6) return false; // too small to be a printed/photographed fiducial at any reasonable resolution.
  const aspect = w / h;
  if (aspect > ASPECT_TOLERANCE || aspect < 1 / ASPECT_TOLERANCE) return false;
  const fill = c.pixelCount / (w * h);
  return fill >= SQUARENESS_MIN;
}

/** Counts small enclosed white islands inside a dark component's bbox — the marker's inner "dot count" identifies which corner (1=TL..4=BL) it is, so orientation is resolved even from an upside-down or sideways photo, without any letter/shape recognition. */
function decodeInnerDotCount(mask: Uint8Array, width: number, height: number, c: Component): number {
  const x0 = Math.max(0, c.minX + 1);
  const y0 = Math.max(0, c.minY + 1);
  const x1 = Math.min(width - 1, c.maxX - 1);
  const y1 = Math.min(height - 1, c.maxY - 1);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w <= 2 || h <= 2) return 0;

  const sub = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // Invert: we want the *white* dots inside the black marker.
      sub[(y - y0) * w + (x - x0)] = mask[y * width + x] === 1 ? 0 : 1;
    }
  }
  const whiteComponents = labelComponents(sub, w, h, 1);
  const minDotArea = Math.max(1, Math.round((w * h) * 0.004));
  const maxDotArea = Math.round((w * h) * 0.18);
  let count = 0;
  for (const wc of whiteComponents) {
    if (wc.touchesBorder) continue; // dots must be fully enclosed by the black square, not the surrounding paper.
    if (wc.pixelCount < minDotArea || wc.pixelCount > maxDotArea) continue;
    count++;
  }
  return count;
}

/**
 * Finds 4 solid, square-ish, dot-coded marker blobs in a binarized photo
 * and resolves which physical corner (1..4) each one is via its decoded
 * dot count — never via geometric guessing, so a photo taken rotated or
 * upside-down still resolves correctly.
 */
export function detectFiducials(gray: Uint8ClampedArray, width: number, height: number): DetectedFiducial[] | null {
  const threshold = otsuThreshold(gray);
  const mask = toInkMask(gray, threshold);
  const components = labelComponents(mask, width, height, 1);

  const totalArea = width * height;
  const candidates = components.filter((c) => {
    if (c.touchesBorder) return false;
    const area = c.pixelCount;
    if (area < totalArea * 0.0004 || area > totalArea * 0.03) return false;
    return isSquareish(c);
  });
  if (candidates.length < 4) return null;

  const decoded: DetectedFiducial[] = [];
  const seenIds = new Set<number>();
  for (const c of candidates) {
    const dotCount = decodeInnerDotCount(mask, width, height, c);
    if (dotCount < 1 || dotCount > 4) continue;
    if (seenIds.has(dotCount)) continue; // ambiguous — a real fiducial's id must be unique on the page.
    seenIds.add(dotCount);
    decoded.push({
      id: dotCount as 1 | 2 | 3 | 4,
      center: { x: c.centroidX, y: c.centroidY },
      sizePx: Math.max(c.maxX - c.minX, c.maxY - c.minY) + 1,
    });
  }

  if (decoded.length !== 4) return null;
  decoded.sort((a, b) => a.id - b.id);
  return decoded;
}

/** Orders detected fiducials as [TL, TR, BR, BL] per the template's own corner id assignment. */
export function orderFiducialsForTemplate(
  detected: DetectedFiducial[],
  templateFiducials: readonly WorksheetFiducialSpec[]
): [Point, Point, Point, Point] | null {
  const byId = new Map(detected.map((d) => [d.id, d]));
  const corners: Point[] = [];
  // Template corner order is always TL(0,0) TR(1,0) BR(1,1) BL(0,1); we
  // find, for each of those, which fiducial *id* the template assigned to
  // that corner, then look up where that id was actually photographed.
  const cornerOrder: Array<{ x: number; y: number }> = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  for (const corner of cornerOrder) {
    const spec = templateFiducials.find((f) => Math.round(f.x) === corner.x && Math.round(f.y) === corner.y);
    if (!spec) return null;
    const found = byId.get(spec.id);
    if (!found) return null;
    corners.push(found.center);
  }
  return corners as [Point, Point, Point, Point];
}

/**
 * Decodes the "solid square + N enclosed dots" scheme from an arbitrary
 * already-cropped raster (used for the page-disambiguation marker — see
 * `WorksheetTemplate.pageMarker`). Same visual encoding as a corner
 * fiducial, just applied to a standalone crop instead of a component
 * found by scanning the whole page.
 */
export function decodeDotCountFromRaster(gray: Uint8ClampedArray, width: number, height: number): number {
  const threshold = otsuThreshold(gray);
  const mask = toInkMask(gray, threshold);
  const dark = labelComponents(mask, width, height, 1).filter((c) => !c.touchesBorder);
  if (dark.length === 0) return 0;
  // The marker square itself should be the single largest dark component in this tight crop.
  const square = dark.reduce((a, b) => (b.pixelCount > a.pixelCount ? b : a));
  return decodeInnerDotCount(mask, width, height, square);
}
