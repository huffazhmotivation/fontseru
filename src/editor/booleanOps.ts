import type { Point, PathNode, NodeType, Contour, VectorObject } from "@/types/geometry";
import { isFilledObject } from "@/types/geometry";
import { flattenContour } from "./objectOps";
import { cubicPoint, cubicTangent, splitCubic } from "./bezier";
import { simplifyPolyline } from "@/utils/simplify";
import { closedRingHasCrossing, closedRingsHaveCrossing } from "@/utils/segmentGrid";
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

// Shared "how faithfully should a refit curve track the original" knob for
// every caller of `normalizeSelfIntersectingContours`/`applyBooleanOp` that
// wants export-grade fidelity instead of the loose interactive default (see
// `ringSimplifyTolerance`'s doc comment for what the scale actually does).
// Previously duplicated as a private constant inside fontIO.ts (export's own
// call sites) — pulled out here as the single source of truth so any other
// caller that wants the SAME "don't visibly reshape my curve" guarantee
// (e.g. `expandStrokeObject` in strokeToOutline.ts) uses the exact same
// value instead of drifting out of sync with export's.
export const TIGHT_CURVE_FIDELITY_SCALE = 0.12;

/**
 * Even tighter refit fidelity used ONLY for the exact stroke-Expand union
 * (`unionPolygonsToContours`). Expand is a one-shot user action whose whole
 * point is a filled shape that matches the pre-expand preview exactly, so we
 * refit the union boundary at ~a third of the already-tight export tolerance
 * — pushing the boundary deviation well under a quarter font unit — at the
 * cost of a few more nodes, which is the right trade for a final conversion.
 */
export const EXPAND_FIDELITY_SCALE = 0.04;

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

// Coordinates get snapped to this many font-unit decimal places before
// they're handed to the exact clipper. `polygon-clipping` uses exact
// rational arithmetic internally, which means it's very literal about what
// counts as "the same point" or "a straight edge": two samples that differ
// by 1e-10 due to float rounding are treated as genuinely distinct, and a
// hand-drawn curve flattened at CLIP_SAMPLE_STEPS density is exactly the
// kind of input that produces long runs of nearly (but not exactly)
// collinear points. That's a well-known source of degenerate/wrong output
// from exact polygon clippers. Snapping first turns "nearly the same" into
// "exactly the same" so dedup below actually catches it.
const COORD_SNAP = 100; // 0.01 font-unit precision

function snap(v: number): number {
  return Math.round(v * COORD_SNAP) / COORD_SNAP;
}

// Drops consecutive duplicate points (after snapping) and any point that's
// essentially sitting on top of its neighbor, which otherwise hands the
// clipper a zero-length edge — another common trigger for topology errors
// in exact boolean ops. Keeps the ring's own closing edge intact (doesn't
// dedupe first-vs-last; toRing/ringToPoints already handle that).
function dedupePoints(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const s = { x: snap(p.x), y: snap(p.y) };
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev.x - s.x) > 1e-9 || Math.abs(prev.y - s.y) > 1e-9) out.push(s);
  }
  // Drop a duplicate closing point (ring wraps back onto its own start).
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) out.pop();
  }
  return out;
}

// Extra pass BEFORE handing points to the exact clipper, on top of the
// coordinate snapping above. Font curves flattened at CLIP_SAMPLE_STEPS
// density carry long, nearly (but not exactly) straight runs of points —
// snapping alone doesn't remove those, since consecutive samples along a
// real curve genuinely sit at slightly different coordinates a few
// hundredths of a unit apart, which is "real" geometry, not float noise.
// Handing an exact rational-arithmetic clipper thousands of such
// near-collinear vertices is a known trigger for it to report spurious
// micro self-intersections along an otherwise perfectly smooth edge —
// every one becomes a near-zero-area sliver "contour" in the result (see
// MIN_CONTOUR_AREA below, and the doc comment on multiPolygonToContours).
// A light Douglas-Peucker pass here — tight enough (a fraction of a font
// unit) that it only removes points that don't change the visible shape at
// all — thins those near-collinear runs out before they ever reach the
// clipper, so there's far less raw material for it to misread as
// self-crossings in the first place. This is intentionally much tighter
// than the *post*-clip simplification in multiPolygonToContours, which is
// refitting the final curve shape for editability, not just decimating
// redundant polygon points.
const PRECLIP_SIMPLIFY_EPSILON = 0.75; // font units

/**
 * One source contour flattened for the clipper, remembering where every
 * polygon vertex sits on the ORIGINAL Bézier path. `u` is a curve position:
 * the integer part is the segment index (segment i runs from node i to node
 * i+1, wrapping), the fraction is that segment's own t. This is what lets a
 * clipped ring be mapped back onto the exact original curves (see
 * `reconstructRingFromSources`) instead of being refit from its polygon.
 */
interface SourceRing {
  contour: Contour;
  pts: Point[];
  /** u[k] is the curve position of pts[k]; u[pts.length] === nSeg closes the loop. */
  u: number[];
  nSeg: number;
}

interface TrackedPoint extends Point {
  u: number;
}

interface SegmentCubic {
  p0: Point;
  /** null = no handle on that side (the original node had none). */
  c1: Point | null;
  c2: Point | null;
  p3: Point;
}

/** Segment i of a filled contour. An open contour is still filled as if
 * closed, so its implicit closing edge (last node → first) is a straight line. */
function segmentCubic(c: Contour, i: number): SegmentCubic {
  const n = c.nodes.length;
  const from = c.nodes[i];
  const to = c.nodes[(i + 1) % n];
  if (!c.closed && i === n - 1) return { p0: from.point, c1: null, c2: null, p3: to.point };
  return { p0: from.point, c1: from.handleOut, c2: to.handleIn, p3: to.point };
}

function trackContour(c: Contour): SourceRing | null {
  const n = c.nodes.length;
  if (n < 2) return null;
  // Flatten at a resolution that scales DOWN as the contour already has
  // more nodes. An expanded stroke contour can carry hundreds of Bézier
  // nodes; re-flattening every segment at the full CLIP_SAMPLE_STEPS
  // (48) then produced tens of thousands of points, which overwhelmed
  // the exact clipper and made it emit degenerate/empty rings — the
  // slashed-"0" counter vanished because its polygon came back broken.
  // Fewer steps on an already-dense contour keeps the point budget sane
  // while staying well within the pre-clip simplify tolerance below.
  const steps = n > 40 ? 4 : n > 16 ? 8 : CLIP_SAMPLE_STEPS;
  const pts: Point[] = [];
  const u: number[] = [];
  const push = (p: TrackedPoint) => {
    const prev = pts[pts.length - 1];
    if (prev && Math.abs(prev.x - p.x) < 1e-9 && Math.abs(prev.y - p.y) < 1e-9) return;
    pts.push({ x: p.x, y: p.y });
    u.push(p.u);
  };
  for (let i = 0; i < n; i++) {
    const seg = segmentCubic(c, i);
    const start: TrackedPoint = { x: snap(seg.p0.x), y: snap(seg.p0.y), u: i };
    if (!seg.c1 && !seg.c2) {
      push(start);
      continue;
    }
    const c1 = seg.c1 ?? seg.p0;
    const c2 = seg.c2 ?? seg.p3;
    const samples: TrackedPoint[] = [start];
    for (let k = 1; k < steps; k++) {
      const p = cubicPoint(seg.p0, c1, c2, seg.p3, k / steps);
      samples.push({ x: snap(p.x), y: snap(p.y), u: i + k / steps });
    }
    samples.push({ x: snap(seg.p3.x), y: snap(seg.p3.y), u: i + 1 });
    // Simplified PER SEGMENT (both ends pinned) rather than over the whole
    // ring, so every polygon edge stays inside one Bézier segment and every
    // original node stays a polygon vertex — see PRECLIP_SIMPLIFY_EPSILON
    // for why the near-collinear samples are thinned at all.
    const kept = simplifyPolyline(samples, PRECLIP_SIMPLIFY_EPSILON);
    // The last kept sample is the next segment's start — pushed by it.
    for (let k = 0; k < kept.length - 1; k++) push(kept[k]);
  }
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) {
      pts.pop();
      u.pop();
    }
  }
  if (pts.length < 3) return null;
  u.push(n);
  return { contour: c, pts, u, nSeg: n };
}

