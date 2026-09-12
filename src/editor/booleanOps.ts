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

function simplifyClosedRing(pts: Point[], epsilon: number): Point[] {
  if (pts.length < 6) return pts;
  // simplifyPolyline treats its first/last points as fixed anchors, so
  // temporarily reopen the ring at its own start/end to run it, then drop
  // the duplicated closing point it leaves behind.
  const reopened = [...pts, pts[0]];
  const simplified = simplifyPolyline(reopened, epsilon);
  if (simplified.length > 3) simplified.pop();
  return simplified.length >= 3 ? simplified : pts;
}

function objectPolys(obj: VectorObject): Point[][] {
  return obj.contours
    .map((c) => {
      // Flatten at a resolution that scales DOWN as the contour already has
      // more nodes. An expanded stroke contour can carry hundreds of Bézier
      // nodes; re-flattening every segment at the full CLIP_SAMPLE_STEPS
      // (48) then produced tens of thousands of points, which overwhelmed
      // the exact clipper and made it emit degenerate/empty rings — the
      // slashed-"0" counter vanished because its polygon came back broken.
      // Fewer steps on an already-dense contour keeps the point budget sane
      // while staying well within the pre-clip simplify tolerance below.
      const steps = c.nodes.length > 40 ? 4 : c.nodes.length > 16 ? 8 : CLIP_SAMPLE_STEPS;
      return simplifyClosedRing(dedupePoints(flattenContour(c, steps)), PRECLIP_SIMPLIFY_EPSILON);
    })
    .filter((poly) => poly.length >= 3);
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
function objectToMultiPolygon(obj: VectorObject): ClipMultiPolygon {
  const polys = objectPolys(obj);
  if (polys.length === 0) return [];
  const rings: ClipPolygon[] = polys.map((p) => [toRing(p)]);
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

function multiPolygonToContours(resultMulti: ClipMultiPolygon, toleranceScale = 1): Contour[] {
  if (!resultMulti || resultMulti.length === 0) return [];

  const polys: Point[][][] = [];
  for (const poly of resultMulti) {
    if (poly.length === 0) continue;
    const exterior = ringToPoints(poly[0]);
    // A degenerate exterior means this whole top-level shape is clipper
    // noise (see doc comment) — skip it entirely rather than keeping
    // orphaned holes with nothing real left to cut into.
    if (exterior.length < 3 || Math.abs(polygonArea(exterior)) < MIN_CONTOUR_AREA) continue;
    const holes: Point[][] = [];
    for (let i = 1; i < poly.length; i++) {
      const pts = ringToPoints(poly[i]);
      if (pts.length >= 3 && Math.abs(polygonArea(pts)) >= MIN_CONTOUR_AREA) holes.push(pts);
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

  const contours = multiPolygonToContours(resultMulti, toleranceScale);
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
 * (`objectToMultiPolygon` unions a lone ring with itself "to force the same
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
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a0 = ring[i], a1 = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the wrap-around
      if (segmentsProperlyCross(a0, a1, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** True if two different closed polygons' boundaries actually cross —
 * NOT simply "one sits inside the other" (a hole cleanly nested inside its
 * exterior, or one hole nested inside another, is a perfectly valid,
 * already-resolved relationship that must not trigger a re-clip). A cheap
 * bounding-box rejection keeps this fast for the common case of many small,
 * well-separated contours (e.g. Rough brush's texture holes). */
function ringsCross(a: Point[], b: Point[]): boolean {
  if (!boundsOverlap(ringBounds(a), ringBounds(b))) return false;
  const na = a.length, nb = b.length;
  for (let i = 0; i < na; i++) {
    const a0 = a[i], a1 = a[(i + 1) % na];
    for (let j = 0; j < nb; j++) {
      if (segmentsProperlyCross(a0, a1, b[j], b[(j + 1) % nb])) return true;
    }
  }
  return false;
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
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      if (ringsCross(rings[i], rings[j])) return true;
    }
  }
  return false;
}

export function normalizeSelfIntersectingContours(contours: Contour[], toleranceScale = 1): Contour[] {
  if (contours.length === 0) return [];
  if (!contoursNeedIntersectionResolution(contours)) return contours;
  const multi = objectToMultiPolygon({ id: "tmp-normalize", kind: "expanded", contours });
  if (multi.length === 0) return contours;
  const cleaned = multiPolygonToContours(multi, toleranceScale);
  return cleaned.length > 0 ? cleaned : contours;
}

/**
 * PRECISION EXPAND: exact union of a set of already-simple polygon rings
 * (each an array of {x,y} points) into clean, hole-aware closed contours.
 *
 * Unlike `normalizeSelfIntersectingContours`/`objectToMultiPolygon`, this
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
 * MultiPolygon (via the even-odd resolver `objectToMultiPolygon`, which
 * already pairs an object's own outer contour with its own counters), then
 * union those hole-aware MultiPolygons together with polygon-clipping, which
 * correctly keeps a counter open unless another object's real ink actually
 * covers it. This matches what the live editor shows.
 */
export function unionObjectsHoleAware(objects: VectorObject[], toleranceScale = 1): Contour[] {
  const multiPolys = objects
    .map(objectToMultiPolygon)
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
  return multiPolygonToContours(resultMulti, toleranceScale);
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
