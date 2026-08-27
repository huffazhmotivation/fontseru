import type { Point, VectorObject } from "@/types/geometry";
import { isFilledObject } from "@/types/geometry";
import { flattenContour } from "./objectOps";

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function objectBoundsFlat(obj: VectorObject): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of obj.contours) {
    for (const p of flattenContour(c, 12)) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const cross = (a: Point, b: Point, c: Point) => (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x);
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True if two closed polygons touch: one contains a vertex of the other,
 * or their edges actually cross (catches thin/partial overlaps where no
 * vertex happens to land inside the other shape). */
function polygonsOverlap(a: Point[], b: Point[]): boolean {
  for (const p of a) if (pointInPolygon(p, b)) return true;
  for (const p of b) if (pointInPolygon(p, a)) return true;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j], b2 = b[(j + 1) % b.length];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/**
 * Returns the ids of filled shapes that visually sit on top of another
 * filled shape beneath them (z-order = array order, later = on top). Only
 * the top shape of each overlapping pair is flagged, so the canvas can
 * recolor just that one to signal "something is stacked here" — geometry
 * is never touched, this is purely for the highlight.
 */
export function findOverlappingObjectIds(objects: VectorObject[]): Set<string> {
  const eligible = objects.filter((o) => isFilledObject(o) && o.contours.length > 0);
  if (eligible.length < 2) return new Set();

  const bounds = eligible.map(objectBoundsFlat);
  const polys = eligible.map((o) => o.contours.map((c) => flattenContour(c, 12)).filter((p) => p.length >= 3));

  const overlapping = new Set<string>();
  for (let i = 1; i < eligible.length; i++) {
    if (overlapping.has(eligible[i].id)) continue;
    for (let k = 0; k < i; k++) {
      if (!boundsOverlap(bounds[i], bounds[k])) continue;
      const hit = polys[i].some((pa) => polys[k].some((pb) => polygonsOverlap(pa, pb)));
      if (hit) {
        overlapping.add(eligible[i].id);
        break;
      }
    }
  }
  return overlapping;
}
