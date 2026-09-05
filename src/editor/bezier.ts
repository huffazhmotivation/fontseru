import type { Point } from "@/types/geometry";
import { add, scale, subtract, length } from "@/utils/geometry";

function lerp(a: Point, b: Point, t: number): Point {
  return add(a, scale(subtract(b, a), t));
}

/** Evaluates a cubic Bézier (p0..p3) at parameter t in [0,1]. */
export function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const a = lerp(p0, p1, t);
  const b = lerp(p1, p2, t);
  const c = lerp(p2, p3, t);
  const d = lerp(a, b, t);
  const e = lerp(b, c, t);
  return lerp(d, e, t);
}

/** Tangent direction (not normalized to unit length beyond the derivative scale) at t. */
export function cubicTangent(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x:
      3 * mt * mt * (p1.x - p0.x) +
      6 * mt * t * (p2.x - p1.x) +
      3 * t * t * (p3.x - p2.x),
    y:
      3 * mt * mt * (p1.y - p0.y) +
      6 * mt * t * (p2.y - p1.y) +
      3 * t * t * (p3.y - p2.y),
  };
}

export interface CubicSplit {
  left: [Point, Point, Point, Point];
  right: [Point, Point, Point, Point];
}

/** De Casteljau subdivision — splits one cubic into two cubics at t, exactly preserving shape. */
export function splitCubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): CubicSplit {
  const p01 = lerp(p0, p1, t);
  const p12 = lerp(p1, p2, t);
  const p23 = lerp(p2, p3, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const p0123 = lerp(p012, p123, t);
  return {
    left: [p0, p01, p012, p0123],
    right: [p0123, p123, p23, p3],
  };
}

/**
 * Approximates the closest point on a cubic Bézier to `target` by sampling,
 * then refining around the best sample. Good enough for interactive
 * "click near this segment" hit-testing; not a general-purpose root-finder.
 */
export function closestPointOnCubic(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  target: Point,
  samples = 24
): { t: number; point: Point; distance: number } {
  let bestT = 0;
  let bestPoint = p0;
  let bestDist = length(subtract(p0, target));

  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const pt = cubicPoint(p0, p1, p2, p3, t);
    const d = length(subtract(pt, target));
    if (d < bestDist) {
      bestDist = d;
      bestT = t;
      bestPoint = pt;
    }
  }

  // One pass of local refinement around the best coarse sample.
  const step = 1 / samples;
  let lo = Math.max(0, bestT - step);
  let hi = Math.min(1, bestT + step);
  for (let iter = 0; iter < 6; iter++) {
    const midA = lo + (hi - lo) / 3;
    const midB = hi - (hi - lo) / 3;
    const da = length(subtract(cubicPoint(p0, p1, p2, p3, midA), target));
    const db = length(subtract(cubicPoint(p0, p1, p2, p3, midB), target));
    if (da < db) hi = midB;
    else lo = midA;
  }
  const refinedT = (lo + hi) / 2;
  const refinedPoint = cubicPoint(p0, p1, p2, p3, refinedT);
  const refinedDist = length(subtract(refinedPoint, target));
  if (refinedDist < bestDist) {
    return { t: refinedT, point: refinedPoint, distance: refinedDist };
  }
  return { t: bestT, point: bestPoint, distance: bestDist };
}

/**
 * Fits a single cubic Bézier from `points[0]` to `points[points.length-1]`
 * that stays close to every point in between, given FIXED end tangent
 * directions `t0`/`t1` (unit vectors — `t0` points away from the start
 * along the curve, `t1` points away from the end, i.e. "backward" into the
 * curve, matching how `handleIn` is stored). Only the two handle *lengths*
 * are solved for, via the classic Schneider (Graphics Gems) least-squares
 * method — keeping the tangent directions fixed means the curve leaves and
 * arrives at exactly the angle the caller asked for, which is what lets
 * nodeOps' delete-nodes preserve a survivor's original tangent instead of
 * letting the fit drift it.
 *
 * Returns the two control points (not offsets), ready to assign straight
 * into `handleOut`/`handleIn`.
 */
export function fitSingleCubic(points: Point[], t0: Point, t1: Point): [Point, Point] {
  const p0 = points[0];
  const p3 = points[points.length - 1];

  // Chord-length parameterization (distance along the sampled polyline,
  // not sample index) so the fit stays stable when samples are unevenly
  // spaced — e.g. denser where the original curve had tighter curvature.
  const chord: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    chord.push(chord[i - 1] + length(subtract(points[i], points[i - 1])));
  }
  const totalLen = chord[chord.length - 1] || length(subtract(p3, p0)) || 1;
  const params = chord.map((d) => d / totalLen);

  // P(u) = (b0+b1)*P0 + (b2+b3)*P3 + b1*alpha1*t0 + b2*alpha2*t1 — a 2x2
  // least-squares system for [alpha1, alpha2] (Schneider's derivation).
  let c11 = 0, c12 = 0, c22 = 0, x1 = 0, x2 = 0;
  for (let i = 0; i < points.length; i++) {
    const u = params[i];
    const mu = 1 - u;
    const b0 = mu * mu * mu;
    const b1 = 3 * u * mu * mu;
    const b2 = 3 * u * u * mu;
    const b3 = u * u * u;

    const a1 = scale(t0, b1);
    const a2 = scale(t1, b2);

    c11 += a1.x * a1.x + a1.y * a1.y;
    c12 += a1.x * a2.x + a1.y * a2.y;
    c22 += a2.x * a2.x + a2.y * a2.y;

    const base = { x: (b0 + b1) * p0.x + (b2 + b3) * p3.x, y: (b0 + b1) * p0.y + (b2 + b3) * p3.y };
    const rk = { x: points[i].x - base.x, y: points[i].y - base.y };

    x1 += a1.x * rk.x + a1.y * rk.y;
    x2 += a2.x * rk.x + a2.y * rk.y;
  }

  const det = c11 * c22 - c12 * c12;
  let alpha1: number;
  let alpha2: number;
  if (Math.abs(det) < 1e-9) {
    // Near-singular (very short run / near-collinear tangents) — fall back
    // to a third of the chord length, Schneider's own fallback rule.
    alpha1 = alpha2 = totalLen / 3;
  } else {
    alpha1 = (x1 * c22 - x2 * c12) / det;
    alpha2 = (c11 * x2 - c12 * x1) / det;
  }

  // Clamp: never negative (handle pointing the wrong way) and never far
  // longer than the span it's fitting, so a near-singular fit can't fling
  // a handle off the shape.
  alpha1 = Math.max(0, Math.min(alpha1, totalLen * 2));
  alpha2 = Math.max(0, Math.min(alpha2, totalLen * 2));

  return [add(p0, scale(t0, alpha1)), add(p3, scale(t1, alpha2))];
}

/** Closest point on a straight segment a-b (for line segments, where t is trivial). */
export function closestPointOnLine(a: Point, b: Point, target: Point): { t: number; point: Point; distance: number } {
  const ab = subtract(b, a);
  const abLenSq = ab.x * ab.x + ab.y * ab.y;
  if (abLenSq === 0) return { t: 0, point: a, distance: length(subtract(a, target)) };
  const t = Math.max(0, Math.min(1, ((target.x - a.x) * ab.x + (target.y - a.y) * ab.y) / abLenSq));
  const point = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return { t, point, distance: length(subtract(point, target)) };
}
