import type { Point, PathNode, Contour, VectorObject } from "@/types/geometry";
import { isFilledObject } from "@/types/geometry";
import { flattenContour } from "./objectOps";
import { simplifyPolyline } from "@/utils/simplify";
import { shortId } from "@/utils/id";
import {
  union as clipUnion,
  intersection as clipIntersection,
  difference as clipDifference,
  xor as clipXor,
  type Polygon as ClipPolygon,
  type MultiPolygon as ClipMultiPolygon,
} from "@/vendor/polygonClipping";

export type BooleanOp = "union" | "subtract" | "intersect";

/** Only closed filled shapes can take part in a boolean operation. */
export function isBooleanEligible(obj: VectorObject): boolean {
  return isFilledObject(obj) && obj.contours.length > 0;
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

// Curve sampling density used before handing shapes to the exact clipper.
// Higher than a typical render-time flatten so round edges (circles, etc.)
// stay smooth through the boolean op instead of faceting.
const CLIP_SAMPLE_STEPS = 48;

function objectPolys(obj: VectorObject): Point[][] {
  return obj.contours.map((c) => flattenContour(c, CLIP_SAMPLE_STEPS)).filter((poly) => poly.length >= 3);
}

function toRing(pts: Point[]): [number, number][] {
  return pts.map((p) => [p.x, p.y]);
}

function ringToPoints(ring: [number, number][]): Point[] {
  const pts = ring.map(([x, y]) => ({ x, y }));
  // polygon-clipping always returns self-closing rings (first point repeated
  // at the end) — drop the duplicate so we don't create a zero-length
  // closing segment in the rebuilt contour.
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) pts.pop();
  }
  return pts;
}

/**
 * Resolves one object's own contours into a proper exterior/hole
 * MultiPolygon. XORing the individual contours together reproduces the
 * even-odd fill rule the rest of the app already uses for a single object's
 * overlapping contours (e.g. the counter of an "O"), while handing back
 * correctly paired, hole-aware polygons for the exact clip below.
 */
function objectToMultiPolygon(obj: VectorObject): ClipMultiPolygon {
  const polys = objectPolys(obj);
  if (polys.length === 0) return [];
  const rings: ClipPolygon[] = polys.map((p) => [toRing(p)]);
  if (rings.length === 1) return rings;
  try {
    return clipXor(rings[0], ...rings.slice(1));
  } catch {
    return rings;
  }
}

function polygonArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return a / 2;
}

// A ring straight off the clip boundary is a plain polygon — every point
// came from either a sampled curve or an exact intersection, with no bezier
// handles. This turns it back into a proper curve: points where the path
// barely turns get smooth Catmull-Rom-derived handles (so round edges stay
// round), while points with a sharp turn stay plain corner nodes with no
// handles (so rectangle corners etc. stay crisp instead of getting rounded
// off).
const CORNER_TURN_DEG = 28;

function ringToSmoothNodes(ring: Point[]): PathNode[] {
  const n = ring.length;
  if (n < 3) {
    return ring.map((p) => ({ id: shortId("node"), point: p, handleIn: null, handleOut: null, type: "corner" }));
  }
  return ring.map((p, i) => {
    const prev = ring[(i - 1 + n) % n];
    const next = ring[(i + 1) % n];
    const v1x = p.x - prev.x, v1y = p.y - prev.y;
    const v2x = next.x - p.x, v2y = next.y - p.y;
    const len1 = Math.hypot(v1x, v1y) || 1e-9;
    const len2 = Math.hypot(v2x, v2y) || 1e-9;
    const cosA = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / (len1 * len2)));
    const turnDeg = (Math.acos(cosA) * 180) / Math.PI;

    if (turnDeg > CORNER_TURN_DEG) {
      return { id: shortId("node"), point: p, handleIn: null, handleOut: null, type: "corner" as const };
    }

    // Standard 1/6 Catmull-Rom-to-Bezier tangent, clamped to half the
    // shorter neighboring segment so handles never overshoot on uneven
    // point spacing.
    let hx = (next.x - prev.x) / 6;
    let hy = (next.y - prev.y) / 6;
    const maxLen = Math.min(len1, len2) * 0.5;
    const hLen = Math.hypot(hx, hy) || 1e-9;
    if (hLen > maxLen) {
      const scale = maxLen / hLen;
      hx *= scale;
      hy *= scale;
    }
    return {
      id: shortId("node"),
      point: p,
      handleIn: { x: p.x - hx, y: p.y - hy },
      handleOut: { x: p.x + hx, y: p.y + hy },
      type: "smooth" as const,
    };
  });
}

