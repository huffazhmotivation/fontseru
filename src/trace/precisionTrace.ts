import type { Contour, PathNode, Point, VectorObject } from "@/types/geometry";
import { shortId } from "@/utils/id";

/**
 * Precision tracer — FontSeru's own raster → Bézier engine.
 *
 * Replaces the imagetracerjs pipeline (hard 1-bit threshold → pixel-edge
 * walk → line/quadratic chains), which had two built-in limits: the edge it
 * followed was the pixel staircase, not the real edge of the artwork, and
 * the curve fitter emitted a node every few pixels on anything curved. The
 * result drifted off the source by up to a pixel and carried 3–10× the
 * nodes a type designer would draw.
 *
 * This engine works the way a type designer traces:
 *
 *  1. Sub-pixel edge. The edge is taken from the GREYSCALE image where its
 *     ink level crosses the threshold (marching squares with linear
 *     interpolation), so anti-aliased edges land at their true position
 *     instead of snapping to whole pixels.
 *  2. Clean topology first. Tiny ink specks and pin-holes are removed on the
 *     bitmap before contouring, so they never become stray shapes.
 *  3. Real corners stay sharp. Corners are found by comparing turning angle
 *     at two scales (a corner turns all at once, a curve turns gradually),
 *     and each corner is rebuilt where its two sides actually meet, undoing
 *     the rounding the scan/blur put on it.
 *  4. Fewest curves that fit. Between corners, the longest cubic that stays
 *     within `tolerance` of the edge is fitted each time (least squares with
 *     Newton reparameterisation), with matching tangents across smooth
 *     joins.
 *  5. Nodes where a designer puts them. Curves get a node at every real
 *     horizontal/vertical extreme (handles exactly flat/upright — what
 *     hinting, overshoots and the Node tool all expect), then any node that
 *     is neither a corner nor an extreme is removed when one curve can
 *     replace its two neighbours within tolerance.
 *
 * Pure functions only (no DOM), so the same code runs in the app and in the
 * Node bench (scripts/trace-bench).
 */

export interface PrecisionTraceOptions {
  /** Luminance (0–255) below which a pixel counts as ink (above, when inverted). */
  threshold: number;
  invert: boolean;
  /** Max distance (working px) between fitted curve and the traced edge. */
  tolerance: number;
  /** Light [1,2,1] smoothing passes on the ink field before contouring (noise / JPEG / scan grain). */
  blurPasses: number;
  /** Ink islands smaller than this (px²) are dropped. */
  minArea: number;
  /** Holes smaller than this (px²) are filled. */
  minHoleArea: number;
  /** Turning angle (degrees) above which a point counts as a corner. */
  cornerAngle: number;
}

/** One closed traced outline in working-pixel space (Y down). */
export interface TracedOutline {
  nodes: PathNode[];
  /** Signed area of the raw edge polygon: > 0 = ink boundary (outer), < 0 = hole. */
  area: number;
  /** Raw edge polygon (for containment tests). */
  poly: Point[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

// ---------------------------------------------------------------------------
// 1. Ink field
// ---------------------------------------------------------------------------

/**
 * Signed ink field: > 0 inside ink, < 0 on background, 0 exactly on the
 * edge. Transparent pixels are composited onto the background colour first
 * (white normally, black when inverted) so transparent PNGs trace correctly.
 */
export function inkField(
  rgba: ArrayLike<number>,
  w: number,
  h: number,
  threshold: number,
  invert: boolean,
  channels = 4
): Float32Array {
  const out = new Float32Array(w * h);
  const bg = invert ? 0 : 255;
  for (let i = 0, p = 0; i < out.length; i++, p += channels) {
    const r = rgba[p];
    const g = channels >= 3 ? rgba[p + 1] : r;
    const b = channels >= 3 ? rgba[p + 2] : r;
    const a = channels === 4 ? rgba[p + 3] / 255 : 1;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) * a + bg * (1 - a);
    out[i] = invert ? lum - threshold : threshold - lum;
  }
  return out;
}

/**
 * Otsu's threshold on the luminance histogram — the split that best
 * separates ink from paper. Used to pick a sensible starting Threshold for
 * each uploaded image instead of a fixed 150 that is wrong for pale pencil
 * sketches and dark photos alike.
 */
export function otsuThreshold(rgba: ArrayLike<number>, w: number, h: number, channels = 4): number {
  const hist = new Float64Array(256);
  for (let i = 0, p = 0; i < w * h; i++, p += channels) {
    const a = channels === 4 ? rgba[p + 3] / 255 : 1;
    const lum = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) * a + 255 * (1 - a);
    hist[Math.max(0, Math.min(255, Math.round(lum)))]++;
  }
  const total = w * h;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestT = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = t; }
  }
  // Otsu returns the last value of the dark class; the midpoint to the next
  // level is the actual decision boundary.
  return Math.max(10, Math.min(245, bestT + 0.5));
}

/** In-place separable [1,2,1]/4 blur (σ ≈ 0.7 px per pass), edges clamped. */
export function blurField(f: Float32Array, w: number, h: number, passes: number): void {
  if (passes <= 0) return;
  const tmp = new Float32Array(f.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const l = f[row + (x > 0 ? x - 1 : x)];
        const r = f[row + (x < w - 1 ? x + 1 : x)];
        tmp[row + x] = (l + 2 * f[row + x] + r) * 0.25;
      }
    }
    for (let y = 0; y < h; y++) {
      const up = (y > 0 ? y - 1 : y) * w;
      const dn = (y < h - 1 ? y + 1 : y) * w;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        f[row + x] = (tmp[up + x] + 2 * tmp[row + x] + tmp[dn + x]) * 0.25;
      }
    }
  }
}

/**
 * Removes ink islands smaller than `minArea` and fills holes smaller than
 * `minHoleArea`, directly in the field, so marching squares never sees
 * them. Ink uses 8-connectivity (a diagonal pixel bridge keeps a stroke in
 * one piece), background 4-connectivity (the matching dual), and only
 * background regions that do not touch the image border count as holes.
 */
