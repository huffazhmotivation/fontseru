import type { PathNode, Point } from "@/types/geometry";
import { shortId } from "@/utils/id";

/**
 * Freehand curve fitting, ported from DesignSeru's Pencil (engine/fit.ts):
 * Philip J. Schneider, "An Algorithm for Automatically Fitting Digitized
 * Curves" (Graphics Gems, 1990). Turns the captured pointer samples into
 * the fewest cubic Bézier segments that stay within `error` of every
 * sample, keeping sharp turns as real corners.
 *
 * Runs ONCE, when the stroke is finished — the live preview just draws the
 * captured samples, so nothing already on screen ever moves while drawing.
 */

type V = Point;
type Bez = [V, V, V, V];

const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y;
const len = (a: V) => Math.hypot(a.x, a.y);
const norm = (a: V): V => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
const dist = (a: V, b: V) => len(sub(a, b));

function bez(b: Bez, t: number): V {
  const u = 1 - t;
  return add(add(mul(b[0], u * u * u), mul(b[1], 3 * u * u * t)), add(mul(b[2], 3 * u * t * t), mul(b[3], t * t * t)));
}
function bezD1(b: Bez, t: number): V {
  const u = 1 - t;
  return add(add(mul(sub(b[1], b[0]), 3 * u * u), mul(sub(b[2], b[1]), 6 * u * t)), mul(sub(b[3], b[2]), 3 * t * t));
}
function bezD2(b: Bez, t: number): V {
  return add(mul(add(sub(b[2], mul(b[1], 2)), b[0]), 6 * (1 - t)), mul(add(sub(b[3], mul(b[2], 2)), b[1]), 6 * t));
}

