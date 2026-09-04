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
// handles (so rectangle corners, and the real cut edge the boolean op just
// made, stay crisp instead of getting rounded off).
const CORNER_TURN_DEG = 28;

function turnAngleDeg(prev: Point, p: Point, next: Point): number {
  const v1x = p.x - prev.x, v1y = p.y - prev.y;
  const v2x = next.x - p.x, v2y = next.y - p.y;
  const len1 = Math.hypot(v1x, v1y) || 1e-9;
  const len2 = Math.hypot(v2x, v2y) || 1e-9;
  const cosA = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / (len1 * len2)));
  return (Math.acos(cosA) * 180) / Math.PI;
}

/**
 * Simplifies a clipped ring down to a sparse point set WITHOUT letting the
 * simplification itself invent fake corners on curves the boolean op never
 * actually touched.
 *
 * Bug this fixes: the previous code ran `simplifyPolyline` (Ramer–Douglas–
 * Peucker) over the whole ring FIRST, then measured the turn angle between
 * whatever points survived to decide corner vs. smooth. RDP is free to drop
 * a long run of points along a shallow, perfectly smooth curve (that's the
 * point of simplifying) — but once those in-between points are gone, the
 * turn angle between the two remaining neighbors on that same curve can
 * easily exceed CORNER_TURN_DEG, even though the original curve never had
 * a sharp turn anywhere. That's exactly what made an untouched round edge
 * come out of Subtract as hard, faceted corners: the corner test was being
 * run on already-decimated points instead of the real curve.
 *
 * Fix: classify corner vs. smooth FIRST, on the dense ring straight out of
 * curve sampling (CLIP_SAMPLE_STEPS points per original curve segment —
 * fine-grained enough that the turn angle reflects the actual local
 * curvature, not simplification artifacts). Only genuinely sharp turns —
 * which is exactly where the front shape's edge actually cut into the back
 * shape, plus any real corners the original shapes already had — become
 * fixed corner points. Then simplification runs separately WITHIN each
 * corner-to-corner run, with both endpoints of every run pinned, so a
 * curve you never touched keeps exactly the smooth classification (and
 * shape) it had before the boolean op, while the new cut edge still reads
 * as the crisp corner it geometrically is.
 */
function simplifyRingPreservingCorners(ring: Point[], epsilon: number): { points: Point[]; isCorner: boolean[] } {
  const n = ring.length;
  if (n < 4) return { points: ring, isCorner: ring.map(() => true) };

  const cornerIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const next = ring[(i + 1) % n];
    if (turnAngleDeg(prev, ring[i], next) > CORNER_TURN_DEG) cornerIdx.push(i);
  }

  if (cornerIdx.length === 0) {
    // No sharp turns anywhere (e.g. a circle/blob untouched by the cut) —
    // simplify the whole loop as one run, all points stay "smooth".
    const simplified = simplifyPolyline(ring, epsilon);
    return { points: simplified, isCorner: simplified.map(() => false) };
  }

  const outPoints: Point[] = [];
  const outCorner: boolean[] = [];
  for (let k = 0; k < cornerIdx.length; k++) {
    const startIdx = cornerIdx[k];
    const endIdx = cornerIdx[(k + 1) % cornerIdx.length];
    const run: Point[] = [];
    for (let i = startIdx; ; i = (i + 1) % n) {
      run.push(ring[i]);
      if (i === endIdx) break;
    }
    const simplifiedRun = run.length > 2 ? simplifyPolyline(run, epsilon) : run;
    // Drop the run's last point (it's the NEXT corner, appended as that
    // corner's own run start instead) so it isn't duplicated in the output.
    for (let j = 0; j < simplifiedRun.length - 1; j++) {
      outPoints.push(simplifiedRun[j]);
      outCorner.push(j === 0);
    }
  }
  return { points: outPoints, isCorner: outCorner };
}

function ringToSmoothNodes(points: Point[], isCorner: boolean[]): PathNode[] {
  const n = points.length;
  if (n < 3) {
    return points.map((p) => ({ id: shortId("node"), point: p, handleIn: null, handleOut: null, type: "corner" }));
  }
  return points.map((p, i) => {
    if (isCorner[i]) {
      return { id: shortId("node"), point: p, handleIn: null, handleOut: null, type: "corner" as const };
    }
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const len1 = Math.hypot(p.x - prev.x, p.y - prev.y) || 1e-9;
    const len2 = Math.hypot(next.x - p.x, next.y - p.y) || 1e-9;

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
    const { points, isCorner } = simplifyRingPreservingCorners(oriented, ringSimplifyTolerance(oriented));
    const nodes: PathNode[] = ringToSmoothNodes(points, isCorner);
    return { id: shortId("contour"), nodes, closed: true };
  });

  return { id: shortId("obj"), kind: "shape", contours };
}