export function cleanField(f: Float32Array, w: number, h: number, minArea: number, minHoleArea: number): void {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const members = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (label[start] !== -1) continue;
    const ink = f[start] > 0;
    let sp = 0;
    let count = 0;
    let touchesBorder = false;
    stack[sp++] = start;
    label[start] = 1;
    while (sp > 0) {
      const p = stack[--sp];
      members[count++] = p;
      const x = p % w;
      const y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!ink && dx !== 0 && dy !== 0) continue; // background: 4-connected
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (label[q] !== -1 || (f[q] > 0) !== ink) continue;
          label[q] = 1;
          stack[sp++] = q;
        }
      }
    }
    if (ink && count < minArea) {
      for (let i = 0; i < count; i++) f[members[i]] = -Math.max(1, Math.abs(f[members[i]]));
    } else if (!ink && !touchesBorder && count < minHoleArea) {
      for (let i = 0; i < count; i++) f[members[i]] = Math.max(1, Math.abs(f[members[i]]));
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Sub-pixel contours (marching squares)
// ---------------------------------------------------------------------------

// Corner bits of a cell: TL=1, TR=2, BR=4, BL=8. Edges: 0 top, 1 right, 2 bottom, 3 left.
// Each entry: [edgeA, edgeB, referenceCorner] — the segment cuts that corner
// (or, for the two-corner cases, separates the pair containing it).
type Seg = [number, number, number];
const CASES: (Seg[] | null)[] = [];
(function buildCases() {
  const TL = 0, TR = 1, BR = 2, BL = 3;
  const T = 0, R = 1, B = 2, L = 3;
  CASES[0] = null;
  CASES[15] = null;
  CASES[1] = [[T, L, TL]];
  CASES[2] = [[T, R, TR]];
  CASES[4] = [[R, B, BR]];
  CASES[8] = [[B, L, BL]];
  CASES[14] = [[T, L, TL]];
  CASES[13] = [[T, R, TR]];
  CASES[11] = [[R, B, BR]];
  CASES[7] = [[B, L, BL]];
  CASES[3] = [[L, R, TL]];
  CASES[6] = [[T, B, TR]];
  CASES[12] = [[L, R, BR]];
  CASES[9] = [[T, B, TL]];
  // 5 and 10 (saddles) are resolved per cell from the centre value.
})();

/**
 * Closed sub-pixel iso-contours of the field at 0, oriented so ink is on the
 * positive-cross side: outer ink boundaries get a positive shoelace area in
 * image coordinates (Y down), holes a negative one.
 */
export function marchingSquares(f: Float32Array, w: number, h: number): Point[][] {
  const W = w + 2;
  const H = h + 2;
  const F = new Float32Array(W * H).fill(-1);
  for (let y = 0; y < h; y++) {
    F.set(f.subarray(y * w, y * w + w), (y + 1) * W + 1);
  }
  // An exact 0 would put the crossing right on a sample point; nudge it to
  // background so every crossing lies strictly inside its edge.
  for (let i = 0; i < F.length; i++) if (F[i] === 0) F[i] = -1e-4;
  const val = (X: number, Y: number) => F[Y * W + X];
  // Edge ids: horizontal edge (X,Y)-(X+1,Y) = 2*(Y*W+X); vertical (X,Y)-(X,Y+1) = 2*(Y*W+X)+1.
  const edgeId = (X: number, Y: number, e: number): number => {
    switch (e) {
      case 0: return 2 * (Y * W + X);
      case 1: return 2 * (Y * W + X + 1) + 1;
      case 2: return 2 * ((Y + 1) * W + X);
      default: return 2 * (Y * W + X) + 1;
    }
  };
  const edgePoint = (id: number): Point => {
    const vertical = id & 1;
    const cell = id >> 1;
    const X = cell % W;
    const Y = (cell - X) / W;
    const a = F[cell];
    const b = vertical ? F[cell + W] : F[cell + 1];
    const t = a / (a - b);
    return vertical ? { x: X - 0.5, y: Y - 0.5 + t } : { x: X - 0.5 + t, y: Y - 0.5 };
  };
  const cornerVal = (X: number, Y: number, c: number): number => {
    const cx = c === 1 || c === 2 ? X + 1 : X;
    const cy = c === 2 || c === 3 ? Y + 1 : Y;
    return val(cx, cy);
  };

  const next = new Map<number, number>();
  // Edge midpoints relative to the cell's TL corner: used only to decide the
  // walking direction, which is purely topological — using the interpolated
  // crossings here could make the test degenerate when a crossing sits
  // almost on a corner.
  const MID: Point[] = [{ x: 0.5, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 0.5 }];
  const CORNER: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const addSeg = (X: number, Y: number, ea: number, eb: number, ref: number) => {
    const A = edgeId(X, Y, ea);
    const B = edgeId(X, Y, eb);
    const pa = MID[ea];
    const pb = MID[eb];
    const r = CORNER[ref];
    const cross = (pb.x - pa.x) * (r.y - pa.y) - (pb.y - pa.y) * (r.x - pa.x);
    const refInk = cornerVal(X, Y, ref) > 0;
    if ((cross > 0) === refInk) next.set(A, B);
    else next.set(B, A);
  };

  for (let Y = 0; Y < H - 1; Y++) {
    for (let X = 0; X < W - 1; X++) {
      const a = F[Y * W + X];
      const b = F[Y * W + X + 1];
      const c = F[(Y + 1) * W + X + 1];
      const d = F[(Y + 1) * W + X];
      const k = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
      if (k === 0 || k === 15) continue;
      if (k === 5 || k === 10) {
        const centreInk = a + b + c + d > 0;
        if (k === 5) {
          // TL + BR ink
          if (centreInk) { addSeg(X, Y, 0, 1, 1); addSeg(X, Y, 2, 3, 3); }
          else { addSeg(X, Y, 0, 3, 0); addSeg(X, Y, 1, 2, 2); }
        } else {
          // TR + BL ink
          if (centreInk) { addSeg(X, Y, 0, 3, 0); addSeg(X, Y, 1, 2, 2); }
          else { addSeg(X, Y, 0, 1, 1); addSeg(X, Y, 2, 3, 3); }
        }
        continue;
      }
      for (const [ea, eb, ref] of CASES[k]!) addSeg(X, Y, ea, eb, ref);
    }
  }

  const contours: Point[][] = [];
  const visited = new Set<number>();
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const pts: Point[] = [];
    let e = start;
    let guard = 0;
    while (!visited.has(e) && guard++ < 10_000_000) {
      visited.add(e);
      pts.push(edgePoint(e));
      const nx = next.get(e);
      if (nx === undefined) break;
      e = nx;
    }
    if (pts.length >= 3) contours.push(pts);
  }
  return contours;
}