function contourSourceRings(contours: Contour[]): SourceRing[] {
  const out: SourceRing[] = [];
  for (const c of contours) {
    const r = trackContour(c);
    if (r) out.push(r);
  }
  return out;
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
 *
 * Bug this fixes: a single hand-drawn contour that self-intersects — very
 * common for a one-stroke freehand letter where the path crosses back over
 * itself (e.g. near the neck of a "g" or "e") — used to skip normalization
 * entirely (the XOR pass only ran when an object had 2+ *separate*
 * contours) and get handed straight to the exact clipper as-is. A
 * self-intersecting ring is not a valid simple polygon, and exact clippers
 * can resolve it into unexpected/degenerate geometry — including a
 * Subtract silently collapsing to just the front (cutting) shape. Running
 * every object's rings through `clipUnion` first — even a single ring on
 * its own — forces the same self-intersection resolution multi-contour
 * objects already got, so Subtract/Union/Intersect always start from
 * clean, simple polygons regardless of how the shape was drawn.
 */
function sourceRingsToMultiPolygon(sources: SourceRing[]): ClipMultiPolygon {
  if (sources.length === 0) return [];
  const rings: ClipPolygon[] = sources.map((s) => [toRing(s.pts)]);
  try {
    return rings.length === 1 ? clipUnion(rings[0]) : clipXor(rings[0], ...rings.slice(1));
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

  // Zero OR one corner can't partition the loop into corner-to-corner runs
  // (one corner makes a single run from itself back to itself, which the
  // run builder below collapses to nothing — that dropped a real hole/
  // counter entirely, e.g. the two counters of a slashed "0", turning them
  // into empty contours). Treat "too few corners to partition" the same as
  // the no-corner case: simplify the whole loop as one smooth run. The lone
  // corner (if any) is preserved as smooth; a single vertex out of a
  // ~100-point counter reading smooth instead of hard is imperceptible and
  // far better than losing the counter.
  if (cornerIdx.length < 2) {
    const simplified = simplifyPolyline(ring, epsilon);
    const pts = simplified.length >= 3 ? simplified : ring;
    return { points: pts, isCorner: pts.map(() => false) };
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
  // Safety net: never return a degenerate ring — if the corner-run walk
  // somehow produced < 3 points, fall back to a plain simplify of the
  // whole loop so a real contour is never silently dropped.
  if (outPoints.length < 3) {
    const simplified = simplifyPolyline(ring, epsilon);
    const pts = simplified.length >= 3 ? simplified : ring;
    return { points: pts, isCorner: pts.map(() => false) };
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
// `scale` lets a caller ask for a tighter (more faithful) or looser (more
// editable) simplification than the interactive default without changing
// that default for everyone. See EXPORT_CURVE_FIDELITY_SCALE in fontIO.ts.
function ringSimplifyTolerance(ring: Point[], scale = 1): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  return Math.min(10, Math.max(1.25, diag * 0.012)) * scale;
}

/* ------------------------------------------------------------------ *
 * CURVE-PRESERVING RECONSTRUCTION
 *
 * Bug this fixes ("shape berubah bentuk / titik node berantakan setelah
 * boolean"): every boolean op used to throw the original Béziers away and
 * refit the WHOLE result from the clipper's polygon — new node positions,
 * new handles, a different node count — even along edges the other shape
 * never touched. A clipped ring is, by construction, made of pieces of the
 * input polygons' own edges joined at intersection points. Since every
 * input vertex remembers its curve position (`SourceRing.u`), each run of
 * the ring that follows one source contour maps straight back onto that
 * contour's ORIGINAL segments: untouched nodes come back bit-identical
 * (same point, same handles, same type), segments that were cut are split
 * exactly with De Casteljau, and the only new nodes are the real
 * intersection points, solved on the true curves (not the polygon chords).
 * Any ring that can't be mapped cleanly falls back to the old refit.
 * ------------------------------------------------------------------ */

// Max distance (font units) a clipped vertex may sit from an input polygon
// edge and still count as lying on it. Clipper output is exact to ~1e-10.
const LOCATE_TOL = 1e-3;

function modU(u: number, n: number): number {
  const m = u % n;
  return m < 0 ? m + n : m;
}

/** Shortest signed difference a − b on a loop of length n. */
function signedUDelta(a: number, b: number, n: number): number {
  let d = (a - b) % n;
  if (d > n / 2) d -= n;
  if (d < -n / 2) d += n;
  return d;
}

function segParam(r: SourceRing, u: number): { seg: number; t: number } {
  const w = modU(u, r.nSeg);
  const seg = Math.min(r.nSeg - 1, Math.floor(w));
  return { seg, t: Math.min(1, Math.max(0, w - seg)) };
}

function pointAtU(r: SourceRing, u: number): Point {
  const { seg, t } = segParam(r, u);
  const s = segmentCubic(r.contour, seg);
  if (!s.c1 && !s.c2) return { x: s.p0.x + (s.p3.x - s.p0.x) * t, y: s.p0.y + (s.p3.y - s.p0.y) * t };
  return cubicPoint(s.p0, s.c1 ?? s.p0, s.c2 ?? s.p3, s.p3, t);
}

function derivAtU(r: SourceRing, u: number): Point {
  const { seg, t } = segParam(r, u);
  const s = segmentCubic(r.contour, seg);
  if (!s.c1 && !s.c2) return { x: s.p3.x - s.p0.x, y: s.p3.y - s.p0.y };
  return cubicTangent(s.p0, s.c1 ?? s.p0, s.c2 ?? s.p3, s.p3, t);
}

/** Snaps a curve position onto an existing node when it is (visually) on
 * it, so a cut that lands on a node doesn't leave a near-duplicate node. */
function snapUToNode(r: SourceRing, u: number): number {
  const k = Math.round(u);
  if (Math.abs(u - k) > 0.02) return u;
  const node = r.contour.nodes[modU(k, r.nSeg)];
  const p = pointAtU(r, u);
  return Math.hypot(p.x - node.point.x, p.y - node.point.y) < 0.05 ? k : u;
}

/** Newton solve for the true curve–curve intersection nearest the
 * clipper's polygon intersection `x`. Null when the curves are tangent
 * there or the solve wanders off, in which case the caller keeps `x`. */
function intersectCurvesNear(a: SourceRing, ua0: number, b: SourceRing, ub0: number, x: Point): { ua: number; ub: number; p: Point } | null {
  let ua = ua0;
  let ub = ub0;
  for (let it = 0; it < 16; it++) {
    const pa = pointAtU(a, ua);
    const pb = pointAtU(b, ub);
    const fx = pa.x - pb.x;
    const fy = pa.y - pb.y;
    if (fx * fx + fy * fy < 1e-16) break;
    const da = derivAtU(a, ua);
    const db = derivAtU(b, ub);
    // J = [da, -db]; solve J·[dua, dub] = -F by Cramer's rule.
    const det = da.x * -db.y - -db.x * da.y;
    const scale = Math.hypot(da.x, da.y) * Math.hypot(db.x, db.y);
    if (!(scale > 0) || Math.abs(det) < 1e-6 * scale) return null;
    let dua = (-fx * -db.y - -db.x * -fy) / det;
    let dub = (da.x * -fy - -fx * da.y) / det;
    dua = Math.max(-0.25, Math.min(0.25, dua));
    dub = Math.max(-0.25, Math.min(0.25, dub));
    ua += dua;
    ub += dub;
  }
  if (Math.abs(signedUDelta(ua, ua0, a.nSeg)) > 0.5 || Math.abs(signedUDelta(ub, ub0, b.nSeg)) > 0.5) return null;
  ua = snapUToNode(a, modU(ua, a.nSeg));
  ub = snapUToNode(b, modU(ub, b.nSeg));
  const pa = pointAtU(a, ua);
  const pb = pointAtU(b, ub);
  if (Math.hypot(pa.x - pb.x, pa.y - pb.y) > 0.05) return null;
  const p = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
  if (Math.hypot(p.x - x.x, p.y - x.y) > 4) return null;
  return { ua, ub, p };
}

/** Uniform grid over every source polygon edge, for locating which input
 * edge each clipped edge came from. */
class SourceEdgeGrid {
  readonly cell: number;
  private readonly cells = new Map<number, number[]>();
  readonly edgeRing: number[] = [];
  readonly edgeK: number[] = [];

  constructor(readonly rings: SourceRing[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rings) for (const p of r.pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    this.cell = Math.max(1, Math.hypot(maxX - minX, maxY - minY) / 128);
    rings.forEach((r, ri) => {
      const n = r.pts.length;
      for (let k = 0; k < n; k++) {
        const p = r.pts[k];
        const q = r.pts[(k + 1) % n];
        const id = this.edgeRing.length;
        this.edgeRing.push(ri);
        this.edgeK.push(k);
        const x0 = Math.floor((Math.min(p.x, q.x) - LOCATE_TOL) / this.cell);
        const x1 = Math.floor((Math.max(p.x, q.x) + LOCATE_TOL) / this.cell);
        const y0 = Math.floor((Math.min(p.y, q.y) - LOCATE_TOL) / this.cell);
        const y1 = Math.floor((Math.max(p.y, q.y) + LOCATE_TOL) / this.cell);
        for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
          const key = this.key(ix, iy);
          const list = this.cells.get(key);
          if (list) list.push(id);
          else this.cells.set(key, [id]);
        }
      }
    });
  }

  private key(ix: number, iy: number): number {
    return (ix + 50000) * 100003 + (iy + 50000);
  }

  /** Every edge whose (padded) bounds touch the box — a superset. */
  queryBox(minX: number, minY: number, maxX: number, maxY: number): Set<number> {
    const out = new Set<number>();
    for (let ix = Math.floor(minX / this.cell); ix <= Math.floor(maxX / this.cell); ix++) {
      for (let iy = Math.floor(minY / this.cell); iy <= Math.floor(maxY / this.cell); iy++) {
        const list = this.cells.get(this.key(ix, iy));
        if (list) for (const id of list) out.add(id);
      }
    }
    return out;
  }

  query(p: Point): number[] {
    return this.cells.get(this.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell))) ?? [];
  }
}

/** Where on the source polygons a clipped edge a→b lies. */
interface LocatedEdge {
  ring: number;
  dir: 1 | -1;
  ua: number;
  ub: number;
  /** Curve-position length covered (always > 0). */
  lenU: number;
  score: number;
}

function projectOnSegment(p: Point, a: Point, b: Point): { f: number; dist: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const f = lenSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq)) : 0;
  return { f, dist: Math.hypot(p.x - (a.x + dx * f), p.y - (a.y + dy * f)) };
}