// Cleans up the dense point cloud left over from curve sampling, so a
// clipped circle ends up with a handful of nodes again instead of one node
// per sample step. The tolerance scales with each ring's own size (a small
// dot and a large bowl need different amounts of simplification) — too
// small and round edges keep almost every sampled point (lots of nodes,
// visually fine but heavy to edit); too large and small or detailed shapes
// lose their form. Clamped to a sane range either way.
function ringSimplifyTolerance(ring: Point[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  return Math.min(10, Math.max(1.25, diag * 0.012));
}

/**
 * Applies a boolean op to 2+ eligible objects (in z-order, back-to-front).
 * Shapes are flattened to polygons, combined with the `polygon-clipping`
 * library (exact Martinez-Rueda-Feito clipping, not a raster approximation),
 * and the resulting rings are rebuilt into simplified, correctly-nested
 * closed contours with smooth handles refitted from local curvature. Returns
 * null when fewer than 2 eligible objects are given or the result is empty.
 */
export function applyBooleanOp(objectsInZOrder: VectorObject[], op: BooleanOp): VectorObject | null {
  const eligible = objectsInZOrder.filter(isBooleanEligible);
  if (eligible.length < 2) return null;

  const multiPolys = eligible.map(objectToMultiPolygon).filter((mp) => mp.length > 0);
  if (multiPolys.length < 2) return null;

  let resultMulti: ClipMultiPolygon;
  try {
    if (op === "union") {
      resultMulti = clipUnion(multiPolys[0], ...multiPolys.slice(1));
    } else if (op === "intersect") {
      resultMulti = clipIntersection(multiPolys[0], ...multiPolys.slice(1));
    } else {
      // subtract: front-most (last in z-order) object cut away from the
      // union of the rest.
      const front = multiPolys[multiPolys.length - 1];
      const back = multiPolys.slice(0, -1);
      const backCombined = back.length > 1 ? clipUnion(back[0], ...back.slice(1)) : back[0];
      resultMulti = clipDifference(backCombined, front);
    }
  } catch {
    return null;
  }

  if (!resultMulti || resultMulti.length === 0) return null;

  const rings: Point[][] = [];
  for (const poly of resultMulti) {
    for (const ring of poly) {
      const pts = ringToPoints(ring);
      if (pts.length >= 3) rings.push(pts);
    }
  }
  if (rings.length === 0) return null;

  // Nesting depth via containment against the other rings' first point —
  // still needed because a single result can contain several disjoint
  // exterior shapes plus their own holes.
  const depths = rings.map((ring, idx) => {
    let depth = 0;
    for (let k = 0; k < rings.length; k++) {
      if (k === idx) continue;
      if (pointInPolygon(ring[0], rings[k])) depth++;
    }
    return depth;
  });

  const contours: Contour[] = rings.map((ring, idx) => {
    const wantPositive = depths[idx] % 2 === 0;
    const area = polygonArea(ring);
    const oriented = (area > 0) === wantPositive ? ring : [...ring].reverse();
    const simplified = simplifyPolyline(oriented, ringSimplifyTolerance(oriented));
    const nodes: PathNode[] = ringToSmoothNodes(simplified);
    return { id: shortId("contour"), nodes, closed: true };
  });

  return { id: shortId("obj"), kind: "shape", contours };
}