export function polygonArea(pts: Point[]): number {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return s / 2;
}

// ---------------------------------------------------------------------------
// 3. Curve fitting
// ---------------------------------------------------------------------------

interface V { x: number; y: number }
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y;
const len = (a: V) => Math.hypot(a.x, a.y);
const unit = (a: V): V => { const l = len(a); return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 }; };

/** A fitted cubic [p0, c1, c2, p3]; c1/c2 null ⇒ straight line. */
interface Seg3 { p0: Point; c1: Point | null; c2: Point | null; p3: Point; i0: number; i1: number }

function bez(p0: V, p1: V, p2: V, p3: V, t: number): V {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}
function bezD1(p0: V, p1: V, p2: V, p3: V, t: number): V {
  const mt = 1 - t;
  return {
    x: 3 * (mt * mt * (p1.x - p0.x) + 2 * mt * t * (p2.x - p1.x) + t * t * (p3.x - p2.x)),
    y: 3 * (mt * mt * (p1.y - p0.y) + 2 * mt * t * (p2.y - p1.y) + t * t * (p3.y - p2.y)),
  };
}
function bezD2(p0: V, p1: V, p2: V, p3: V, t: number): V {
  return {
    x: 6 * ((1 - t) * (p2.x - 2 * p1.x + p0.x) + t * (p3.x - 2 * p2.x + p1.x)),
    y: 6 * ((1 - t) * (p2.y - 2 * p1.y + p0.y) + t * (p3.y - 2 * p2.y + p1.y)),
  };
}

/**
 * Least-squares cubic through `pts` with its end tangents fixed (Schneider,
 * "An Algorithm for Automatically Fitting Digitized Curves"), refined with a
 * few rounds of Newton reparameterisation. Returns control points and the
 * max distance of any data point from the curve.
 */
function fitCubic(pts: V[], t1: V, t2: V): { c1: V; c2: V; err: number } {
  const n = pts.length;
  const p0 = pts[0];
  const p3 = pts[n - 1];
  const chord = len(sub(p3, p0));
  if (n <= 2) {
    const k = chord / 3;
    return { c1: add(p0, mul(t1, k)), c2: add(p3, mul(t2, k)), err: 0 };
  }
  // chord-length parameterisation
  const u = new Float64Array(n);
  let total = 0;
  for (let i = 1; i < n; i++) { total += len(sub(pts[i], pts[i - 1])); u[i] = total; }
  for (let i = 1; i < n; i++) u[i] /= total || 1;

  let c1: V = p0, c2: V = p3, err = Infinity;
  for (let iter = 0; iter < 5; iter++) {
    let C00 = 0, C01 = 0, C11 = 0, X0 = 0, X1 = 0;
    for (let i = 0; i < n; i++) {
      const t = u[i], mt = 1 - t;
      const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
      const a1 = mul(t1, b1);
      const a2 = mul(t2, b2);
      C00 += dot(a1, a1); C01 += dot(a1, a2); C11 += dot(a2, a2);
      const tmp = sub(pts[i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
      X0 += dot(a1, tmp); X1 += dot(a2, tmp);
    }
    const det = C00 * C11 - C01 * C01;
    let al1 = 0, al2 = 0;
    if (Math.abs(det) > 1e-12) {
      al1 = (X0 * C11 - X1 * C01) / det;
      al2 = (C00 * X1 - C01 * X0) / det;
    }
    const eps = 1e-6 * chord;
    if (!(al1 > eps) || !(al2 > eps) || al1 > 3 * chord || al2 > 3 * chord) {
      al1 = al2 = chord / 3;
    }
    c1 = add(p0, mul(t1, al1));
    c2 = add(p3, mul(t2, al2));
    // reparameterise + measure
    let maxD = 0;
    for (let i = 1; i < n - 1; i++) {
      let t = u[i];
      const q = bez(p0, c1, c2, p3, t);
      const d1 = bezD1(p0, c1, c2, p3, t);
      const d2 = bezD2(p0, c1, c2, p3, t);
      const diff = sub(q, pts[i]);
      const num = dot(diff, d1);
      const den = dot(d1, d1) + dot(diff, d2);
      if (Math.abs(den) > 1e-12) t = Math.max(0, Math.min(1, t - num / den));
      u[i] = t;
      const dd = len(sub(bez(p0, c1, c2, p3, t), pts[i]));
      if (dd > maxD) maxD = dd;
    }
    err = maxD;
  }
  // keep the parameters monotonic-ish: a fold shows as a big error anyway
  return { c1, c2, err };
}

/** Max distance of `pts` from the straight chord between its ends. */
function lineError(pts: V[]): number {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const d = sub(b, a);
  const L = len(d);
  let m = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const v = sub(pts[i], a);
    const dist = L > 1e-9 ? Math.abs(v.x * d.y - v.y * d.x) / L : len(v);
    if (dist > m) m = dist;
  }
  return m;
}

/** Arc-length helper over a closed polyline. */
class Ring {
  readonly pts: Point[];
  readonly s: Float64Array;
  readonly L: number;
  constructor(pts: Point[]) {
    this.pts = pts;
    const n = pts.length;
    this.s = new Float64Array(n + 1);
    for (let i = 1; i <= n; i++) this.s[i] = this.s[i - 1] + len(sub(pts[i % n], pts[i - 1]));
    this.L = this.s[n];
  }
  get n() { return this.pts.length; }
  /** Point at arc position (wraps). */
  at(pos: number): Point {
    const L = this.L;
    let p = pos % L;
    if (p < 0) p += L;
    let lo = 0, hi = this.n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.s[mid] <= p) lo = mid; else hi = mid;
    }
    const a = this.pts[lo];
    const b = this.pts[(lo + 1) % this.n];
    const seg = this.s[lo + 1] - this.s[lo];
    const t = seg > 1e-12 ? (p - this.s[lo]) / seg : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  /** Turning angle (radians) at vertex i measured with chords of arc length r. */
  turn(i: number, r: number): number {
    const p = this.pts[i];
    const a = this.at(this.s[i] - r);
    const b = this.at(this.s[i] + r);
    const u = unit(sub(p, a));
    const v = unit(sub(b, p));
    return Math.acos(Math.max(-1, Math.min(1, dot(u, v))));
  }
  tangent(i: number, h: number): V {
    return unit(sub(this.at(this.s[i] + h), this.at(this.s[i] - h)));
  }
  /** Forward arc distance from i to j. */
  dist(i: number, j: number): number {
    const d = this.s[j] - this.s[i];
    return d >= 0 ? d : d + this.L;
  }
}