function locateEdge(a: Point, b: Point, grid: SourceEdgeGrid, prev: LocatedEdge | null): LocatedEdge | null {
  let best: LocatedEdge | null = null;
  const consider = (hit: LocatedEdge) => {
    if (prev && hit.ring === prev.ring && hit.dir === prev.dir) {
      const r = grid.rings[hit.ring];
      if (Math.abs(signedUDelta(hit.ua, prev.ub, r.nSeg)) < 1e-6) hit.score -= 1;
    }
    if (!best || hit.score < best.score) best = hit;
  };
  for (const id of grid.query(a)) {
    const ri = grid.edgeRing[id];
    const r = grid.rings[ri];
    const n = r.pts.length;
    const k = grid.edgeK[id];
    const p = r.pts[k];
    const q = r.pts[(k + 1) % n];
    const pa = projectOnSegment(a, p, q);
    if (pa.dist > LOCATE_TOL) continue;
    const ua = r.u[k] + pa.f * (r.u[k + 1] - r.u[k]);
    const pb = projectOnSegment(b, p, q);
    if (pb.dist <= LOCATE_TOL) {
      if (Math.abs(pb.f - pa.f) < 1e-12) continue;
      const ub = r.u[k] + pb.f * (r.u[k + 1] - r.u[k]);
      consider({ ring: ri, dir: pb.f > pa.f ? 1 : -1, ua, ub, lenU: Math.abs(ub - ua), score: pa.dist + pb.dist });
      continue;
    }
    // The clipper drops exactly-collinear vertices, so one clipped edge can
    // span several consecutive input edges (a straight line split by a
    // node). Walk along the ring while its vertices stay on a→b.
    const dir: 1 | -1 = (q.x - p.x) * (b.x - a.x) + (q.y - p.y) * (b.y - a.y) >= 0 ? 1 : -1;
    let lenU = dir > 0 ? r.u[k + 1] - ua : ua - r.u[k];
    let j = k;
    for (let step = 0; step < 64; step++) {
      const v = r.pts[dir > 0 ? (j + 1) % n : j];
      if (projectOnSegment(v, a, b).dist > LOCATE_TOL) break;
      j = dir > 0 ? (j + 1) % n : (j - 1 + n) % n;
      const hitB = projectOnSegment(b, r.pts[j], r.pts[(j + 1) % n]);
      if (hitB.dist <= LOCATE_TOL) {
        const ub = r.u[j] + hitB.f * (r.u[j + 1] - r.u[j]);
        lenU += dir > 0 ? ub - r.u[j] : r.u[j + 1] - ub;
        if (lenU > 0) consider({ ring: ri, dir, ua, ub, lenU, score: pa.dist + hitB.dist + 1e-4 });
        break;
      }
      lenU += r.u[j + 1] - r.u[j];
    }
  }
  return best;
}

interface CurvePiece {
  p0: Point;
  c1: Point | null;
  c2: Point | null;
  p3: Point;
  /** The original node this piece starts on, when it starts exactly on one. */
  startNode: PathNode | null;
}

function subPiece(r: SourceRing, seg: number, t0: number, t1: number): CurvePiece {
  const s = segmentCubic(r.contour, seg);
  if (!s.c1 && !s.c2) {
    const at = (t: number) => (t === 0 ? s.p0 : t === 1 ? s.p3 : { x: s.p0.x + (s.p3.x - s.p0.x) * t, y: s.p0.y + (s.p3.y - s.p0.y) * t });
    return { p0: at(t0), c1: null, c2: null, p3: at(t1), startNode: null };
  }
  let q: [Point, Point, Point, Point] = [s.p0, s.c1 ?? s.p0, s.c2 ?? s.p3, s.p3];
  if (t1 < 1) q = splitCubic(q[0], q[1], q[2], q[3], t1).left;
  if (t0 > 0) q = splitCubic(q[0], q[1], q[2], q[3], t0 / t1).right;
  return {
    p0: t0 === 0 ? s.p0 : q[0],
    c1: t0 === 0 && !s.c1 ? null : q[1],
    c2: t1 === 1 && !s.c2 ? null : q[2],
    p3: t1 === 1 ? s.p3 : q[3],
    startNode: null,
  };
}

/** The original contour's path from curve position `uStart`, `len` long,
 * walking forward (dir 1) or backward (dir −1), as exact Bézier pieces. */
