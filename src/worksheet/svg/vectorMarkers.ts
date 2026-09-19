import type { Point } from "@/types/geometry";
import { isNearBlack, isNearWhiteOrNone } from "./color";
import type { SvgShape, SvgShapeBounds } from "./collectShapes";

export interface DetectedVectorMarker {
  id: number;
  center: Point;
  bounds: SvgShapeBounds;
}

function center(b: SvgShapeBounds): Point {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}
function area(b: SvgShapeBounds): number {
  return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
}

/**
 * Finds every solid near-black square-ish shape paired with 1-4 small
 * near-white shapes fully inside it — the same "square + N enclosed
 * dots" scheme used for the printed/photographed fiducials, just read
 * straight from vector geometry (exact, no thresholding needed) instead
 * of pixels. Returns every match found; callers separate the 4 page
 * corners from an optional extra page-disambiguation marker by position
 * (see `pickCornerMarkers` in `detectSvgWorksheet.ts`).
 */
export function detectVectorMarkers(shapes: SvgShape[]): DetectedVectorMarker[] {
  const darkRects = shapes.filter((s) => (s.tag === "rect" || s.tag === "path") && isNearBlack(s.fill));
  const lightSmall = shapes.filter((s) => isNearWhiteOrNone(s.fill));

  const markers: DetectedVectorMarker[] = [];
  for (const dark of darkRects) {
    const w = dark.bounds.maxX - dark.bounds.minX;
    const h = dark.bounds.maxY - dark.bounds.minY;
    if (w <= 0 || h <= 0) continue;
    const aspect = w / h;
    if (aspect > 1.6 || aspect < 1 / 1.6) continue;

    let dotCount = 0;
    for (const dot of lightSmall) {
      if (dot === dark) continue;
      const c = center(dot.bounds);
      if (c.x < dark.bounds.minX || c.x > dark.bounds.maxX || c.y < dark.bounds.minY || c.y > dark.bounds.maxY) continue;
      const dotArea = area(dot.bounds);
      const darkArea = area(dark.bounds);
      if (dotArea > 0 && dotArea < darkArea * 0.3) dotCount++;
    }
    if (dotCount >= 1 && dotCount <= 4) {
      markers.push({ id: dotCount, center: center(dark.bounds), bounds: dark.bounds });
    }
  }
  return markers;
}

/**
 * Separates the 4 page-corner fiducials from any other detected markers.
 * Corners are, by construction, the points farthest from the overall
 * marker centroid (anything else — like the page-disambiguation marker —
 * sits closer to the middle of the page). Requires the 4 farthest points
 * to carry 4 distinct ids (1-4); if they don't, this isn't a confident
 * enough match and the caller should treat the file as not a worksheet.
 */
export function pickCornerMarkers(markers: DetectedVectorMarker[]): DetectedVectorMarker[] | null {
  if (markers.length < 4) return null;
  const cx = markers.reduce((s, m) => s + m.center.x, 0) / markers.length;
  const cy = markers.reduce((s, m) => s + m.center.y, 0) / markers.length;
  const sorted = [...markers].sort((a, b) => {
    const da = Math.hypot(a.center.x - cx, a.center.y - cy);
    const db = Math.hypot(b.center.x - cx, b.center.y - cy);
    return db - da;
  });
  const corners = sorted.slice(0, 4);
  const ids = new Set(corners.map((c) => c.id));
  if (ids.size !== 4) return null;
  return corners;
}