/**
 * Corner indices. A corner turns sharply at one point: its turning angle is
 * above `angle` at the coarse scale AND still most of that at half the
 * scale. A tight but round curve fails the second test (its turn shrinks
 * with the window), so it stays a smooth curve.
 */
function findCorners(ring: Ring, angleRad: number, r: number): number[] {
  const n = ring.n;
  const sharp = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const big = ring.turn(i, r);
    if (big < angleRad) continue;
    const small = ring.turn(i, r * 0.5);
    if (small < big * 0.55) continue;
    sharp[i] = big;
  }
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!sharp[i]) continue;
    let isMax = true;
    // non-max suppression within ±r of arc
    for (let k = 1; k < n && isMax; k++) {
      const j = (i + k) % n;
      if (ring.dist(i, j) > r) break;
      if (sharp[j] > sharp[i]) isMax = false;
    }
    for (let k = 1; k < n && isMax; k++) {
      const j = (i - k + n) % n;
      if (ring.dist(j, i) > r) break;
      if (sharp[j] >= sharp[i]) isMax = false;
    }
    if (isMax) corners.push(i);
  }
  return corners;
}

/** Line through points in an arc window (least squares direction, oriented by `dirHint`). */
function windowLine(ring: Ring, from: number, to: number, dirHint: V): { p: V; d: V } | null {
  const steps = Math.max(3, Math.ceil(Math.abs(to - from) / 0.5));
  let mx = 0, my = 0;
  const samples: V[] = [];
  for (let k = 0; k <= steps; k++) {
    const q = ring.at(from + ((to - from) * k) / steps);
    samples.push(q);
    mx += q.x; my += q.y;
  }
  mx /= samples.length; my /= samples.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const q of samples) {
    const dx = q.x - mx, dy = q.y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let d = { x: Math.cos(ang), y: Math.sin(ang) };
  if (dot(d, dirHint) < 0) d = mul(d, -1);
  if (!isFinite(d.x)) return null;
  return { p: { x: mx, y: my }, d };
}

function intersectLines(p: V, d: V, q: V, e: V): V | null {
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / den;
  return add(p, mul(d, t));
}

interface FitOptions {
  tolerance: number;
  cornerAngle: number;
}

/**
 * Fits one closed edge polygon with as few cubic Béziers as the tolerance
 * allows, returning editable PathNodes (corner / smooth). Coordinates stay
 * in the polygon's own space.
 */