function extractPieces(r: SourceRing, uStart: number, len: number, dir: 1 | -1): CurvePiece[] {
  const n = r.nSeg;
  const out: CurvePiece[] = [];
  const partial = new Set<CurvePiece>();
  let u = modU(uStart, n);
  let remaining = Math.min(len, n);
  for (let guard = 0; remaining > 1e-9 && guard < n * 2 + 4; guard++) {
    if (dir > 0) {
      let seg = Math.floor(u);
      if (seg >= n) {
        seg -= n;
        u -= n;
      }
      const t0 = Math.max(0, u - seg);
      const t1 = Math.min(1, t0 + remaining);
      const piece = subPiece(r, seg, t0, t1);
      if (t0 === 0) piece.startNode = r.contour.nodes[seg];
      if (t0 > 0 || t1 < 1) partial.add(piece);
      out.push(piece);
      remaining -= t1 - t0;
      u = t1 >= 1 ? seg + 1 : seg + t1;
    } else {
      let seg = Math.ceil(u) - 1;
      if (seg < 0) {
        seg += n;
        u += n;
      }
      const t1 = Math.min(1, u - seg);
      const t0 = Math.max(0, t1 - remaining);
      const fwd = subPiece(r, seg, t0, t1);
      const piece: CurvePiece = {
        p0: fwd.p3,
        c1: fwd.c2,
        c2: fwd.c1,
        p3: fwd.p0,
        startNode: t1 === 1 ? r.contour.nodes[(seg + 1) % n] : null,
      };
      if (t0 > 0 || t1 < 1) partial.add(piece);
      out.push(piece);
      remaining -= t1 - t0;
      u = seg + t0;
    }
  }
  // Drop slivers left by a cut landing a hair away from a node. Whole
  // original segments are always kept, however short, so an untouched
  // contour comes back with exactly its own nodes.
  return out.filter((pc) => {
    if (!partial.has(pc)) return true;
    const span = Math.max(
      Math.hypot(pc.p3.x - pc.p0.x, pc.p3.y - pc.p0.y),
      pc.c1 ? Math.hypot(pc.c1.x - pc.p0.x, pc.c1.y - pc.p0.y) : 0,
      pc.c2 ? Math.hypot(pc.c2.x - pc.p3.x, pc.c2.y - pc.p3.y) : 0,
    );
    return span > 0.02;
  });
}

function flattenPieces(pieces: CurvePiece[]): Point[] {
  const out: Point[] = [];
  for (const pc of pieces) {
    out.push(pc.p0);
    if (pc.c1 || pc.c2) {
      const c1 = pc.c1 ?? pc.p0;
      const c2 = pc.c2 ?? pc.p3;
      for (let k = 1; k < 8; k++) out.push(cubicPoint(pc.p0, c1, c2, pc.p3, k / 8));
    }
  }
  return out;
}

function piecesToNodes(pieces: CurvePiece[]): PathNode[] {
  const count = pieces.length;
  return pieces.map((pc, i) => {
    const before = pieces[(i - 1 + count) % count];
    const handleIn = before.c2 ? { ...before.c2 } : null;
    const handleOut = pc.c1 ? { ...pc.c1 } : null;
    const src = pc.startNode;
    let type: NodeType = src ? src.type : "corner";
    if (type === "symmetric" && handleIn && handleOut) {
      const lin = Math.hypot(handleIn.x - pc.p0.x, handleIn.y - pc.p0.y);
      const lout = Math.hypot(handleOut.x - pc.p0.x, handleOut.y - pc.p0.y);
      if (Math.abs(lin - lout) > 0.01 * Math.max(lin, lout, 1e-9)) type = "smooth";
    }
    const node: PathNode = { id: shortId("node"), point: { ...pc.p0 }, handleIn, handleOut, type };
    if (src?.filletTag) node.filletTag = src.filletTag;
    return node;
  });
}

interface RingRun {
  /** "line" = a clipped edge that couldn't be located on any source. */
  kind: "curve" | "line";
  ring: number;
  dir: 1 | -1;
  uStart: number;
  uEnd: number;
  lenU: number;
}

/**
 * Rebuilds one clipped ring (already oriented the way the caller wants it)
 * from the source contours' original Bézier segments. Returns null when
 * the ring can't be mapped cleanly, so the caller falls back to a refit.
 */
function reconstructRingFromSources(ring: Point[], grid: SourceEdgeGrid): PathNode[] | null {
  const m = ring.length;
  if (m < 3) return null;
  const rings = grid.rings;

  const located: (LocatedEdge | null)[] = new Array(m);
  let prev: LocatedEdge | null = null;
  let misses = 0;
  for (let i = 0; i < m; i++) {
    const hit = locateEdge(ring[i], ring[(i + 1) % m], grid, prev);
    located[i] = hit;
    if (!hit) misses++;
    prev = hit;
  }
  if (misses > Math.max(1, Math.floor(m * 0.02))) return null;

  // Vertex i joins edge i−1 to edge i; it's a break wherever the ring stops
  // following one source contour continuously.
  const breaks: number[] = [];
  for (let i = 0; i < m; i++) {
    const e0 = located[(i - 1 + m) % m];
    const e1 = located[i];
    if (!e0 || !e1 || e0.ring !== e1.ring || e0.dir !== e1.dir || Math.abs(signedUDelta(e0.ub, e1.ua, rings[e0.ring].nSeg)) > 1e-6) {
      breaks.push(i);
    }
  }

  let pieces: CurvePiece[];
  if (breaks.length === 0) {
    // The whole ring is one source contour, untouched: hand it back as-is.
    const e = located[0]!;
    const r = rings[e.ring];
    const total = located.reduce((sum, le) => sum + le!.lenU, 0);
    if (Math.abs(total - r.nSeg) > 1e-3) return null;
    pieces = extractPieces(r, 0, r.nSeg, e.dir);
  } else {
    const runs: RingRun[] = [];
    for (let bi = 0; bi < breaks.length; bi++) {
      const s = breaks[bi];
      let count = (breaks[(bi + 1) % breaks.length] - s + m) % m;
      if (count === 0) count = m;
      const first = located[s];
      if (!first) {
        runs.push({ kind: "line", ring: -1, dir: 1, uStart: 0, uEnd: 0, lenU: 0 });
        continue;
      }
      let lenU = 0;
      for (let k = 0; k < count; k++) lenU += located[(s + k) % m]!.lenU;
      const last = located[(s + count - 1) % m]!;
      runs.push({ kind: "curve", ring: first.ring, dir: first.dir, uStart: first.ua, uEnd: last.ub, lenU });
    }

    // Solve each break on the true curves instead of the polygon chords.
    const R = runs.length;
    const breakPts: Point[] = breaks.map((i) => ring[i]);
    for (let bi = 0; bi < R; bi++) {
      const inc = runs[(bi - 1 + R) % R];
      const out = runs[bi];
      if (inc.kind !== "curve" || out.kind !== "curve") continue;
      const ra = rings[inc.ring];
      const rb = rings[out.ring];
      const res = intersectCurvesNear(ra, inc.uEnd, rb, out.uStart, breakPts[bi]);
      if (!res) continue;
      const dIn = inc.dir * signedUDelta(res.ua, inc.uEnd, ra.nSeg);
      const dOut = -out.dir * signedUDelta(res.ub, out.uStart, rb.nSeg);
      const inLen = inc.lenU + dIn + (inc === out ? dOut : 0);
      const outLen = out.lenU + dOut + (inc === out ? dIn : 0);
      if (inLen <= 1e-7 || outLen <= 1e-7) continue;
      inc.uEnd = res.ua;
      out.uStart = res.ub;
      inc.lenU = inLen;
      if (inc !== out) out.lenU = outLen;
      breakPts[bi] = res.p;
    }

    pieces = [];
    for (let bi = 0; bi < R; bi++) {
      const run = runs[bi];
      const p0 = breakPts[bi];
      const p1 = breakPts[(bi + 1) % R];
      let ps: CurvePiece[] = run.kind === "curve" ? extractPieces(rings[run.ring], run.uStart, run.lenU, run.dir) : [];
      if (ps.length === 0) {
        if (Math.hypot(p1.x - p0.x, p1.y - p0.y) <= 0.02) continue;
        ps = [{ p0, c1: null, c2: null, p3: p1, startNode: null }];
      }
      // Pin the run's ends onto the solved break points (moving the
      // adjacent handle along so the curve's tangent there is unchanged).
      const first = ps[0];
      const dx0 = p0.x - first.p0.x;
      const dy0 = p0.y - first.p0.y;
      first.p0 = { ...p0 };
      if (first.c1) first.c1 = { x: first.c1.x + dx0, y: first.c1.y + dy0 };
      first.startNode = null;
      const last = ps[ps.length - 1];
      const dx1 = p1.x - last.p3.x;
      const dy1 = p1.y - last.p3.y;
      last.p3 = { ...p1 };
      if (last.c2) last.c2 = { x: last.c2.x + dx1, y: last.c2.y + dy1 };
      pieces.push(...ps);
    }
  }
  if (pieces.length < 2 && !(pieces.length === 1 && (pieces[0].c1 || pieces[0].c2))) return null;

  // Sanity check against the clipper's own ring: same winding, same area
  // (up to polygon-vs-curve sagitta), same extent. Anything else means the
  // mapping went wrong somewhere, and the refit fallback is the safer bet.
  const rebuilt = flattenPieces(pieces);
  const ringArea = polygonArea(ring);
  const rebuiltArea = polygonArea(rebuilt);
  if (Math.sign(ringArea) !== Math.sign(rebuiltArea)) return null;
  let perimeter = 0;
  for (let i = 0; i < m; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % m];
    perimeter += Math.hypot(b.x - a.x, b.y - a.y);
  }
  if (Math.abs(rebuiltArea - ringArea) > perimeter * 1.5 + Math.abs(ringArea) * 0.01) return null;
  const rb = ringBounds(ring);
  const nb = ringBounds(rebuilt);
  const slack = 4 + Math.hypot(rb.maxX - rb.minX, rb.maxY - rb.minY) * 0.02;
  if (Math.abs(rb.minX - nb.minX) > slack || Math.abs(rb.maxX - nb.maxX) > slack || Math.abs(rb.minY - nb.minY) > slack || Math.abs(rb.maxY - nb.maxY) > slack) {
    return null;
  }
  return piecesToNodes(pieces);
}