function chordParams(pts: V[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + dist(pts[i], pts[i - 1]));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

function generate(pts: V[], first: number, last: number, u: number[], t1: V, t2: V): Bez {
  const p0 = pts[first];
  const p3 = pts[last];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i];
    const mt = 1 - t;
    const a1 = mul(t1, 3 * t * mt * mt);
    const a2 = mul(t2, 3 * t * t * mt);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(pts[first + i], add(mul(p0, mt * mt * mt + 3 * t * mt * mt), mul(p3, 3 * t * t * mt + t * t * t)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let al = 0;
  let ar = 0;
  if (Math.abs(det) > 1e-12) {
    al = (x0 * c11 - x1 * c01) / det;
    ar = (c00 * x1 - c01 * x0) / det;
  }
  const segLen = dist(p0, p3);
  const eps = 1e-6 * segLen;
  if (al < eps || ar < eps) al = ar = segLen / 3;
  return [p0, add(p0, mul(t1, al)), add(p3, mul(t2, ar)), p3];
}

function maxError(pts: V[], first: number, last: number, b: Bez, u: number[]) {
  let max = 0;
  let idx = Math.floor((last - first + 1) / 2) + first;
  for (let i = first + 1; i < last; i++) {
    const d = dist(bez(b, u[i - first]), pts[i]);
    if (d > max) {
      max = d;
      idx = i;
    }
  }
  return { max, idx };
}

function reparam(pts: V[], first: number, b: Bez, u: number[]) {
  return u.map((t, i) => {
    const d = sub(bez(b, t), pts[first + i]);
    const d1 = bezD1(b, t);
    const d2 = bezD2(b, t);
    const den = dot(d1, d1) + dot(d, d2);
    if (Math.abs(den) < 1e-12) return t;
    return Math.max(0, Math.min(1, t - dot(d, d1) / den));
  });
}

function fitCubic(pts: V[], first: number, last: number, t1: V, t2: V, err: number, out: Bez[], depth = 0) {
  if (last - first + 1 === 2) {
    const d = dist(pts[first], pts[last]) / 3;
    out.push([pts[first], add(pts[first], mul(t1, d)), add(pts[last], mul(t2, d)), pts[last]]);
    return;
  }
  let u = chordParams(pts, first, last);
  let b = generate(pts, first, last, u, t1, t2);
  let { max, idx } = maxError(pts, first, last, b, u);
  if (max < err) {
    out.push(b);
    return;
  }
  if (max < err * 4) {
    for (let i = 0; i < 6; i++) {
      u = reparam(pts, first, b, u);
      b = generate(pts, first, last, u, t1, t2);
      ({ max, idx } = maxError(pts, first, last, b, u));
      if (max < err) {
        out.push(b);
        return;
      }
    }
  }
  if (depth > 40) {
    out.push(b);
    return;
  }
  const tc = norm(sub(pts[idx - 1], pts[idx + 1]));
  fitCubic(pts, first, idx, t1, tc, err, out, depth + 1);
  fitCubic(pts, idx, last, mul(tc, -1), t2, err, out, depth + 1);
}

/** Drop samples closer than `minD` to the previous kept one. */
function dedupe(pts: V[], minD: number): V[] {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) if (dist(pts[i], out[out.length - 1]) >= minD) out.push(pts[i]);
  if (out.length === 1 && pts.length > 1) out.push(pts[pts.length - 1]);
  return out;
}

/** Sample indices where the stroke turns sharply — kept as corner nodes. */
function corners(pts: V[], angleDeg = 55, span = 3): number[] {
  const out: number[] = [];
  for (let i = span; i < pts.length - span; i++) {
    const a = norm(sub(pts[i], pts[i - span]));
    const b = norm(sub(pts[i + span], pts[i]));
    const ang = (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;
    if (ang > angleDeg) {
      if (out.length && i - out[out.length - 1] < span * 2) continue;
      out.push(i);
    }
  }
  return out;
}

const same = (a: V, b: V) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

function node(point: V, handleIn: V | null, handleOut: V | null, smooth: boolean): PathNode {
  return {
    id: shortId("n"),
    point: { x: point.x, y: point.y },
    handleIn: handleIn && !same(handleIn, point) ? { x: handleIn.x, y: handleIn.y } : null,
    handleOut: handleOut && !same(handleOut, point) ? { x: handleOut.x, y: handleOut.y } : null,
    type: smooth ? "smooth" : "corner",
  };
}

/**
 * Fit freehand samples to Bézier nodes (open run: first/last are corners).
 * @param error tolerance in the samples' own units — larger = fewer nodes.
 * @param minSpacing samples closer than this are merged before fitting.
 */
export function fitFreehand(raw: Point[], error: number, minSpacing: number): PathNode[] {
  const pts = dedupe(raw, Math.max(minSpacing, error * 0.25));
  if (pts.length < 2) return pts.map((p) => node(p, null, null, false));
  const cut = [0, ...corners(pts), pts.length - 1];
  const beziers: Bez[] = [];
  const sharpAt = new Set<number>();
  for (let s = 0; s < cut.length - 1; s++) {
    const a = cut[s];
    const b = cut[s + 1];
    if (b - a < 1) continue;
    const t1 = norm(sub(pts[Math.min(a + 1, b)], pts[a]));
    const t2 = norm(sub(pts[Math.max(b - 1, a)], pts[b]));
    fitCubic(pts, a, b, t1, t2, error, beziers);
    sharpAt.add(beziers.length);
  }
  const nodes: PathNode[] = [node(beziers[0][0], null, beziers[0][1], false)];
  beziers.forEach((b, i) => {
    const next = beziers[i + 1];
    nodes.push(node(b[3], b[2], next ? next[1] : null, !!next && !sharpAt.has(i + 1)));
  });
  return nodes;
}

/**
 * Fit a freehand gesture as a CLOSED shape (Pencil always fills).
 * - Ends that meet (gap ≤ `closeGap`): fitted as one loop, and the seam is
 *   a smooth node when the stroke runs through it smoothly, a corner when
 *   it turns there.
 * - Ends apart: the gesture is fitted as drawn and closed with a straight
 *   edge between its two ends (Illustrator/Affinity Pencil behaviour).
 */
export function fitFreehandClosed(raw: Point[], error: number, minSpacing: number, closeGap: number): PathNode[] {
  if (raw.length < 2) return fitFreehand(raw, error, minSpacing);
  const first = raw[0];
  const meets = dist(first, raw[raw.length - 1]) <= closeGap;
  const nodes = fitFreehand(meets ? [...raw, first] : raw, error, minSpacing);
  if (nodes.length < 2) return nodes;
  if (!meets) return nodes; // first.handleIn / last.handleOut stay null: straight closing edge
  const last = nodes.pop()!;
  if (nodes.length < 2) return [...nodes, last];
  const seam = nodes[0];
  seam.handleIn = last.handleIn;
  const hi = seam.handleIn;
  const ho = seam.handleOut;
  if (hi && ho) {
    const din = norm(sub(seam.point, hi));
    const dout = norm(sub(ho, seam.point));
    const ang = (Math.acos(Math.max(-1, Math.min(1, dot(din, dout)))) * 180) / Math.PI;
    if (ang < 40) {
      // Make the seam truly smooth: align both handles to the mean direction.
      const dir = norm(add(din, dout));
      seam.handleIn = sub(seam.point, mul(dir, dist(seam.point, hi)));
      seam.handleOut = add(seam.point, mul(dir, dist(seam.point, ho)));
      seam.type = "smooth";
    }
  }
  return nodes;
}