export function fitClosedOutline(rawPts: Point[], opts: FitOptions): PathNode[] {
  // de-duplicate
  const pts: Point[] = [];
  for (const p of rawPts) {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last.x - p.x) > 1e-6 || Math.abs(last.y - p.y) > 1e-6) pts.push(p);
  }
  if (pts.length > 2 && Math.abs(pts[0].x - pts[pts.length - 1].x) < 1e-6 && Math.abs(pts[0].y - pts[pts.length - 1].y) < 1e-6) pts.pop();
  if (pts.length < 3) return [];

  const ring = new Ring(pts);
  const n = ring.n;
  const tol = Math.max(0.05, opts.tolerance);
  // Scales (working px). The corner scale must see past the 1–2 px rounding
  // that anti-aliasing / blur puts on a real corner, but stay below the
  // radius of genuine tight curves.
  const rCorner = Math.max(3, Math.min(7, tol * 5));
  const hTangent = Math.max(1.2, Math.min(4, tol * 3));

  // Tiny outlines (dots, specks that survived): fit as one smooth loop.
  let corners = ring.L < rCorner * 6 ? [] : findCorners(ring, (opts.cornerAngle * Math.PI) / 180, rCorner);

  // Where each corner's two sides really meet (undoes AA/blur rounding).
  const cornerPoint = new Map<number, Point>();
  const cornerTanIn = new Map<number, V>();
  const cornerTanOut = new Map<number, V>();
  for (let k = 0; k < corners.length; k++) {
    const i = corners[k];
    const prevC = corners[(k - 1 + corners.length) % corners.length];
    const nextC = corners[(k + 1) % corners.length];
    const spanIn = corners.length > 1 ? ring.dist(prevC, i) : ring.L;
    const spanOut = corners.length > 1 ? ring.dist(i, nextC) : ring.L;
    const s = ring.s[i];
    const near = 1.0;
    const farIn = Math.min(near + Math.max(2.5, rCorner * 1.5), spanIn * 0.45);
    const farOut = Math.min(near + Math.max(2.5, rCorner * 1.5), spanOut * 0.45);
    const p = pts[i];
    const hintIn = unit(sub(p, ring.at(s - farIn)));
    const hintOut = unit(sub(ring.at(s + farOut), p));
    let X: Point = p;
    if (farIn > near + 0.5 && farOut > near + 0.5) {
      const lin = windowLine(ring, s - farIn, s - near, hintIn);
      const lout = windowLine(ring, s + near, s + farOut, hintOut);
      if (lin && lout) {
        cornerTanIn.set(i, lin.d);
        cornerTanOut.set(i, lout.d);
        const hit = intersectLines(lin.p, lin.d, lout.p, lout.d);
        // How far the true tip can sit from the rounded one grows as the
        // corner gets more acute (offset ≈ ρ·(1/sin(θ/2) − 1) for interior
        // angle θ and rounding radius ρ ≈ 1.5 px).
        const turn = Math.acos(Math.max(-1, Math.min(1, dot(lin.d, lout.d))));
        const interior = Math.max(0.15, Math.PI - turn);
        const limit = Math.max(1.5, Math.min(9, 1.6 * (1 / Math.sin(interior / 2) - 1) + 1.2));
        if (hit && len(sub(hit, p)) < limit) X = hit;
      }
    }
    cornerPoint.set(i, X);
  }

  // A corner whose sides turned out nearly straight-through is not a corner.
  corners = corners.filter((i) => {
    const a = cornerTanIn.get(i);
    const b = cornerTanOut.get(i);
    if (!a || !b) return true;
    return Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) > ((opts.cornerAngle * 0.6) * Math.PI) / 180;
  });

  const isCorner = new Uint8Array(n);
  for (const c of corners) isCorner[c] = 1;

  // Start index: first corner, or the topmost point (a y-extreme) for a smooth loop.
  let start = corners.length ? corners[0] : 0;
  if (!corners.length) {
    for (let i = 1; i < n; i++) if (pts[i].y < pts[start].y) start = i;
  }

  // Unwrapped index sequence starting at `start` and returning to it.
  const order: number[] = [];
  for (let k = 0; k <= n; k++) order.push((start + k) % n);
  const P = (k: number): Point => {
    const i = order[k];
    return isCorner[i] ? cornerPoint.get(i) ?? pts[i] : pts[i];
  };

  // Data points of a span, skipping the rounded tip right at a corner whose
  // point was moved to the true intersection.
  const spanPoints = (k0: number, k1: number): V[] => {
    const out: V[] = [P(k0)];
    const c0 = isCorner[order[k0]] ? ring.s[order[k0]] : null;
    const c1 = isCorner[order[k1]] ? ring.s[order[k1]] : null;
    for (let k = k0 + 1; k < k1; k++) {
      const i = order[k];
      if (c0 !== null && ring.dist(order[k0], i) < 1.0) continue;
      if (c1 !== null && ring.dist(i, order[k1]) < 1.0) continue;
      out.push(pts[i]);
    }
    out.push(P(k1));
    return out;
  };

  const tangentAt = (k: number, side: "in" | "out"): V => {
    const i = order[k];
    if (isCorner[i]) {
      const t = side === "in" ? cornerTanIn.get(i) : cornerTanOut.get(i);
      if (t) return t;
      const s = ring.s[i];
      return side === "in" ? unit(sub(P(k), ring.at(s - hTangent * 2))) : unit(sub(ring.at(s + hTangent * 2), P(k)));
    }
    return ring.tangent(i, hTangent);
  };

  // Fixed tangents (direction of travel), keyed by data index: the
  // horizontal/vertical tangent at every extreme node.
  const forcedTan = new Map<number, V>();
  const tanOut = (k: number): V => forcedTan.get(order[k]) ?? tangentAt(k, "out");
  const tanIn = (k: number): V => forcedTan.get(order[k]) ?? tangentAt(k, "in");
  const axisTangent = (i: number, axis: "x" | "y"): V => {
    const t = ring.tangent(i, hTangent);
    return axis === "y" ? { x: t.x >= 0 ? 1 : -1, y: 0 } : { x: 0, y: t.y >= 0 ? 1 : -1 };
  };
  if (!corners.length) forcedTan.set(order[0], axisTangent(order[0], "y"));

  /** Greedy longest-cubic fit between consecutive forced breakpoints. */
  const greedy = (breaks: number[]): Seg3[] => {
    const out: Seg3[] = [];
    for (let b = 0; b < breaks.length - 1; b++) {
      const k0 = breaks[b];
      const k1 = breaks[b + 1];
      if (k1 - k0 < 1) continue;
      // A whole straight side between two corners → one line.
      if (isCorner[order[k0]] && isCorner[order[k1]]) {
        const whole = spanPoints(k0, k1);
        if (whole.length >= 2 && lineError(whole) <= tol * 0.8) {
          out.push({ p0: P(k0), c1: null, c2: null, p3: P(k1), i0: k0, i1: k1 });
          continue;
        }
      }
      let a = k0;
      let tA = tanOut(k0);
      while (a < k1) {
        const tryFit = (j: number) => {
          const tB = mul(tanIn(j), -1);
          return { fit: fitCubic(spanPoints(a, j), tA, tB), tB };
        };
        let good = a + 1;
        let goodFit = tryFit(good);
        if (good < k1) {
          let step = 4;
          let bad = -1;
          for (;;) {
            const j = Math.min(k1, a + step);
            const r = tryFit(j);
            if (r.fit.err <= tol) {
              good = j; goodFit = r;
              if (j === k1) break;
              step *= 2;
            } else { bad = j; break; }
          }
          if (bad > 0) {
            let lo = good, hi = bad;
            while (hi - lo > 1) {
              const mid = (lo + hi) >> 1;
              const r = tryFit(mid);
              if (r.fit.err <= tol) { lo = mid; goodFit = r; } else hi = mid;
            }
            good = lo;
          }
        }
        out.push({ p0: P(a), c1: goodFit.fit.c1, c2: goodFit.fit.c2, p3: P(good), i0: a, i1: good });
        // G1: the next curve leaves along the same tangent this one arrived on.
        tA = mul(goodFit.tB, -1);
        a = good;
      }
    }
    return out;
  };

  const cornerBreaks: number[] = [0];
  for (let k = 1; k < n; k++) if (isCorner[order[k]]) cornerBreaks.push(k);
  cornerBreaks.push(n);

  // ---- pass 1: corners only, to learn where the real extremes are ----
  const pass1 = greedy(cornerBreaks);
  if (!pass1.length) return [];

  // ---- pass 2: one node on every real extreme ----
  const minGap = Math.max(2.5, tol * 4);
  const extremeK: number[] = [];
  const isExtremeData = new Uint8Array(n);
  if (!corners.length) isExtremeData[order[0]] = 1;
  const arcGap = (k1: number, k2: number) => {
    const d = Math.abs(ring.s[order[k1 % n]] - ring.s[order[k2 % n]]);
    return Math.min(d, ring.L - d);
  };
  const nearForced = (k: number) =>
    cornerBreaks.some((c) => arcGap(k, c) < minGap) || extremeK.some((e) => arcGap(k, e) < minGap);
  for (const sgm of pass1) {
    if (!sgm.c1 || !sgm.c2) continue;
    for (const ex of significantExtremes(sgm, tol)) {
      const q = bez(sgm.p0, sgm.c1, sgm.c2, sgm.p3, ex.t);
      const k = nearestIndex(order, pts, sgm.i0, sgm.i1, q);
      if (k <= 0 || k >= n || nearForced(k)) continue;
      extremeK.push(k);
      isExtremeData[order[k]] = 1;
      forcedTan.set(order[k], axisTangent(order[k], ex.axis));
    }
  }
  const breaks2 = Array.from(new Set([...cornerBreaks, ...extremeK])).sort((a, b) => a - b);
  const segs = extremeK.length ? greedy(breaks2) : pass1;

  // ---- any extreme still inside a curve: split it there exactly ----
  type Piece = Seg3 & { ext: boolean };
  const pieces: Piece[] = [];
  for (const sgm of segs) {
    const startExt = isExtremeData[order[sgm.i0]] === 1;
    const exs = sgm.c1 && sgm.c2 ? significantExtremes(sgm, tol) : [];
    if (!exs.length) { pieces.push({ ...sgm, ext: startExt }); continue; }
    let rest: [V, V, V, V] = [sgm.p0, sgm.c1!, sgm.c2!, sgm.p3];
    let prevT = 0;
    let i0 = sgm.i0;
    let ext = startExt;
    for (const { t } of exs) {
      const [l, r] = splitCubic(rest, (t - prevT) / (1 - prevT));
      const mid = l[3];
      const tan = sub(r[1], mid);
      if (Math.abs(tan.x) >= Math.abs(tan.y)) { l[2] = { x: l[2].x, y: mid.y }; r[1] = { x: r[1].x, y: mid.y }; }
      else { l[2] = { x: mid.x, y: l[2].y }; r[1] = { x: mid.x, y: r[1].y }; }
      const iMid = nearestIndex(order, pts, i0, sgm.i1, mid);
      pieces.push({ p0: l[0], c1: l[1], c2: l[2], p3: mid, i0, i1: iMid, ext });
      rest = r;
      prevT = t;
      i0 = iMid;
      ext = true;
    }
    pieces.push({ p0: rest[0], c1: rest[1], c2: rest[2], p3: rest[3], i0, i1: sgm.i1, ext: true });
  }

  // ---- merge pass: drop smooth, non-extreme nodes one curve can replace ----
  const list = pieces;
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10) {
    changed = false;
    for (let s = 0; s + 1 < list.length; s++) {
      const A = list[s];
      const B = list[s + 1];
      if (B.ext || isCorner[order[B.i0]]) continue;
      if (!A.c1 || !A.c2 || !B.c1 || !B.c2) continue;
      if (B.i1 - A.i0 < 2) continue;
      const tA = unit(sub(A.c1, A.p0));
      const tB = unit(sub(B.c2, B.p3));
      if ((tA.x === 0 && tA.y === 0) || (tB.x === 0 && tB.y === 0)) continue;
      const data = spanPoints(A.i0, B.i1);
      data[0] = A.p0;
      data[data.length - 1] = B.p3;
      const fit = fitCubic(data, tA, tB);
      if (fit.err > tol) continue;
      const merged: Piece = { p0: A.p0, c1: fit.c1, c2: fit.c2, p3: B.p3, i0: A.i0, i1: B.i1, ext: A.ext };
      if (significantExtremes(merged, tol).length) continue;
      list.splice(s, 2, merged);
      changed = true;
    }
  }

  // ---- straighten nearly-straight curves between corners ----
  for (const sg of list) {
    if (!sg.c1 || !sg.c2) continue;
    if (!isCorner[order[sg.i0]] || !isCorner[order[sg.i1]]) continue;
    const d = sub(sg.p3, sg.p0);
    const L = len(d);
    if (L < 1e-9) continue;
    const off1 = Math.abs((sg.c1.x - sg.p0.x) * d.y - (sg.c1.y - sg.p0.y) * d.x) / L;
    const off2 = Math.abs((sg.c2.x - sg.p0.x) * d.y - (sg.c2.y - sg.p0.y) * d.x) / L;
    if (Math.max(off1, off2) * 0.75 <= tol * 0.5) { sg.c1 = null; sg.c2 = null; }
  }

  // ---- to PathNodes ----
  const nodes: PathNode[] = list.map((sg) => {
    const i = order[sg.i0];
    return {
      id: shortId("tn"),
      point: { x: sg.p0.x, y: sg.p0.y },
      handleIn: null,
      handleOut: sg.c1 ? { x: sg.c1.x, y: sg.c1.y } : null,
      type: isCorner[i] ? "corner" : "smooth",
    };
  });
  for (let s = 0; s < list.length; s++) {
    const nextNode = nodes[(s + 1) % nodes.length];
    const c2 = list[s].c2;
    nextNode.handleIn = c2 ? { x: c2.x, y: c2.y } : null;
  }
  return nodes;
}