/**
 * Turns a raw clip-library MultiPolygon result back into simplified,
 * correctly-nested closed contours with smooth handles refitted from local
 * curvature. Shared by `applyBooleanOp` (2+ object boolean ops) and
 * `normalizeSelfIntersectingContours` (single-shape self-intersection
 * cleanup) below, since both end with the exact same "raw clipped rings ->
 * editable contours" step.
 *
 * BUG FIX ("solid black glyphs" / vanished counters after Remove Overlap):
 * `polygon-clipping`'s MultiPolygon result is not a flat bag of rings — by
 * the library's own (GeoJSON-style) contract, `resultMulti[i]` is one
 * top-level shape, whose ring 0 is THAT shape's exterior and every ring
 * after it is a hole directly inside that exterior. That pairing is exact,
 * computed by the clipper itself; it needs no guessing.
 *
 * The previous code threw that structure away — it flattened every ring
 * from every polygon into one array and re-derived nesting from scratch by
 * testing each ring's first vertex for point-in-polygon containment against
 * every OTHER ring, exterior and hole alike. That re-derivation is exactly
 * where it broke: a union/clip result's exterior and its own hole almost
 * always share exactly-touching edges/vertices (that's what "the hole sits
 * inside the shape it was cut from" means geometrically), so testing a
 * hole's first point against its OWN exterior — or against a sibling hole —
 * is a classic on-boundary case for ray-casting point-in-polygon: floating
 * point puts it a hair inside or outside essentially at random. Get unlucky
 * and a hole's computed depth comes out even instead of odd (or vice
 * versa), `wantPositive` flips, the hole gets oriented the SAME winding as
 * its exterior instead of the opposite one, and the sfnt nonzero-winding
 * fill no longer punches it out — a counter (the inside of an "o", a
 * digit's bowl, ...) silently fills in solid. That's exactly the "cacat"
 * (solid black glyphs, blobby fused counters) reported after Remove
 * Overlap/export: the more contours a glyph's union produces (typical for
 * a multi-object hand-drawn "Clean" style letter), the more chances for
 * one on-boundary test to land wrong.
 *
 * Fix: trust the library's exterior/hole pairing within each polygon
 * outright (ring 0 = depth 0 relative to its own polygon, every other ring
 * in that same polygon = depth 1 relative to it — no test needed). The only
 * thing still genuinely ambiguous, and still requiring a containment check,
 * is whether one whole top-level polygon sits nested inside a DIFFERENT
 * polygon's hole (e.g. a dot/island resting inside a counter carved by a
 * separate shape) — so that check now only ever compares one polygon's
 * exterior against another polygon's exterior, never a hole against its own
 * exterior or a sibling hole, which removes the exact-touching-edge case
 * that was causing the misclassification.
 *
 * BUG FIX (stray black specks / "cacat" flecks scattered around otherwise
 * correct letters): even with clean input, an exact clipper resolving a
 * genuine self-intersection (two curves that actually cross, or nearly
 * graze, somewhere along a hand-drawn stroke) can legitimately produce a
 * handful of vanishingly small extra polygons right at the crossing —
 * confirmed directly against the installed `polygon-clipping` build: a real
 * self-crossing test shape came back with its main shape PLUS a separate
 * ~1-square-unit sliver alongside it, and the actually-exported OTFs from
 * this report have glyphs with a dozen-plus such sub-20-square-unit
 * "contours" scattered around them. At a 1000-unit em a real design feature
 * is always many orders of magnitude bigger than that (a serif tick or dot
 * still measures in the thousands of square units), so a sliver this small
 * is never intentional ink — it's exact-math fallout from a crossing that
 * was only ever a rounding-level graze. Left in, each one becomes its own
 * tiny filled (or hole) contour in the exported glyph. Dropping anything
 * under MIN_CONTOUR_AREA, for both exteriors and holes, removes exactly
 * that noise.
 */
const MIN_CONTOUR_AREA = 10; // font units^2 — see doc comment above

/** Clipper slivers are long and thin; a small ring that is compact (round
 * or square-ish — every triangle scores below this) is real ink, e.g. a
 * Spray Brush paint dot, and must survive the MIN_CONTOUR_AREA filter. */
const COMPACT_RING_QUOTIENT = 0.65;

function keepRing(pts: Point[]): boolean {
  if (pts.length < 3) return false;
  const area = Math.abs(polygonArea(pts));
  if (area >= MIN_CONTOUR_AREA) return true;
  let perimeter = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    perimeter += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return area > 0.05 && perimeter > 0 && (4 * Math.PI * area) / (perimeter * perimeter) >= COMPACT_RING_QUOTIENT;
}

