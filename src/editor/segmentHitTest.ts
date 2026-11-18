import type { GlyphOutline, Point } from "@/types/geometry";
import { closestPointOnCubic, closestPointOnLine } from "./bezier";

export interface SegmentHit {
  contourId: string;
  fromIndex: number;
  t: number;
  point: Point;
  distance: number;
}

export function hitTestSegments(outline: GlyphOutline, target: Point, radius: number): SegmentHit | null {
  let best: SegmentHit | null = null;

  for (const obj of outline.objects) {
    for (const contour of obj.contours) {
      const n = contour.nodes.length;
      const segmentCount = contour.closed ? n : n - 1;
      for (let i = 0; i < segmentCount; i++) {
        const from = contour.nodes[i];
        const to = contour.nodes[(i + 1) % n];
        const isCurve = Boolean(from.handleOut || to.handleIn);
        // Quick reject: a segment lies inside the box of its control points,
        // so skip the exact closest-point search when the target is farther
        // than the current best radius from that box. Keeps hover hit tests
        // cheap on outlines with thousands of nodes.
        const r = best ? best.distance : radius;
        const c1 = from.handleOut ?? from.point, c2 = to.handleIn ?? to.point;
        if (
          target.x < Math.min(from.point.x, c1.x, c2.x, to.point.x) - r ||
          target.x > Math.max(from.point.x, c1.x, c2.x, to.point.x) + r ||
          target.y < Math.min(from.point.y, c1.y, c2.y, to.point.y) - r ||
          target.y > Math.max(from.point.y, c1.y, c2.y, to.point.y) + r
        ) continue;
        const result = isCurve
          ? closestPointOnCubic(from.point, from.handleOut ?? from.point, to.handleIn ?? to.point, to.point, target)
          : closestPointOnLine(from.point, to.point, target);

        if (result.distance <= radius && (!best || result.distance < best.distance)) {
          best = { contourId: contour.id, fromIndex: i, t: result.t, point: result.point, distance: result.distance };
        }
      }
    }
  }
  return best;
}