function nearestIndex(order: number[], pts: Point[], k0: number, k1: number, q: V): number {
  let best = k0;
  let bd = Infinity;
  for (let k = k0; k <= k1; k++) {
    const i = order[k];
    const d = (pts[i].x - q.x) ** 2 + (pts[i].y - q.y) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

/** Interior parameters where the cubic has a real horizontal/vertical extreme worth a node. */
function significantExtremes(sg: { p0: V; c1: V | null; c2: V | null; p3: V }, tol: number): { t: number; axis: "x" | "y" }[] {
  if (!sg.c1 || !sg.c2) return [];
  const out: { t: number; axis: "x" | "y" }[] = [];
  const P = [sg.p0, sg.c1, sg.c2, sg.p3];
  const chord = len(sub(sg.p3, sg.p0));
  // An extreme only matters if the curve really bulges past its ends there.
  const minBulge = Math.max(0.35 * tol, 0.25);
  for (const axis of ["x", "y"] as const) {
    const a0 = P[0][axis], a1 = P[1][axis], a2 = P[2][axis], a3 = P[3][axis];
    // derivative coefficients: 3[(−a0+3a1−3a2+a3)t² + 2(a0−2a1+a2)t + (a1−a0)]
    const A = -a0 + 3 * a1 - 3 * a2 + a3;
    const B = 2 * (a0 - 2 * a1 + a2);
    const C = a1 - a0;
    const roots: number[] = [];
    if (Math.abs(A) < 1e-12) {
      if (Math.abs(B) > 1e-12) roots.push(-C / B);
    } else {
      const disc = B * B - 4 * A * C;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        roots.push((-B + sq) / (2 * A), (-B - sq) / (2 * A));
      }
    }
    for (const t of roots) {
      if (!(t > 0.04 && t < 0.96)) continue;
      const pt = bez(P[0], P[1], P[2], P[3], t);
      const v = pt[axis];
      const bulge = Math.min(Math.abs(v - a0), Math.abs(v - a3));
      const beyond = v > Math.max(a0, a3) || v < Math.min(a0, a3);
      if (!beyond || bulge < minBulge) continue;
      // too close to an end node (would make a sliver segment)
      const near = Math.max(1.5, chord * 0.06);
      if (len(sub(pt, P[0])) < near || len(sub(pt, P[3])) < near) continue;
      out.push({ t, axis });
    }
  }
  out.sort((a, b) => a.t - b.t);
  // merge near-duplicates (an x and a y extreme at the same spot)
  const merged: { t: number; axis: "x" | "y" }[] = [];
  for (const e of out) if (!merged.length || e.t - merged[merged.length - 1].t > 0.05) merged.push(e);
  return merged;
}

function splitCubic(c: [V, V, V, V], t: number): [[V, V, V, V], [V, V, V, V]] {
  const lerp = (a: V, b: V) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const p01 = lerp(c[0], c[1]);
  const p12 = lerp(c[1], c[2]);
  const p23 = lerp(c[2], c[3]);
  const p012 = lerp(p01, p12);
  const p123 = lerp(p12, p23);
  const m = lerp(p012, p123);
  return [[c[0], p01, p012, m], [m, p123, p23, c[3]]];
}

// ---------------------------------------------------------------------------
// 4. Whole-image trace → objects
// ---------------------------------------------------------------------------

export interface FieldTraceResult {
  objects: VectorObject[];
  outlines: TracedOutline[];
}

function boundsOf(pts: Point[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function pointInPoly(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Field (already cleaned) → fitted outlines grouped into objects: every
 * outer ink boundary becomes one "shape" object carrying its own holes
 * (counters), so separate ink islands stay separately selectable and a
 * counter can never turn into a stray filled patch.
 */
export function traceField(f: Float32Array, w: number, h: number, opts: Pick<PrecisionTraceOptions, "tolerance" | "cornerAngle">): FieldTraceResult {
  const polys = marchingSquares(f, w, h);
  const outlines: TracedOutline[] = [];
  for (const poly of polys) {
    const area = polygonArea(poly);
    if (Math.abs(area) < 0.5) continue;
    const nodes = fitClosedOutline(poly, opts);
    if (nodes.length < 2) continue;
    outlines.push({ nodes, area, poly, bounds: boundsOf(poly) });
  }
  const outers = outlines.filter((o) => o.area > 0).sort((a, b) => a.area - b.area);
  const holes = outlines.filter((o) => o.area < 0);
  const holesOf = new Map<TracedOutline, TracedOutline[]>();
  for (const hole of holes) {
    const probe = hole.poly[0];
    // smallest outer that contains the hole = its direct parent
    const parent = outers.find((o) =>
      o.area > -hole.area &&
      o.bounds.minX <= hole.bounds.minX && o.bounds.maxX >= hole.bounds.maxX &&
      o.bounds.minY <= hole.bounds.minY && o.bounds.maxY >= hole.bounds.maxY &&
      pointInPoly(probe, o.poly)
    );
    if (!parent) continue;
    const arr = holesOf.get(parent) ?? [];
    arr.push(hole);
    holesOf.set(parent, arr);
  }
  const toContour = (o: TracedOutline): Contour => ({ id: shortId("trace_c"), nodes: o.nodes, closed: true });
  const objects: VectorObject[] = outers
    .slice()
    .sort((a, b) => a.bounds.minX - b.bounds.minX || a.bounds.minY - b.bounds.minY)
    .map((o) => ({
      id: shortId("trace_obj"),
      kind: "shape" as const,
      contours: [toContour(o), ...(holesOf.get(o) ?? []).map(toContour)],
    }));
  return { objects, outlines };
}

/** Detail presets: tolerance (working px), smoothing, noise floors. */
export type PrecisionDetail = "low" | "medium" | "high" | "ultra";

export function precisionOptionsFor(
  detail: PrecisionDetail,
  threshold: number,
  invert: boolean,
  workingMaxDim: number,
  /** working px per source px (> 1 when a small upload was upscaled) */
  upscale = 1
): PrecisionTraceOptions {
  // Tolerance is in SOURCE pixels (an upscaled small image holds no extra
  // detail to chase), with a floor relative to the image size so a huge
  // upload doesn't spend nodes on sub-pixel wobble nobody can see.
  const rel = workingMaxDim / 1000;
  const up = Math.max(1, upscale);
  const table: Record<PrecisionDetail, { tolPx: number; tolRel: number; blur: number; speck: number; corner: number }> = {
    low: { tolPx: 1.2, tolRel: 1.2, blur: 2, speck: 30, corner: 50 },
    medium: { tolPx: 0.7, tolRel: 0.6, blur: 1, speck: 16, corner: 48 },
    high: { tolPx: 0.4, tolRel: 0.3, blur: 1, speck: 9, corner: 45 },
    ultra: { tolPx: 0.25, tolRel: 0.15, blur: 0, speck: 5, corner: 42 },
  };
  const t = table[detail];
  const tolerance = Math.max(t.tolPx * up, t.tolRel * rel);
  const areaScale = Math.max(1, rel * rel);
  return {
    threshold,
    invert,
    tolerance,
    blurPasses: t.blur,
    minArea: t.speck * areaScale,
    minHoleArea: t.speck * areaScale,
    cornerAngle: t.corner,
  };
}

/** Full raster pipeline on RGBA pixels (working resolution). */
export function traceRGBA(
  rgba: ArrayLike<number>,
  w: number,
  h: number,
  opts: PrecisionTraceOptions,
  channels = 4
): FieldTraceResult {
  const f = inkField(rgba, w, h, opts.threshold, opts.invert, channels);
  blurField(f, w, h, opts.blurPasses);
  cleanField(f, w, h, opts.minArea, opts.minHoleArea);
  return traceField(f, w, h, opts);
}

// ---------------------------------------------------------------------------
// 5. Open curves (Brush centerlines)
// ---------------------------------------------------------------------------

/**
 * Fewest-node cubic Bézier fit of an OPEN polyline (a freehand brush
 * centerline), within `tolerance` of every input point. Sharp turns
 * (corner test at two scales, as for traced outlines) stay corners; every
 * other join is smooth (G1). Used so a saved brush stroke keeps exactly the
 * path that was on screen while drawing, with only a handful of editable
 * nodes.
 */
export function fitOpenCurve(raw: Point[], tolerance: number, cornerAngleDeg = 70, cornerScale = 4): PathNode[] {
  const pts: Point[] = [];
  for (const p of raw) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-6) pts.push({ x: p.x, y: p.y });
  }
  const n = pts.length;
  const mk = (point: Point, type: PathNode["type"]): PathNode => ({ id: shortId("node"), point, handleIn: null, handleOut: null, type });
  if (n < 2) return [];
  if (n === 2) return [mk(pts[0], "corner"), mk(pts[1], "corner")];
  const tol = Math.max(1e-3, tolerance);
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + len(sub(pts[i], pts[i - 1]));
  const L = s[n - 1];
  const at = (pos: number): Point => {
    const p = Math.max(0, Math.min(L, pos));
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid] <= p) lo = mid; else hi = mid; }
    const seg = s[hi] - s[lo];
    const t = seg > 1e-12 ? (p - s[lo]) / seg : 0;
    return { x: pts[lo].x + (pts[hi].x - pts[lo].x) * t, y: pts[lo].y + (pts[hi].y - pts[lo].y) * t };
  };
  const r = Math.max(tol * 3, cornerScale);
  const turn = (i: number, rr: number) => {
    if (s[i] - rr < 0 || s[i] + rr > L) return 0;
    const u = unit(sub(pts[i], at(s[i] - rr)));
    const v = unit(sub(at(s[i] + rr), pts[i]));
    return Math.acos(Math.max(-1, Math.min(1, dot(u, v))));
  };
  const angle = (cornerAngleDeg * Math.PI) / 180;
  const sharp = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const big = turn(i, r);
    if (big < angle) continue;
    if (turn(i, r * 0.5) < big * 0.55) continue;
    sharp[i] = big;
  }
  const isCorner = new Uint8Array(n);
  for (let i = 1; i < n - 1; i++) {
    if (!sharp[i]) continue;
    let isMax = true;
    for (let j = i + 1; j < n && s[j] - s[i] <= r && isMax; j++) if (sharp[j] > sharp[i]) isMax = false;
    for (let j = i - 1; j >= 0 && s[i] - s[j] <= r && isMax; j--) if (sharp[j] >= sharp[i]) isMax = false;
    if (isMax) isCorner[i] = 1;
  }
  const h = Math.max(tol * 2, r * 0.5);
  const tanOut = (i: number): V => (i === 0 || isCorner[i] ? unit(sub(at(s[i] + h), pts[i])) : unit(sub(at(s[i] + h), at(s[i] - h))));
  const tanIn = (i: number): V => (i === n - 1 || isCorner[i] ? unit(sub(pts[i], at(s[i] - h))) : unit(sub(at(s[i] + h), at(s[i] - h))));

  const breaks: number[] = [0];
  for (let i = 1; i < n - 1; i++) if (isCorner[i]) breaks.push(i);
  breaks.push(n - 1);

  interface OSeg { p0: V; c1: V | null; c2: V | null; p3: V; i0: number; i1: number }
  const segs: OSeg[] = [];
  for (let b = 0; b + 1 < breaks.length; b++) {
    const k0 = breaks[b], k1 = breaks[b + 1];
    const whole = pts.slice(k0, k1 + 1);
    if (lineError(whole) <= tol * 0.6) {
      segs.push({ p0: pts[k0], c1: null, c2: null, p3: pts[k1], i0: k0, i1: k1 });
      continue;
    }
    let a = k0;
    let tA = tanOut(k0);
    while (a < k1) {
      const tryFit = (j: number) => {
        const tB = mul(tanIn(j), -1);
        return { fit: fitCubic(pts.slice(a, j + 1), tA, tB), tB };
      };
      let good = a + 1;
      let goodFit = tryFit(good);
      if (good < k1) {
        let step = 4;
        let bad = -1;
        for (;;) {
          const j = Math.min(k1, a + step);
          const rr = tryFit(j);
          if (rr.fit.err <= tol) { good = j; goodFit = rr; if (j === k1) break; step *= 2; }
          else { bad = j; break; }
        }
        if (bad > 0) {
          let lo = good, hi = bad;
          while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            const rr = tryFit(mid);
            if (rr.fit.err <= tol) { lo = mid; goodFit = rr; } else hi = mid;
          }
          good = lo;
        }
      }
      segs.push({ p0: pts[a], c1: goodFit.fit.c1, c2: goodFit.fit.c2, p3: pts[good], i0: a, i1: good });
      tA = mul(goodFit.tB, -1);
      a = good;
    }
  }
  // merge smooth joins one curve can cover
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10) {
    changed = false;
    for (let k = 0; k + 1 < segs.length; k++) {
      const A = segs[k], B = segs[k + 1];
      if (isCorner[B.i0] || !A.c1 || !A.c2 || !B.c1 || !B.c2) continue;
      const tA = unit(sub(A.c1, A.p0));
      const tB = unit(sub(B.c2, B.p3));
      const fit = fitCubic(pts.slice(A.i0, B.i1 + 1), tA, tB);
      if (fit.err > tol) continue;
      segs.splice(k, 2, { p0: A.p0, c1: fit.c1, c2: fit.c2, p3: B.p3, i0: A.i0, i1: B.i1 });
      changed = true;
    }
  }
  const nodes: PathNode[] = segs.map((sg) => mk({ x: sg.p0.x, y: sg.p0.y }, isCorner[sg.i0] ? "corner" : "smooth"));
  const lastSeg = segs[segs.length - 1];
  nodes.push(mk({ x: lastSeg.p3.x, y: lastSeg.p3.y }, "smooth"));
  segs.forEach((sg, k) => {
    nodes[k].handleOut = sg.c1 ? { x: sg.c1.x, y: sg.c1.y } : null;
    nodes[k + 1].handleIn = sg.c2 ? { x: sg.c2.x, y: sg.c2.y } : null;
  });
  return nodes;
}