function multiPolygonToContours(resultMulti: ClipMultiPolygon, toleranceScale = 1, sources?: SourceRing[]): Contour[] {
  if (!resultMulti || resultMulti.length === 0) return [];
  // With the source contours at hand, rings are rebuilt from their original
  // Béziers (see CURVE-PRESERVING RECONSTRUCTION); the refit below is only
  // the fallback for a ring that can't be mapped back.
  const grid = sources && sources.length > 0 ? new SourceEdgeGrid(sources) : null;

  const polys: Point[][][] = [];
  for (const poly of resultMulti) {
    if (poly.length === 0) continue;
    const exterior = ringToPoints(poly[0]);
    // A degenerate exterior means this whole top-level shape is clipper
    // noise (see doc comment) — skip it entirely rather than keeping
    // orphaned holes with nothing real left to cut into.
    if (!keepRing(exterior)) continue;
    const holes: Point[][] = [];
    for (let i = 1; i < poly.length; i++) {
      const pts = ringToPoints(poly[i]);
      if (keepRing(pts)) holes.push(pts);
    }
    polys.push([exterior, ...holes]);
  }
  if (polys.length === 0) return [];

  // Depth of each top-level polygon's OWN exterior, relative to every other
  // polygon's exterior only (never against holes — see doc comment above).
  const polyDepth = polys.map((poly, idx) => {
    let depth = 0;
    const p0 = poly[0][0];
    for (let k = 0; k < polys.length; k++) {
      if (k === idx) continue;
      if (pointInPolygon(p0, polys[k][0])) depth++;
    }
    return depth;
  });

  const contours: Contour[] = [];
  polys.forEach((poly, polyIdx) => {
    poly.forEach((ring, ringIdx) => {
      // Ring 0 is this polygon's exterior (same depth as the polygon
      // itself); every later ring is a hole one level deeper — both given
      // directly by the clipper, not guessed.
      const depth = polyDepth[polyIdx] + (ringIdx > 0 ? 1 : 0);
      const wantPositive = depth % 2 === 0;
      const area = polygonArea(ring);
      const oriented = (area > 0) === wantPositive ? ring : [...ring].reverse();
      const preserved = grid ? reconstructRingFromSources(oriented, grid) : null;
      if (preserved) {
        contours.push({ id: shortId("contour"), nodes: preserved, closed: true });
        return;
      }
      const { points, isCorner } = simplifyRingPreservingCorners(oriented, ringSimplifyTolerance(oriented, toleranceScale));
      const nodes: PathNode[] = ringToSmoothNodes(points, isCorner);
      contours.push({ id: shortId("contour"), nodes, closed: true });
    });
  });
  return contours;
}

/**
 * Applies a boolean op to 2+ eligible objects (in z-order, back-to-front).
 * Shapes are flattened to polygons, combined with the `polygon-clipping`
 * library (exact Martinez-Rueda-Feito clipping, not a raster approximation),
 * and the resulting rings are rebuilt into simplified, correctly-nested
 * closed contours with smooth handles refitted from local curvature. Returns
 * null when fewer than 2 eligible objects are given or the result is empty.
 */
export function applyBooleanOp(
  objectsInZOrder: VectorObject[],
  op: BooleanOp,
  toleranceScale = 1,
): VectorObject | null {
  const eligible = objectsInZOrder.filter(isBooleanEligible);
  if (eligible.length < 2) return null;

  const sources: SourceRing[] = [];
  const multiPolys = eligible
    .map((obj) => {
      const rings = contourSourceRings(obj.contours);
      sources.push(...rings);
      return sourceRingsToMultiPolygon(rings);
    })
    .filter((mp) => mp.length > 0);
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

  const contours = multiPolygonToContours(resultMulti, toleranceScale, sources);
  if (contours.length === 0) return null;

  return { id: shortId("obj"), kind: "shape", contours };
}

/**
 * Resolves a SINGLE shape's own contours through the exact same clipper
 * used for multi-object boolean ops, so a self-crossing outline (a
 * freehand stroke whose offset loops back over itself on a tight bend/
 * loop — see mergeOutlineBrushStrokes' doc comment) comes out as a clean,
 * simple silhouette instead of the raw self-intersecting polygon.
 *
 * BUG FIX: `mergeOutlineBrushStrokes` previously only ran this
 * normalization as a side effect of unioning 2+ separate Outline Brush
 * strokes together (`applyBooleanOp` needs 2+ eligible objects). A single
 * self-crossing stroke — e.g. one continuous pen gesture that loops
 * around and crosses its own earlier path, very common when drawing a
 * bowl+stem letterform (R, a, e, g, ...) in one motion — has only one
 * "outline" object in the glyph, so that path was skipped entirely and
 * the raw, self-intersecting outer/inner ring was rendered as-is: the
 * "kusut"/tangled crossing artifact where the ring's far edge shows
 * straight through the loop instead of merging cleanly. Routing every
 * Outline Brush stroke's contours through this normalizer — even a lone
 * one — fixes that without needing a second stroke to trigger it.
 *
 * `toleranceScale` (default 1, i.e. the same fidelity the interactive
 * editor/Test Lab has always used) lets a caller opt into a tighter refit —
 * see `TIGHT_CURVE_FIDELITY_SCALE` above.
 *
 * BUG FIX (export still didn't match Test Lab for single-object glyphs):
 * `applyBooleanOp`'s export call site was previously the ONLY caller that
 * passed a tightened `toleranceScale` — this function always refit at the
 * loose interactive default. Export's Remove Overlap only reaches
 * `applyBooleanOp` when a glyph has 2+ eligible objects; a glyph built from
 * one hand-drawn object (the common case — a single letterform with its
 * outer + counter as one shape's own contours) goes through THIS function
 * instead, so it was quietly exempt from the export fidelity fix and kept
 * reshaping smooth curves/joins on install even after that was fixed for
 * multi-object glyphs.
 *
 * BUG FIX ("hasil expand belum presisi dg line yg sblm expand" — a freshly
 * Expanded/Generated shape visibly drifting from the un-normalized preview
 * shown right before it, worst at a hard corner or a dense Rough-brush
 * texture): this function used to run EVERY input through the full
 * flatten -> exact-clip -> RDP-simplify -> generic-curve-refit round trip
 * unconditionally — even a single already-simple, non-self-crossing contour
 * (`sourceRingsToMultiPolygon` unions a lone ring with itself "to force the same
 * self-intersection resolution", per its own doc comment). That round trip
 * is lossy REGARDLESS of `toleranceScale`: `multiPolygonToContours` always
 * throws away the original Bezier handles and rebuilds new ones from a
 * simplified point cloud, which is a real curve-shape change even when the
 * simplification tolerance is tight. Confirmed directly against a real
 * hand-drawn glyph: a clean, non-self-intersecting stroke boundary came
 * back from this function with its point count collapsed and corner
 * position shifted by tens of font units — never bit-identical to the input
 * even though nothing about it actually needed resolving.
 *
 * Fix: cheaply test first whether the input actually contains any genuine
 * topology problem — a contour crossing itself, or two of this object's own
 * contours crossing each other (NOT simply one nesting cleanly inside
 * another, e.g. an ordinary hole inside its exterior, which is already
 * correct and must not trigger a re-clip). If nothing is found, return the
 * input completely unchanged — same object references, same Bezier handles,
 * zero drift. The exact-clipper round trip below still runs, unchanged,
 * whenever a real crossing IS found; this only skips it when it was never
 * needed in the first place, which is the common case for an ordinary
 * letterform corner or an evenly-spaced texture scatter.
 */
/** Proper segment intersection test: true only for a genuine crossing —
 * NOT a shared/touching endpoint or a collinear graze. Two contours that
 * merely touch at a single point (common, valid, and already correct)
 * must never be misclassified as needing the exact clipper, or the fast
 * path below would almost never fire. */
function segmentsProperlyCross(a0: Point, a1: Point, b0: Point, b1: Point): boolean {
  const d1x = a1.x - a0.x, d1y = a1.y - a0.y;
  const d2x = b1.x - b0.x, d2y = b1.y - b0.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return false; // parallel/collinear — never a "proper" crossing
  const t = ((b0.x - a0.x) * d2y - (b0.y - a0.y) * d2x) / denom;
  const u = ((b0.x - a0.x) * d1y - (b0.y - a0.y) * d1x) / denom;
  const eps = 1e-7;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

interface RingBounds { minX: number; minY: number; maxX: number; maxY: number }

function ringBounds(ring: Point[]): RingBounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function boundsOverlap(a: RingBounds, b: RingBounds): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** True if this closed polygon crosses itself anywhere. */
function ringSelfIntersects(ring: Point[]): boolean {
  return closedRingHasCrossing(ring, segmentsProperlyCross);
}

/** True if two different closed polygons' boundaries actually cross —
 * NOT simply "one sits inside the other" (a hole cleanly nested inside its
 * exterior, or one hole nested inside another, is a perfectly valid,
 * already-resolved relationship that must not trigger a re-clip). A cheap
 * bounding-box rejection keeps this fast for the common case of many small,
 * well-separated contours (e.g. Rough brush's texture holes). */
function ringsCross(a: Point[], b: Point[]): boolean {
  if (!boundsOverlap(ringBounds(a), ringBounds(b))) return false;
  return closedRingsHaveCrossing(a, b, segmentsProperlyCross);
}

/** Cheap pre-check for `normalizeSelfIntersectingContours`: does this set of
 * contours contain any ACTUAL topology problem that genuinely requires the
 * exact clipper to resolve? Flattens each contour once (same density the
 * clip path itself uses, so this never misses a crossing the clip path
 * would have found) and tests for self-crossings and cross-contour
 * crossings; ordinary clean nesting (holes inside an exterior) is not a
 * problem and correctly returns false. */
function contoursNeedIntersectionResolution(contours: Contour[]): boolean {
  if (contours.length === 0) return false;
  // Flatten at a resolution that scales DOWN with node count. A rough-brush
  // glyph carries many dense texture contours; flattening every one at the
  // full CLIP_SAMPLE_STEPS then running an O(n²) self-intersection test on
  // each was a big chunk of export time. A coarser sample still reliably
  // detects a genuine crossing (a real crossing spans far more than one
  // coarse segment) while cutting the point budget dramatically.
  const rings = contours.map((c) => {
    const steps = c.nodes.length > 40 ? 3 : c.nodes.length > 16 ? 6 : 12;
    return dedupePoints(flattenContour(c, steps));
  });
  for (const ring of rings) {
    if (ring.length < 3) return true; // degenerate — let the clip path's own handling deal with it
    if (ringSelfIntersects(ring)) return true;
  }
  // Only rings whose bounding boxes overlap can cross, so sweep along x
  // instead of testing every pair (a Spray glyph has thousands of rings).
  const bounds = rings.map(ringBounds);
  const order = rings.map((_, i) => i).sort((p, q) => bounds[p].minX - bounds[q].minX);
  const active: number[] = [];
  for (const i of order) {
    const bi = bounds[i];
    let w = 0;
    for (let k = 0; k < active.length; k++) {
      const j = active[k];
      if (bounds[j].maxX < bi.minX) continue; // finished before this ring starts: drop it
      active[w++] = j;
      const bj = bounds[j];
      if (bj.minY <= bi.maxY && bi.minY <= bj.maxY && ringsCross(rings[i], rings[j])) return true;
    }
    active.length = w;
    active.push(i);
  }
  return false;
}

export function normalizeSelfIntersectingContours(contours: Contour[], toleranceScale = 1): Contour[] {
  if (contours.length === 0) return [];
  if (!contoursNeedIntersectionResolution(contours)) return contours;
  const sources = contourSourceRings(contours);
  const multi = sourceRingsToMultiPolygon(sources);
  if (multi.length === 0) return contours;
  const cleaned = multiPolygonToContours(multi, toleranceScale, sources);
  return cleaned.length > 0 ? cleaned : contours;
}

/**
 * PRECISION EXPAND: exact union of a set of already-simple polygon rings
 * (each an array of {x,y} points) into clean, hole-aware closed contours.
 *
 * Unlike `normalizeSelfIntersectingContours`/`sourceRingsToMultiPolygon`, this
 * does NOT re-flatten Béziers (there are none — the caller passes finished
 * polygon rings) and does NOT run the lossy `PRECLIP_SIMPLIFY_EPSILON`
 * (0.75u) pre-clip simplification. The rings go into the exact
 * `polygon-clipping` union verbatim, so the union boundary is the exact
 * outline of the swept stroke to clipper precision.
 *
 * This is the robust way to expand a Monoline / Pen Line stroke so the
 * result is IDENTICAL to the constant-width native SVG stroke the editor
 * draws (round joins, round/butt/square caps, sharp inner corners): the
 * caller decomposes the stroke into a union of simple primitives — one
 * convex quad per centerline segment plus a round-join disc (or an explicit
 * cap wedge) at each vertex — none of which individually self-intersects,
 * and their exact union is precisely the region every point within the
 * stroke half-width of the centerline (i.e. the true stroke fill).
 */
export function unionPolygonsToContours(rings: Point[][], toleranceScale = 1): Contour[] {
  const polys: ClipPolygon[] = [];
  for (const r of rings) {
    if (r.length < 3) continue;
    const ring = toRing(dedupePoints(r));
    if (ring.length < 3) continue;
    // Each primitive is a single-ring polygon.
    polys.push([[...ring, ring[0]] as unknown as [number, number][]]);
  }
  if (polys.length === 0) return [];
  let resultMulti: ClipMultiPolygon;
  try {
    resultMulti = polys.length === 1 ? clipUnion(polys[0]) : clipUnion(polys[0], ...polys.slice(1));
  } catch {
    return [];
  }
  return multiPolygonToContours(resultMulti, toleranceScale);
}

/**
 * HOLE-AWARE union of several already-filled objects into one clean shape —
 * the correct "Remove Overlap" for a glyph whose objects individually have
 * counters/holes (e.g. a slashed "0": an oval RING plus a diagonal slash).
 *
 * The plain `unionPolygonsToContours`/`applyBooleanOp` path treats every
 * contour as a solid ring to OR together, so the moment two ring-shaped
 * (annulus) expansions are unioned, the inner counter of one gets filled by
 * the solid body of the other and the hole vanishes — the "angka 0 jadi
 * gepeng/hitam penuh" bug. The fix is to keep each object's body/hole
 * structure intact: convert every object into a proper exterior+holes
 * MultiPolygon (via the even-odd resolver `sourceRingsToMultiPolygon`, which
 * already pairs an object's own outer contour with its own counters), then
 * union those hole-aware MultiPolygons together with polygon-clipping, which
 * correctly keeps a counter open unless another object's real ink actually
 * covers it. This matches what the live editor shows.
 */
export function unionObjectsHoleAware(objects: VectorObject[], toleranceScale = 1): Contour[] {
  const sources: SourceRing[] = [];
  const multiPolys = objects
    .map((obj) => {
      const rings = contourSourceRings(obj.contours);
      sources.push(...rings);
      return sourceRingsToMultiPolygon(rings);
    })
    .filter((mp) => mp.length > 0);
  if (multiPolys.length === 0) return [];
  let resultMulti: ClipMultiPolygon;
  try {
    resultMulti = multiPolys.length === 1
      ? multiPolys[0]
      : clipUnion(multiPolys[0], ...multiPolys.slice(1));
  } catch {
    return [];
  }
  return multiPolygonToContours(resultMulti, toleranceScale, sources);
}

/**
 * Correct fill for a TEXTURED brush (Rough / Grunge / etc.) whose stroke
 * self-crosses — fixes the "yang muncul malah cuma lubangnya, kebalikannya"
 * bug.
 *
 * A textured brush emits ONE big solid body contour plus many tiny texture
 * contours (edge grit / interior specks) that should carve OUT of the body.
 * The body is a single ring that follows the whole pen gesture, so when the
 * gesture crosses itself (an "&", "8", a looped "e"), that body ring
 * self-intersects. Resolved with a plain nonzero/even-odd winding count, the
 * fill FLIPS inside the self-crossing region — the solid middle of the glyph
 * turns transparent and only the little texture pieces stay opaque, which is
 * exactly the inverted look reported.
 *
 * Fix: treat body and texture separately, the same way the Outline Brush
 * merge already does. Union all the SOLID body pieces together first — a
 * self-union resolves the ring's own self-crossing into one uniformly solid
 * region (no flipped interior) — then subtract the union of all the texture
 * pieces from it. The result is a solid glyph with its texture holes intact,
 * regardless of how many times the stroke crossed itself.
 *
 * Body vs texture is decided by area: the body pieces are the dominant
 * shape, texture is everything much smaller. A contour is treated as "body"
 * if its absolute area is at least `bodyFraction` of the largest contour's.
 */
export function resolveTexturedBrushFill(contours: Contour[], toleranceScale = 1, bodyFraction = 0.25): Contour[] {
  if (contours.length <= 1) return normalizeSelfIntersectingContours(contours, toleranceScale);

  const withArea = contours.map((c) => {
    const pts = flattenContour(c, 6);
    return { c, pts, absArea: Math.abs(polygonArea(pts)) };
  });
  const maxArea = withArea.reduce((m, x) => Math.max(m, x.absArea), 0);
  if (maxArea <= 0) return normalizeSelfIntersectingContours(contours, toleranceScale);

  const bodyContours: Contour[] = [];
  const bodyPts: Point[][] = [];
  const textureContours: Contour[] = [];
  const threshold = maxArea * bodyFraction;
  for (const { c, pts, absArea } of withArea) {
    if (absArea >= threshold) { bodyContours.push(c); bodyPts.push(pts); }
    else textureContours.push(c);
  }
  if (textureContours.length === 0) return normalizeSelfIntersectingContours(contours, toleranceScale);

  // FAST PATH: the expensive body-union + texture-subtract is ONLY needed
  // when a body ring actually self-crosses (a looped gesture like "&"/"8").
  // The vast majority of glyphs don't self-cross, so for them the plain
  // winding resolution already gives the right solid-with-holes result and
  // is far cheaper. Only pay the boolean cost when a body genuinely crosses
  // itself — this is the difference between ~16s and ~2s over a full rough
  // font export.
  const anyBodySelfCrosses = bodyPts.some((ring) => ringSelfIntersects(ring));
  if (!anyBodySelfCrosses) {
    return normalizeSelfIntersectingContours(contours, toleranceScale);
  }

  const toPolys = (cs: Contour[]): ClipPolygon[] => {
    const out: ClipPolygon[] = [];
    for (const c of cs) {
      const ring = toRing(dedupePoints(flattenContour(c, 6)));
      if (ring.length >= 3) out.push([[...ring, ring[0]] as unknown as [number, number][]]);
    }
    return out;
  };
  const bodyPolys = toPolys(bodyContours);
  const texturePolys = toPolys(textureContours);
  if (bodyPolys.length === 0) return normalizeSelfIntersectingContours(contours, toleranceScale);

  try {
    const bodySolid = bodyPolys.length === 1 ? clipUnion(bodyPolys[0]) : clipUnion(bodyPolys[0], ...bodyPolys.slice(1));
    if (texturePolys.length === 0) return multiPolygonToContours(bodySolid, toleranceScale);
    const textureSolid = texturePolys.length === 1 ? clipUnion(texturePolys[0]) : clipUnion(texturePolys[0], ...texturePolys.slice(1));
    const carved = clipDifference(bodySolid, textureSolid);
    return multiPolygonToContours(carved, toleranceScale);
  } catch {
    return normalizeSelfIntersectingContours(contours, toleranceScale);
  }
}

/**
 * Nonzero-style union for a fill made of MANY same-winding pieces — the
 * Spray Brush's core plus thousands of paint dots. The generic resolvers
 * above treat one object's contours even-odd (XOR), which would turn every
 * place two dots overlap, or a dot overlaps the core, into a hole. Here the
 * large pieces form the body (opposite-winding rings cut its holes), and
 * every dot is added on top as solid ink. Dots that touch nothing are
 * passed straight through untouched instead of going through the clipper,
 * which keeps this fast for a halo of thousands of dots.
 */
export function unionSameWindingContours(contours: Contour[], toleranceScale = 1): Contour[] {
  const sources = contourSourceRings(contours);
  if (sources.length === 0) return [];
  const areas = sources.map((r) => polygonArea(r.pts));
  let maxIdx = 0;
  areas.forEach((a, i) => {
    if (Math.abs(a) > Math.abs(areas[maxIdx])) maxIdx = i;
  });
  const sign = Math.sign(areas[maxIdx]) || 1;
  const bigLimit = Math.abs(areas[maxIdx]) * 0.01;
  const body: SourceRing[] = [];
  const holes: SourceRing[] = [];
  const dots: { ring: SourceRing; b: RingBounds }[] = [];
  sources.forEach((r, i) => {
    if (Math.sign(areas[i]) !== sign) holes.push(r);
    else if (Math.abs(areas[i]) >= bigLimit) body.push(r);
    else dots.push({ ring: r, b: ringBounds(r.pts) });
  });

  // Which dots overlap another dot or the body's boundary.
  const edgeGrid = new SourceEdgeGrid([...body, ...holes]);
  let cell = 1;
  for (const d of dots) cell = Math.max(cell, d.b.maxX - d.b.minX, d.b.maxY - d.b.minY);
  const dotGrid = new Map<number, number[]>();
  const dkey = (ix: number, iy: number) => (ix + 50000) * 100003 + (iy + 50000);
  dots.forEach((d, i) => {
    const k = dkey(Math.floor(d.b.minX / cell), Math.floor(d.b.minY / cell));
    const list = dotGrid.get(k);
    if (list) list.push(i);
    else dotGrid.set(k, [i]);
  });
  const bodyPolys = [...body, ...holes].map((r) => r.pts);
  const insideBody = (p: Point) => {
    let w = 0;
    for (const r of body) if (pointInPolygon(p, r.pts)) w++;
    for (const r of holes) if (pointInPolygon(p, r.pts)) w--;
    return w > 0;
  };
  const passThrough: Contour[] = [];
  const toClip: SourceRing[] = [];
  dots.forEach((d, i) => {
    const b = d.b;
    let touches = false;
    for (const id of edgeGrid.queryBox(b.minX, b.minY, b.maxX, b.maxY)) {
      const r = edgeGrid.rings[edgeGrid.edgeRing[id]];
      const k = edgeGrid.edgeK[id];
      const p = r.pts[k];
      const q = r.pts[(k + 1) % r.pts.length];
      if (Math.max(p.x, q.x) >= b.minX && Math.min(p.x, q.x) <= b.maxX && Math.max(p.y, q.y) >= b.minY && Math.min(p.y, q.y) <= b.maxY) {
        touches = true;
        break;
      }
    }
    if (!touches) {
      const cx = Math.floor(b.minX / cell);
      const cy = Math.floor(b.minY / cell);
      outer: for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iy = cy - 1; iy <= cy + 1; iy++) {
        for (const j of dotGrid.get(dkey(ix, iy)) ?? []) {
          if (j === i) continue;
          const o = dots[j].b;
          if (o.minX <= b.maxX && b.minX <= o.maxX && o.minY <= b.maxY && b.minY <= o.maxY) {
            touches = true;
            break outer;
          }
        }
      }
    }
    if (touches) toClip.push(d.ring);
    else if (bodyPolys.length === 0 || !insideBody(d.ring.pts[0])) passThrough.push(d.ring.contour);
  });

  try {
    const polys = (rs: SourceRing[]): ClipPolygon[] => rs.map((r) => [toRing(r.pts)]);
    let solid: ClipMultiPolygon = [];
    if (body.length > 0) {
      const bp = polys(body);
      solid = clipUnion(bp[0], ...bp.slice(1));
      if (holes.length > 0) {
        const hp = polys(holes);
        solid = clipDifference(solid, clipUnion(hp[0], ...hp.slice(1)));
      }
    }
    const dp = polys(toClip);
    const merged = dp.length === 0 ? solid : solid.length > 0 ? clipUnion(solid, ...dp) : clipUnion(dp[0], ...dp.slice(1));
    return [...multiPolygonToContours(merged, toleranceScale, [...body, ...holes, ...toClip]), ...passThrough];
  } catch {
    return normalizeSelfIntersectingContours(contours, toleranceScale);
  }
}
