import type { Contour, PathNode, Point, VectorObject, StrokeCap, StrokeSample } from "@/types/geometry";
import type { BrushSettings, BrushType } from "@/types/brush";
import { shortId } from "@/utils/id";
import { simplifyPolyline } from "@/utils/simplify";
import { smoothStroke, movingAverageSamples, estimateRoughness, windowRadiusFor } from "./strokeSmoothing";
import { BRUSH_PRESETS } from "./presets";
import { flattenContour } from "@/editor/objectOps";
import { normalizeSelfIntersectingContours } from "@/editor/booleanOps";

/**
 * Correct offset vector for sweeping a fixed-orientation elliptical nib
 * along a path: the Minkowski-sum boundary point for a given local path
 * normal direction is the point ON THE ELLIPSE whose OWN outward normal is
 * parallel to that direction (the ellipse's "support point"), not the point
 * that merely sits at that polar angle from the center.
 *
 * The old implementation (`ellipseRadius`, a plain polar radius formula)
 * placed the offset at distance r(theta) along the path's normal itself —
 * correct only for a circular nib (roundness 1, e.g. Monoline), where the
 * two definitions coincide. For an anisotropic nib (Marker, Calligraphic —
 * roundness < 1), that mismatch between the normal used for placement and
 * the ellipse's real normal at that point produces a boundary that isn't a
 * true offset curve: on curved gestures it can fold on itself, which is
 * exactly what reads as a faceted/"buggy" jagged edge instead of the smooth
 * sweep Monoline shows. Using the support point instead guarantees the
 * generated edge is the actual envelope of the swept ellipse.
 */
function ellipseSupportVector(dirAngle: number, axisAngle: number, a: number, b: number): Point {
  const phi = dirAngle - axisAngle;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const denom = Math.sqrt((a * cos) ** 2 + (b * sin) ** 2) || 1;
  const lx = (a * a * cos) / denom;
  const ly = (b * b * sin) / denom;
  const ca = Math.cos(axisAngle);
  const sa = Math.sin(axisAngle);
  return { x: lx * ca - ly * sa, y: lx * sa + ly * ca };
}

/**
 * Width multiplier at normalized arc-length `s` (0 = stroke start, 1 =
 * stroke end) from the taper ramps. Each end uses a smoothstep curve
 * (`t*t*(3-2t)`) so the taper is a single smooth C1 curve into the tip —
 * never a flat plateau or a corner/bump — regardless of how far it's
 * allowed to go.
 *
 * Each end is floored independently (`opts.sharpStart`/`sharpEnd`): a
 * "sharp" end floors at 0, so its ramp genuinely reaches a needle point;
 * a normal end floors at 0.08 (the long-standing default), which stops
 * just short of a full point for a softer, slightly-blunt taper. Flooring
 * per-end like this is equivalent to the old single shared-floor-at-the-end
 * behavior when both floors match (max(c, min(a,b)) === min(max(c,a),
 * max(c,b)) for a constant c), and correctly gives each end its own
 * behavior when they don't.
 */
export function taperFactor(
  s: number,
  taperStart: number,
  taperEnd: number,
  opts?: { sharpStart?: boolean; sharpEnd?: boolean }
): number {
  const startFloor = opts?.sharpStart ? 0 : 0.08;
  const endFloor = opts?.sharpEnd ? 0 : 0.08;
  let fStart = 1;
  if (taperStart > 0 && s < taperStart) {
    const t = s / taperStart;
    fStart = Math.max(startFloor, t * t * (3 - 2 * t));
  }
  let fEnd = 1;
  if (taperEnd > 0 && s > 1 - taperEnd) {
    const t = (1 - s) / taperEnd;
    fEnd = Math.max(endFloor, t * t * (3 - 2 * t));
  }
  return Math.min(fStart, fEnd);
}

/** Deterministic pseudo-noise in [-1,1] — same seed always gives the same value, so a stroke's rough edge doesn't flicker on re-render. */
function pseudoNoise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * Smooth 1D value noise: pseudoNoise() is per-integer-sample white noise
 * (great for Grunge's fine spiky edge), but a dry-brush tear reads as a few
 * BROAD scallops, not fine grain. Interpolating between lattice points with
 * a smoothstep gives exactly that — a wide, organic undulation — from the
 * same deterministic pseudoNoise() seed so it's equally re-render-stable.
 */
function coherentNoise1D(t: number, seed: number): number {
  const i0 = Math.floor(t);
  const f = t - i0;
  const n0 = pseudoNoise(i0 + seed);
  const n1 = pseudoNoise(i0 + 1 + seed);
  const u = f * f * (3 - 2 * f);
  return n0 + (n1 - n0) * u;
}

/**
 * Oil Brush's torn-edge offset (added on top of the normal elliptical nib
 * radius, along the same normal direction). Two things make this read as a
 * dry-brush drag rather than Grunge's distressed noise:
 *  - `coherentNoise1D` lobes are wide (a handful per stroke, from
 *    `lobesPerLength`), not per-sample, so the edge tears in broad scallops.
 *  - amplitude ramps up sharply near both ends (`endFactor`), so the body
 *    stays fairly clean mid-stroke and the paint visibly "runs out"/frays
 *    where the brush lifts off — echoed by the extra-strong end tapers on
 *    the Oil Brush preset itself.
 * Independent seeds per edge (`seed`/`seed+50`) keep the two sides from
 * tearing in lockstep, which would look like a uniform width pulse instead
 * of an organic torn edge.
 */
function oilEdgeOffset(s: number, edgeSeed: number, amplitude: number): number {
  const lobesPerLength = 5.5;
  const n = coherentNoise1D(s * lobesPerLength, edgeSeed);
  const endFactor = 1 + 1.6 * Math.max(0, 0.22 - Math.min(s, 1 - s)) / 0.22;
  return n * amplitude * endFactor;
}

/**
 * Strong Brush's torn "comb" tip: several sharp saw-teeth of DIFFERENT
 * heights running all the way across the flat end of the stroke, instead
 * of one smooth blade point — a real dry brush fraying into separate
 * bristles as it lifts off, not a single clean vertex.
 *
 * Three earlier versions all got this wrong:
 *  - v1 added teeth PERPENDICULAR to the stroke (outward along the same
 *    normal used for width), sampled by distance ALONG the stroke near
 *    each end — teeth stuck out sideways off the edge, not past the tip.
 *  - v2 fixed the outward direction (radiating from the tip, roughly along
 *    the tangent) but spread full-height teeth evenly across the ENTIRE
 *    180° sweep from one side of the nib to the other. On a curved stroke
 *    that put full-length teeth pointing up to ~80° off the direction of
 *    travel — a splayed "hand"/claw shape instead of bristles that all
 *    lean the way the brush was moving.
 *  - v3 fixed the splaying by concentrating teeth in a narrow cone around
 *    the tangent direction — but that cone also killed height everywhere
 *    except right at the very center, so in practice only the middle of
 *    the flat end showed any tooth at all and the rest stayed a smooth
 *    round bulge (the curling point in the bug report), not a jagged edge.
 *
 * This version does neither: it builds teeth along the FLAT CHORD that
 * spans the nib's full width (from one edge of the stroke to the other —
 * no curved bulge at all) and every tooth protrudes along the exact same
 * fixed direction: straight out along the stroke's own tangent (outward
 * at the end, backward at the start). That single shared direction is
 * what makes every spike "ikutin arah goresan" (follow the direction of
 * the stroke) rather than radiating out at different angles, and using
 * the flat chord as the base (not the curved rim) is what lets the
 * zigzag reach corner-to-corner instead of fading out a few teeth in.
 */
function combToothCap(
  cap: { center: Point; tangentAngle: number; semiA: number; semiB: number },
  edgeStartAngle: number,
  outwardAngle: number,
  nibAngleRad: number,
  edgeSeed: number
): Point[] {
  const segments = 32;
  const toothCount = 6;
  const toothAmp = Math.max(cap.semiA, cap.semiB) * 1.35;

  // The two ends of the flat chord — the same edge points the smooth
  // ("round") cap's arc would otherwise bulge out from. Interpolating
  // straight between them (instead of sweeping the curved rim) is what
  // keeps the zigzag a real flat-topped saw-tooth edge rather than teeth
  // riding on top of an already-rounded bulge.
  const vLeft = ellipseSupportVector(edgeStartAngle, nibAngleRad, cap.semiA, cap.semiB);
  const vRight = ellipseSupportVector(edgeStartAngle - Math.PI, nibAngleRad, cap.semiA, cap.semiB);
  const leftPt = { x: cap.center.x + vLeft.x, y: cap.center.y + vLeft.y };
  const rightPt = { x: cap.center.x + vRight.x, y: cap.center.y + vRight.y };

  const fx = Math.cos(outwardAngle);
  const fy = Math.sin(outwardAngle);

  // Each tooth's OUTWARD peak height AND its two flanking INWARD valley
  // depths are all independently randomized — a real torn edge doesn't
  // notch back to the same flush baseline between every spike, some cuts
  // bite deeper than others. The two outermost valleys (index 0 and
  // toothCount) are pinned to 0 so the zigzag still joins flush with the
  // straight body edge on both sides, instead of leaving a gap/overhang
  // at the corners.
  const peaks: number[] = [];
  for (let i = 0; i < toothCount; i++) {
    // ~0.32x .. 1.5x toothAmp outward per peak.
    peaks.push(0.32 + ((pseudoNoise(edgeSeed + i * 7.13) + 1) / 2) * 1.18);
  }
  const valleys: number[] = [0];
  for (let i = 1; i < toothCount; i++) {
    // ~-0.32x .. +0.06x toothAmp — mostly a shallow inward notch, varying
    // per valley, occasionally almost flush.
    valleys.push(-0.32 + ((pseudoNoise(edgeSeed + i * 3.71 + 50) + 1) / 2) * 0.38);
  }
  valleys.push(0);

  const pts: Point[] = [];
  for (let k = 1; k < segments; k++) {
    const u = k / segments; // 0 at left edge, 1 at right edge — full chord width
    const bx = leftPt.x + (rightPt.x - leftPt.x) * u;
    const by = leftPt.y + (rightPt.y - leftPt.y) * u;

    const local = u * toothCount;
    const toothIndex = Math.min(toothCount - 1, Math.floor(local));
    const t = local - toothIndex; // 0..1 across this one tooth
    const vStart = valleys[toothIndex];
    const vEnd = valleys[toothIndex + 1];
    const peak = peaks[toothIndex];
    // Peak sits at the tooth's midpoint; each side ramps independently
    // from its own (differently sized) flanking valley, so a tooth can
    // lean — steep climb out of a deep notch, shallow descent into a
    // near-flush one, or vice versa.
    const shape = t <= 0.5 ? vStart + (peak - vStart) * (t / 0.5) : peak + (vEnd - peak) * ((t - 0.5) / 0.5);
    const protrusion = shape * toothAmp;

    pts.push({ x: bx + fx * protrusion, y: by + fy * protrusion });
  }
  return pts;
}

/**
 * Intersection of segments (a0,a1) and (b0,b1), restricted to the segments
 * themselves (both parametric t/u in [0,1]). Returns null for parallel/
 * non-crossing segments.
 */
function segmentIntersection(a0: Point, a1: Point, b0: Point, b1: Point): Point | null {
  const d1x = a1.x - a0.x, d1y = a1.y - a0.y;
  const d2x = b1.x - b0.x, d2y = b1.y - b0.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((b0.x - a0.x) * d2y - (b0.y - a0.y) * d2x) / denom;
  const u = ((b0.x - a0.x) * d1y - (b0.y - a0.y) * d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a0.x + t * d1x, y: a0.y + t * d1y };
}

/**
 * Cleans up local self-intersections in one side of an offset chain (the
 * `left` or `right` array in centerlineToOutline). A naive per-sample
 * offset — even with the correct per-point normal — folds onto itself on
 * the inner (concave) side of a sharp bend: the offset amount there can
 * exceed the corner's own clearance, so the two flanking segments' offset
 * lines cross well past the corner instead of meeting cleanly at it. That
 * fold is exactly what left a visible open notch/gap in Outline Brush's
 * hole at a bent stroke instead of a single clean closed ring.
 *
 * Rather than a full corner-join model (miter/bevel geometry per corner),
 * this takes the simpler, more general route: find the earliest pair of
 * (non-adjacent) segments in the chain that cross, collapse everything
 * between them down to that single intersection point, and repeat. That
 * turns any local fold back into a simple, non-self-intersecting polyline,
 * for a stroke with any number/shape of corners, without needing to
 * classify convex vs. concave first.
 *
 * The intersection search only looks a bounded window ahead (`window`)
 * rather than the whole remaining chain — real folds are always local, to
 * the corner that caused them, so this keeps the cost close to linear on
 * long, mostly-straight strokes instead of scanning every distant pair.
 */
function removeSelfIntersectionLoops(chain: Point[]): Point[] {
  if (chain.length < 4) return chain;
  const pts = chain.slice();
  const window = 48;
  const maxPasses = 200;
  for (let pass = 0; pass < maxPasses; pass++) {
    let found = false;
    for (let i = 0; i < pts.length - 1; i++) {
      const jMax = Math.min(pts.length - 1, i + window);
      for (let j = i + 2; j < jMax; j++) {
        const hit = segmentIntersection(pts[i], pts[i + 1], pts[j], pts[j + 1]);
        if (hit) {
          pts.splice(i + 1, j - i, hit);
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) break;
  }
  return pts;
}

function catmullRomPoint(p0: StrokeSample, p1: StrokeSample, p2: StrokeSample, p3: StrokeSample, t: number): StrokeSample {
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    0.5 *
    (2 * p1.x +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  const y =
    0.5 *
    (2 * p1.y +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
  // Pressure is interpolated linearly on purpose: a spline can overshoot
  // past the sampled min/max, which would show up as a visible width blip.
  const pressure = p1.pressure + (p2.pressure - p1.pressure) * t;
  return { x, y, pressure };
}

/**
 * Resample a (typically sparse, RDP-simplified) centerline into a dense,
 * evenly-spaced curve using Catmull-Rom interpolation.
 *
 * This is what actually removes the "faceted"/rough look the elliptical
 * nib model produces on curved gestures: `samplesToCenterline` above
 * intentionally simplifies down to a handful of points (good for an
 * editable node count), but sweeping a wide or angled nib directly along
 * only a few straight segments makes its width visibly jump at every kink.
 * Feeding the sweep this dense re-interpolated curve instead — rather than
 * the sparse points — is what makes every brush read as smooth/buttery
 * (Procreate-like) regardless of how few nodes the stroke keeps for editing.
 */
/**
 * Turns sharper than this are treated as intentional hard corners rather
 * than a curve Catmull-Rom should smooth through — see the corner-clamping
 * note in catmullRomResample() below.
 *
 * BUG FIX: was 55°, which caused many natural freehand bends (especially
 * in curved letterforms like O, B, C) to be classified as hard corners and
 * rendered as straight segments instead of smooth arcs — the root cause of
 * the "bersusdut" (angular/faceted) look reported on every brush type.
 * Raised to 80° so only genuinely sharp cusps stay hard; anything that reads
 * as a rounded bend gets spline-interpolated smoothly through.
 */
const HARD_CORNER_ANGLE = (80 * Math.PI) / 180;

export function catmullRomResample(points: StrokeSample[], spacing: number): StrokeSample[] {
  if (points.length < 2 || spacing <= 0) return points;
  // A straight gesture is commonly reduced to exactly two centerline
  // samples. Returning those two points made Rough's coherent edge texture
  // disappear until the user introduced a bend, because the roughness was
  // only sampled at the endpoints. Densify the two-point case linearly so
  // every brush profile gets the same continuous rendering path.
  if (points.length === 2) {
    const [start, end] = points;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(length / spacing));
    const out: StrokeSample[] = [start];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      out.push({
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
        pressure: start.pressure + (end.pressure - start.pressure) * t,
      });
    }
    return out;
  }

  // A plain Catmull-Rom pass blends each point's tangent from BOTH of its
  // neighbours. At a genuinely sharp corner that blend pulls the curve past
  // the vertex and back again — a small overshoot loop sitting right on the
  // corner. Sweeping the nib along that loop is what reads as a self-
  // crossing fold / stray spike right at the corner (the reported bug).
  // Fix: detect sharp corners and, only for the segments touching one, swap
  // the "far" control point for the corner point itself. That clamps the
  // local tangent to come from one side only, so the spline treats the
  // corner as a genuine break (matching how "corner" nodes already behave
  // in the editor) instead of interpolating across it.
  const isHardCorner = new Array(points.length).fill(false);
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const u0x = b.x - a.x, u0y = b.y - a.y;
    const u1x = c.x - b.x, u1y = c.y - b.y;
    const l0 = Math.hypot(u0x, u0y) || 1;
    const l1 = Math.hypot(u1x, u1y) || 1;
    const dot = Math.max(-1, Math.min(1, (u0x * u1x + u0y * u1y) / (l0 * l1)));
    isHardCorner[i] = Math.acos(dot) > HARD_CORNER_ANGLE;
  }

  const out: StrokeSample[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const p0 = isHardCorner[i] ? p1 : points[Math.max(0, i - 1)];
    const p3 = isHardCorner[i + 1] ? p2 : points[Math.min(points.length - 1, i + 2)];
    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (segLen === 0) continue;
    const steps = Math.max(1, Math.round(segLen / spacing));
    for (let s = 1; s <= steps; s++) {
      out.push(catmullRomPoint(p0, p1, p2, p3, s / steps));
    }
  }
  return out;
}

/** Clean, simplified centerline (font units) from raw samples.
 *
 * Runs through the same shared engine the Pencil tool uses for its
 * Stabilizer/Smoothing sliders (see `brushes/strokeSmoothing.ts`) so both
 * tools' smoothing behaves identically — roughness-boosted double moving
 * average, then RDP simplification with a tolerance that holds steady
 * across zoom levels via `hitScale` (defaults to 1 for the rare caller
 * that isn't in screen-space, e.g. a stored preset re-processed offline). */
export function samplesToCenterline(rawSamples: StrokeSample[], settings: BrushSettings, hitScale = 1): StrokeSample[] {
  if (rawSamples.length < 2) return rawSamples;
  if (settings.type === "grunge") {
    // Grunge needs dense edge events all along the stroke; a second
    // smoothing pass or RDP simplification would erase the jagged profile
    // that IS the brush, so it only ever gets the shared engine's first,
    // roughness-boosted moving-average pass — never the full smoothStroke.
    if (settings.smoothing <= 0) return rawSamples;
    const roughness = estimateRoughness(rawSamples);
    const effective = Math.max(0, Math.min(1, settings.smoothing + roughness * 0.5));
    // Same length-aware cap as smoothStroke() — see windowRadiusFor()'s doc
    // comment. Without it, a short/jittery Grunge stroke collapsed to a
    // single point the same way every other brush did.
    const windowRadius = windowRadiusFor(effective, rawSamples.length);
    return movingAverageSamples(rawSamples, windowRadius);
  }
  return smoothStroke(rawSamples, settings.smoothing, hitScale);
}

/**
 * Open editable brush centerline.
 *
 * Freehand strokes should stay fluid when the user switches to the Node tool.
 * We therefore infer cubic handles from the sampled polyline and mark curved
 * points as `smooth` (collinear handles with independent lengths), not
 * `symmetric`. Very sharp turns stay corners so an intentional cusp is not
 * rounded away. Pixel Brush opts out and keeps exact grid corners.
 */
export function centerlineToContour(
  centerline: { x: number; y: number }[],
  autoSmooth = true,
  closeSmoothly = false
): Contour | null {
  if (centerline.length < 2) return null;

  const points = centerline.map((p) => ({ x: p.x, y: p.y }));
  const nodes: PathNode[] = points.map((point) => ({
    id: shortId("node"),
    point,
    handleIn: null,
    handleOut: null,
    type: "corner",
  }));

  if (!autoSmooth || points.length < 3) {
    return { id: shortId("contour"), closed: false, nodes };
  }

  const n = points.length;
  // `closeSmoothly` (Pencil's auto-close) treats the point array as a ring:
  // node 0's "previous" neighbor wraps to the last point and the last
  // node's "next" neighbor wraps to point 0. That lets the closing seam get
  // exactly the same corner/smooth classification and tangent-fit treatment
  // as every interior node, instead of being forced into a hard straight
  // line the way `contour.closed = true` alone would render it (no handles
  // on either side of the seam). A genuinely sharp turn at the seam still
  // stays a corner — this only stops smooth curves from being faceted shut.
  const wrap = (i: number) => (i + n) % n;

  const unit = (dx: number, dy: number) => {
    const d = Math.hypot(dx, dy) || 1;
    return { x: dx / d, y: dy / d };
  };
  const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

  // Freehand gestures are biased toward smoothness: even a fairly strong
  // bend should remain a smooth node. Only very sharp cusp-like changes stay
  // corners so the brush never turns a deliberate point into a loop/overshoot.
  const maxSmoothTurn = (120 * Math.PI) / 180;
  const smoothFlags = new Array(n).fill(false);

  const loEnd = closeSmoothly ? 0 : 1;
  const hiEnd = closeSmoothly ? n - 1 : n - 2;
  for (let i = loEnd; i <= hiEnd; i++) {
    const a = points[closeSmoothly ? wrap(i - 1) : i - 1];
    const b = points[i];
    const c = points[closeSmoothly ? wrap(i + 1) : i + 1];
    const u0 = unit(b.x - a.x, b.y - a.y);
    const u1 = unit(c.x - b.x, c.y - b.y);
    const dot = Math.max(-1, Math.min(1, u0.x * u1.x + u0.y * u1.y));
    const turn = Math.acos(dot);
    smoothFlags[i] = turn <= maxSmoothTurn;
  }

  if (!closeSmoothly) {
    // Give endpoints a one-sided smooth handle when the adjacent section is
    // smooth. This avoids a visibly straight first/last segment on a curved
    // freehand stroke without pretending the endpoint has two equal handles.
    smoothFlags[0] = smoothFlags[1] ?? false;
    smoothFlags[n - 1] = smoothFlags[n - 2] ?? false;
  }

  for (let i = 0; i < n; i++) {
    if (!smoothFlags[i]) continue;
    const prev = points[closeSmoothly ? wrap(i - 1) : Math.max(0, i - 1)];
    const cur = points[i];
    const next = points[closeSmoothly ? wrap(i + 1) : Math.min(n - 1, i + 1)];

    let tangent: Point;
    if (!closeSmoothly && i === 0) tangent = unit(next.x - cur.x, next.y - cur.y);
    else if (!closeSmoothly && i === n - 1) tangent = unit(cur.x - prev.x, cur.y - prev.y);
    else tangent = unit(next.x - prev.x, next.y - prev.y);

    // Independent incoming/outgoing lengths are deliberate: this is a
    // `smooth` node, not a `symmetric` node. The 0.30 factor keeps the fitted
    // curve close to the user's gesture and avoids overshoot on dense samples.
    const hasIn = closeSmoothly || i > 0;
    const hasOut = closeSmoothly || i < n - 1;
    const inLen = hasIn ? Math.max(0.5, dist(prev, cur) * 0.30) : 0;
    const outLen = hasOut ? Math.max(0.5, dist(cur, next) * 0.30) : 0;

    nodes[i].type = "smooth";
    if (inLen > 0) {
      nodes[i].handleIn = { x: cur.x - tangent.x * inLen, y: cur.y - tangent.y * inLen };
    }
    if (outLen > 0) {
      nodes[i].handleOut = { x: cur.x + tangent.x * outLen, y: cur.y + tangent.y * outLen };
    }
  }

  return { id: shortId("contour"), closed: closeSmoothly, nodes };
}

/**
 * Builds a closed variable-width outline polygon from a centerline with
 * per-point pressure, using the elliptical nib model.
 *
 * `precomputed`, when given, skips re-resampling the centerline and reuses
 * the exact same dense point/arc-length data as another call — this is
 * what lets Outline Brush build its outer and inner (hole) boundaries from
 * IDENTICAL physical endpoints (see outlineBrushOutlineContours). Resampling
 * independently per call (previously: once at the outer size, once again at
 * the smaller inner size) used a slightly different point spacing each
 * time, so the two boundaries' flat end caps didn't land in quite the same
 * place — the visible open notch at the ring's tip instead of a clean seam.
 */
export function centerlineToOutline(
  centerline: StrokeSample[],
  settings: BrushSettings,
  precomputed?: { pts: StrokeSample[]; cumulative: number[]; totalLength: number },
  capForwardOverride?: number,
  edgeSimplifyEpsilonOverride?: number
): Contour | null {
  if (centerline.length < 2 && !precomputed) return null;

  // Sweep the nib along a dense, spline-resampled curve instead of the
  // sparse (RDP-simplified) centerline points directly — see
  // catmullRomResample()'s doc comment. Grunge is the one exception: its
  // whole character comes from dense raw edge noise, which this would
  // smooth away, so it keeps the untouched point stream.
  const pts = precomputed
    ? precomputed.pts
    : settings.type === "grunge"
      ? centerline
      : catmullRomResample(centerline, Math.max(0.6, settings.size * 0.06));
  if (pts.length < 2) return null;

  const cumulative = precomputed ? precomputed.cumulative : [0];
  if (!precomputed) {
    for (let i = 1; i < pts.length; i++) {
      cumulative.push(cumulative[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
  }
  const totalLength = precomputed ? precomputed.totalLength : cumulative[cumulative.length - 1] || 1;

  const nibAngleRad = (settings.angle * Math.PI) / 180;
  const semiMajor = Math.max(0.5, settings.size / 2);
  const semiMinor = Math.max(0.3, (settings.size / 2) * settings.roundness);

  // Cap treatment for the two stroke ends. "round" replaces the flat chord
  // between the last left/right offset points with a smooth outward bulge
  // that follows the nib's own ellipse — a closed, joined tip instead of a
  // straight cut (or, on a fold-prone tangent, a visible open notch).
  // "comb" (Strong Brush only) instead replaces that chord with a torn,
  // bristle-like fan (see combToothCap) — its own deliberate end treatment,
  // built the same way as "round" structurally but jagged instead of smooth.
  // Brushes with other deliberate end treatments (flat Rough/Outline, frayed
  // Oil Brush, spiky Grunge) opt out of both and keep their current look.
  const ROUND_CAP_TYPES: BrushType[] = ["round", "marker", "calligraphic", "pencil", "pressureTaper"];
  const COMB_CAP_TYPES: BrushType[] = ["strong"];
  // Outline Brush's cap is user-controlled (see BrushSettings.outlineCapStyle).
  // All three styles ("round", "square", "open") now go through this SAME
  // outer+inner ring construction (see outlineBrushOutlineContours) instead
  // of "open" diverting to its own separate two-strip builder — see that
  // function's doc comment for why the strip approach couldn't merge
  // cleanly at a crossing/touching point the way the ring approach does.
  //
  // BUG FIX: "square" used to fall into the generic "none" bucket, which
  // just leaves a flat chord AT the exact centerline endpoint with no cap
  // geometry of its own. That's fine for a single solid stroke, but Outline
  // Brush's ring shape calls this function twice from the SAME endpoint —
  // once for the outer boundary, once for the smaller inner hole boundary
  // (see outlineBrushOutlineContours) — so both flat chords landed exactly
  // on top of each other. The hole then cut almost all the way through to
  // the tip, leaving two disconnected prongs: visually indistinguishable
  // from the "open" style the user was trying to get away from. "square"
  // now gets its own capMode so it can build a real flat-topped plate (see
  // capSquare below) that extends past the endpoint by that boundary's OWN
  // half-width — the outer plate reaches further than the inner plate by
  // exactly the border thickness, the same way "round"'s concentric arcs
  // already keep a constant ring width all the way around the tip.
  //
  // "open" deliberately reuses that same disconnected-prongs look the
  // "square" fix above was steering AWAY from: it's exactly what a
  // genuinely open, uncapped tip should look like (outer and inner both cut
  // off with a flat, un-extended chord at the same point, so the border
  // reads as stopping abruptly with the hollow interior reaching all the
  // way to the tip, rather than a solid plate plugging it shut) — so it
  // maps to the plain "none" cap treatment (no cap geometry inserted at
  // all), same as any non-outline brush with no dedicated end cap.
  const capMode: "round" | "comb" | "square" | "none" =
    settings.type === "outline"
      ? settings.outlineCapStyle === "round"
        ? "round"
        : settings.outlineCapStyle === "open"
          ? "none"
          : "square"
      : ROUND_CAP_TYPES.includes(settings.type)
        ? "round"
        : COMB_CAP_TYPES.includes(settings.type)
          ? "comb"
          : "none";
  let startCap: { center: Point; tangentAngle: number; semiA: number; semiB: number } | null = null;
  let endCap: { center: Point; tangentAngle: number; semiA: number; semiB: number } | null = null;

  // BUG FIX (width pinches thin at bends): every point used to get exactly
  // ONE offset, placed along the AVERAGED tangent of its two neighboring
  // segments (see `normal`/`normalAngle` below). That average is a fine
  // approximation on a gently curving run, but at a genuinely sharp bend
  // (a hand-drawn corner, or two straight segments meeting at an angle) it
  // quietly cuts the corner: the single averaged-normal point sits roughly
  // on the CHORD between where the incoming segment's true offset would
  // land and where the outgoing segment's true offset would land, instead
  // of following the nib all the way around the outside of the turn. That
  // chord-cut is exactly what read as "tebal tipis" (the stroke visibly
  // thinning right at a turn) — worse the sharper the bend, and most
  // visible on wide/round nibs since the chord shortfall scales with size.
  // (The self-intersection cleanup already handles the OTHER side of a
  // sharp bend — the concave/inside fold — by trimming it back to a single
  // point; there was never an equivalent fix for the convex/outside gap.)
  //
  // Fix: detect sharp bends locally (comparing the raw incoming/outgoing
  // segment directions, not the blended average), and on the CONVEX side
  // of the bend only, replace that single chord-cutting point with a real
  // round-join arc swept through the nib's own ellipse boundary — the same
  // `ellipseSupportVector` sweep every end cap already uses (see `capArc`
  // below), just centered on an interior corner instead of a stroke tip.
  // The concave side is left untouched; the existing self-intersection
  // cleanup still collapses its fold correctly.
  const JOIN_ANGLE_THRESHOLD = (28 * Math.PI) / 180;
  const normalizeAngleDelta = (a: number): number => {
    let d = a % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };
  const cornerJoinArc = (center: Point, a0: number, a1: number, semiA: number, semiB: number): Point[] => {
    const delta = normalizeAngleDelta(a1 - a0);
    const segments = Math.max(2, Math.min(8, Math.ceil(Math.abs(delta) / (Math.PI / 8))));
    const out: Point[] = [];
    for (let k = 0; k <= segments; k++) {
      const ang = a0 + (delta * k) / segments;
      const v = ellipseSupportVector(ang, nibAngleRad, semiA, semiB);
      out.push({ x: center.x + v.x, y: center.y + v.y });
    }
    return out;
  };

  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const tangent = { x: next.x - prev.x, y: next.y - prev.y };
    const tLen = Math.hypot(tangent.x, tangent.y) || 1;
    const normal = { x: -tangent.y / tLen, y: tangent.x / tLen };
    const normalAngle = Math.atan2(normal.y, normal.x);

    // Local sharp-bend detection for the round-join fix above: uses the
    // RAW incoming/outgoing segment directions (not the blended `normal`
    // above), so it catches exactly the corners that averaging papers over.
    // Endpoints (i===0 / i===last) are excluded — those are the dedicated
    // start/end caps, handled separately below.
    let isJoinCorner = false;
    let joinConvexSide: "left" | "right" = "left";
    let joinInAngle = normalAngle;
    let joinOutAngle = normalAngle;
    if (i > 0 && i < pts.length - 1) {
      const segInX = pts[i].x - prev.x, segInY = pts[i].y - prev.y;
      const segOutX = next.x - pts[i].x, segOutY = next.y - pts[i].y;
      const segInLen = Math.hypot(segInX, segInY) || 1;
      const segOutLen = Math.hypot(segOutX, segOutY) || 1;
      const cosTurn = Math.max(-1, Math.min(1, (segInX * segOutX + segInY * segOutY) / (segInLen * segOutLen)));
      const turnAngle = Math.acos(cosTurn);
      if (turnAngle > JOIN_ANGLE_THRESHOLD) {
        const cross = segInX * segOutY - segInY * segOutX;
        // Path turning left (cross>0) folds the LEFT side inward (concave)
        // and opens a gap on the RIGHT side (convex), and vice versa — see
        // the doc comment above.
        joinConvexSide = cross > 0 ? "right" : "left";
        const inTx = segInX / segInLen, inTy = segInY / segInLen;
        const outTx = segOutX / segOutLen, outTy = segOutY / segOutLen;
        joinInAngle = Math.atan2(inTx, -inTy);
        joinOutAngle = Math.atan2(outTx, -outTy);
        isJoinCorner = true;
      }
    }

    // `size` is always the width at full press (or the constant width when
    // pressure is off/unavailable) — pressureSensitivity only ever scales
    // DOWN from it. Real stylus pressure is captured per-sample by
    // useBrushTool's pressureFor(); mouse/trackpad/touch samples are always
    // recorded at pressure 1, so this expression is a no-op for them
    // regardless of `pressureEnabled` — see stylusPressure() there.
    const pressure = settings.pressureEnabled ? pts[i].pressure : 1;
    const sensitivity = settings.pressureSensitivity ?? 0;
    const widthFromPressure = settings.size * (1 - sensitivity * (1 - pressure));
    const s = cumulative[i] / totalLength;
    const taper = taperFactor(s, settings.taperStart, settings.taperEnd, { sharpStart: settings.sharpStart, sharpEnd: settings.sharpEnd });
    const halfWidthBase = (widthFromPressure / 2) * taper;
    const scale = halfWidthBase / Math.max(0.001, semiMajor);
    let { x: vx, y: vy } = ellipseSupportVector(normalAngle, nibAngleRad, semiMajor * scale, semiMinor * scale);

    if (capMode !== "none" && i === 0) {
      const tangentAngle = Math.atan2(tangent.y, tangent.x);
      startCap = { center: pts[i], tangentAngle, semiA: semiMajor * scale, semiB: semiMinor * scale };
    }
    if (capMode !== "none" && i === pts.length - 1) {
      const tangentAngle = Math.atan2(tangent.y, tangent.x);
      endCap = { center: pts[i], tangentAngle, semiA: semiMajor * scale, semiB: semiMinor * scale };
    }

    // Pencil's fine grain and Grunge's spiky noise both come from this
    // generic per-point jitter. Oil Brush and Rough both handle their own
    // edge noise separately (Oil Brush's coherent broad-scallop tear below,
    // Rough's coherent absolute-arc-length wave further below) — applying
    // this raw independent-per-sample noise on top of either would still
    // read as a sharp sawtooth REGARDLESS of how gentle their own dedicated
    // noise is, since this block runs first and already bakes a jagged
    // width variation into vx/vy before either brush's own smoothing logic
    // ever sees it. That was silently defeating Rough's "rounded, gentle"
    // edge fix — its own coherent wave was just riding on top of this
    // sharper base noise instead of replacing it.
    const jitterAmt = settings.jitter ?? 0;
    if (jitterAmt > 0 && settings.type !== "oilBrush" && settings.type !== "rough") {
      const n1 = pseudoNoise(i * 12.37);
      const n2 = pseudoNoise(i * 7.91 + 100);
      const factor = 1 + jitterAmt * (n1 * 0.6 + n2 * 0.4) * 0.5;
      // Floor scales down with the taper (via `scale`) so a needle-sharp
      // tip can still reach true 0 width — otherwise this floor overrides
      // the taper and the tip never comes to a point.
      const mag = Math.max(Math.hypot(vx, vy) * factor, semiMajor * 0.12 * scale);
      const ang = Math.atan2(vy, vx);
      vx = Math.cos(ang) * mag;
      vy = Math.sin(ang) * mag;
    }

    const leftBase = { x: pts[i].x + vx, y: pts[i].y + vy };
    const rightBase = { x: pts[i].x - vx, y: pts[i].y - vy };

    if (settings.type === "oilBrush" && (settings.jitter ?? 0) > 0) {
      // Torn dry-brush edge: each side gets its own broad, coherent scallop
      // offset added along the same (already support-correct) direction as
      // vx/vy, independently for left/right so the tear isn't symmetric.
      // This coherent (smoothly-interpolated) wave is the ONLY source of
      // Oil Brush's raggedness now — the edge stays a single smooth curve,
      // just an undulating one, with no sharp per-sample spikes.
      //
      // (An earlier version also inserted branching "frayed bristle" prong
      // geometry along this edge — scattered sharp claw-like points meant
      // to read as breaking bristles. In practice those prongs came out as
      // long, hard-edged triangles jutting out of the stroke rather than
      // soft hairs, so that branching logic has been removed entirely.)
      const mag = Math.hypot(vx, vy) || 1;
      const ux = vx / mag;
      const uy = vy / mag;
      const amp = (settings.jitter ?? 0) * semiMajor * 0.45;
      const leftOff = oilEdgeOffset(s, 7.3, amp);
      const rightOff = oilEdgeOffset(s, 61.9, amp);
      // Same fix as Pencil above: floor scales down with the taper so a
      // needle-sharp end can actually reach 0 width instead of being
      // clamped open by this floor.
      const minMag = semiMajor * 0.12 * scale;
      const leftMag = Math.max(minMag, mag + leftOff);
      const rightMag = Math.max(minMag, mag + rightOff);
      left.push({ x: pts[i].x + ux * leftMag, y: pts[i].y + uy * leftMag });
      right.push({ x: pts[i].x - ux * rightMag, y: pts[i].y - uy * rightMag });
    } else if (settings.type === "grunge") {
      // Insert a sharp outward projection at nearly every centerline sample
      // on BOTH edges. These are real corner nodes, so the distressed spikes
      // remain editable vector geometry rather than a raster/noise effect.
      const tx = tangent.x / tLen;
      const ty = tangent.y / tLen;
      const leftNoise = pseudoNoise(i * 19.17 + 3.1);
      const rightNoise = pseudoNoise(i * 23.73 + 77.7);
      const leftSpike = 1.25 + Math.abs(leftNoise) * 1.35;
      const rightSpike = 1.25 + Math.abs(rightNoise) * 1.35;
      const tangentJitter = settings.size * 0.28;

      left.push(leftBase);
      left.push({
        x: pts[i].x + vx * leftSpike + tx * leftNoise * tangentJitter,
        y: pts[i].y + vy * leftSpike + ty * leftNoise * tangentJitter,
      });

      right.push(rightBase);
      right.push({
        x: pts[i].x - vx * rightSpike + tx * rightNoise * tangentJitter,
        y: pts[i].y - vy * rightSpike + ty * rightNoise * tangentJitter,
      });
    } else if (settings.type === "rough" && (settings.jitter ?? 0) > 0) {
      // Gentle, rounded edge waver: smooth coherent noise (interpolated,
      // not per-sample independent) so the edge undulates in soft, rounded
      // bumps rather than a jagged sawtooth of sharp triangular spikes.
      // Left/right use different seeds so the two edges don't bulge in
      // lockstep. The noise is sampled by ABSOLUTE arc length
      // (`cumulative[i]`), with a wavelength tied only to the nib's own
      // half-width (`semiMajor`) — NOT normalized against the stroke's
      // total length (`s`/`totalLength`). A hand-drawn stroke in Sketch
      // Mode can have a real path length far longer than its visual size
      // (natural hand tremor, retraced segments), so normalizing by
      // `totalLength` squeezed many more wave cycles into that same visual
      // span than intended — the more convoluted the hand-drawn path, the
      // denser and sharper the "gear teeth" got, entirely outside the
      // user's control. Keying off absolute distance instead keeps the
      // bump spacing and amplitude visually consistent no matter how the
      // stroke was drawn. Separate from the interior counter-holes handled
      // in roughBrushOutlineContours() and from Grunge's much sharper,
      // per-sample spikes.
      const roughJitter = settings.jitter ?? 0;
      const mag = Math.hypot(vx, vy) || 1;
      const ux = vx / mag;
      const uy = vy / mag;
      const roughWavelength = semiMajor * 6.5;
      const leftNoise = coherentNoise1D(cumulative[i] / roughWavelength, 7.7);
      const rightNoise = coherentNoise1D(cumulative[i] / roughWavelength, 133.1);
      const leftMag = Math.max(mag * 0.95, mag + leftNoise * roughJitter * semiMajor * 0.055);
      const rightMag = Math.max(mag * 0.95, mag + rightNoise * roughJitter * semiMajor * 0.055);
      left.push({ x: pts[i].x + ux * leftMag, y: pts[i].y + uy * leftMag });
      right.push({ x: pts[i].x - ux * rightMag, y: pts[i].y - uy * rightMag });
    } else if (isJoinCorner) {
      const curSemiA = semiMajor * scale;
      const curSemiB = semiMinor * scale;
      if (joinConvexSide === "left") {
        left.push(...cornerJoinArc(pts[i], joinInAngle, joinOutAngle, curSemiA, curSemiB));
        right.push(rightBase);
      } else {
        left.push(leftBase);
        right.push(...cornerJoinArc(pts[i], joinInAngle + Math.PI, joinOutAngle + Math.PI, curSemiA, curSemiB));
      }
    } else {
      left.push(leftBase);
      right.push(rightBase);
    }
  }

  // Replace the flat chord at each end with a dense arc around the nib's own
  // ellipse boundary, swept through the tangent direction — a rounded,
  // fully-joined tip with no straight seam and no dependence on the (fold-
  // prone) endpoint tangent alone.
  const capArc = (cap: { center: Point; tangentAngle: number; semiA: number; semiB: number }, startAngle: number): Point[] => {
    const segments = 10;
    const arcPts: Point[] = [];
    for (let k = 1; k < segments; k++) {
      const ang = startAngle - (Math.PI * k) / segments;
      const v = ellipseSupportVector(ang, nibAngleRad, cap.semiA, cap.semiB);
      arcPts.push({ x: cap.center.x + v.x, y: cap.center.y + v.y });
    }
    return arcPts;
  };
  // Flat-topped "square" cap: two corner points, offset from the two side
  // points (at `sideAngle` and its opposite) by the ellipse's own extent in
  // `extensionAngle` — i.e. a plate that sticks out past the endpoint by
  // this boundary's own half-width, with hard right-angle corners instead
  // of `capArc`'s smooth sweep. See the capMode comment above for why this
  // needs to be a genuine per-boundary shape rather than a shared flat
  // chord: called once per boundary (outer ring, smaller inner hole), each
  // call's `cap.semiA/semiB` already reflect that boundary's own size, so
  // the outer plate naturally reaches further than the inner plate by the
  // border thickness — keeping the ring's width constant across the cap
  // the same way `capArc`'s concentric arcs do for "round".
  //
  // BUG FIX (square-cap notch at deep joins): that "extend by this
  // boundary's own half-width" rule is exactly right for a truly isolated
  // tip, but Outline Brush's crossing-merge (mergeOutlineBrushStrokes)
  // unions every stroke's hole together and subtracts it from the union of
  // every stroke's solid body — see that function's doc comment. When one
  // stroke's endpoint is drawn buried inside ANOTHER stroke's body (a T
  // junction, a serif foot, a stem meeting a bowl — anywhere a letterform
  // is deliberately overlapped to guarantee a solid join), the INNER hole's
  // own half-width extension can reach past that other stroke's own hole
  // boundary and gouge a small rectangular notch into what should be solid
  // ink there, since a hole from ANY stroke always wins over another
  // stroke's solid ink at the subtract step. The outer boundary doesn't
  // have this problem — its own overshoot only ever ADDS solid coverage,
  // never removes it. So `capForwardOverride`, when given (only the inner
  // hole boundary passes it — see outlineBrushOutlineContours), caps how
  // far a hole's own cap plate can reach past its endpoint to a fixed,
  // modest distance instead of that boundary's full half-width. This makes
  // the ring at a lone open tip a little thicker right at the very end
  // instead of perfectly uniform width — a small, easy-to-miss cosmetic
  // trade — in exchange for never punching an unwanted hole into a
  // neighboring stroke's ink at a join.
  const capSquare = (cap: { center: Point; tangentAngle: number; semiA: number; semiB: number }, sideAngle: number, extensionAngle: number): Point[] => {
    const sideV = ellipseSupportVector(sideAngle, nibAngleRad, cap.semiA, cap.semiB);
    const oppositeV = ellipseSupportVector(sideAngle - Math.PI, nibAngleRad, cap.semiA, cap.semiB);
    const forwardV =
      capForwardOverride !== undefined
        ? ellipseSupportVector(extensionAngle, nibAngleRad, capForwardOverride, capForwardOverride)
        : ellipseSupportVector(extensionAngle, nibAngleRad, cap.semiA, cap.semiB);
    return [
      { x: cap.center.x + sideV.x + forwardV.x, y: cap.center.y + sideV.y + forwardV.y },
      { x: cap.center.x + oppositeV.x + forwardV.x, y: cap.center.y + oppositeV.y + forwardV.y },
    ];
  };
  const endCapPts = endCap
    ? capMode === "comb"
      // Teeth point straight OUT along the direction of travel (the stroke
      // is heading this way and keeps going past the tip).
      ? combToothCap(endCap, endCap.tangentAngle + Math.PI / 2, endCap.tangentAngle, nibAngleRad, 11.3)
      : capMode === "square"
        ? capSquare(endCap, endCap.tangentAngle + Math.PI / 2, endCap.tangentAngle)
        : capArc(endCap, endCap.tangentAngle + Math.PI / 2)
    : [];
  const startCapPts = startCap
    ? capMode === "comb"
      // Teeth point straight BACK, opposite the direction of travel (the
      // stroke starts here and heads forward, so the tip trails behind).
      ? combToothCap(startCap, startCap.tangentAngle - Math.PI / 2, startCap.tangentAngle + Math.PI, nibAngleRad, 83.1)
      : capMode === "square"
        ? capSquare(startCap, startCap.tangentAngle - Math.PI / 2, startCap.tangentAngle + Math.PI)
        : capArc(startCap, startCap.tangentAngle - Math.PI / 2)
    : [];

  // Clean up local self-intersections on each side independently (see
  // removeSelfIntersectionLoops's doc comment) — this is what keeps a
  // sharply bent stroke's offset a single simple loop on the inner/concave
  // side of the bend instead of folding over itself, which is what left a
  // visible open gap in Outline Brush's hole at a bend. Skipped for the
  // brushes with their own deliberate fine-grained edge noise (Grunge, Oil
  // Brush, Rough): their edges are SUPPOSED to weave in and out locally,
  // and this pass would iron that texture back out.
  const SELF_CLEAN_SKIP: BrushType[] = ["grunge", "oilBrush", "rough"];
  const cleanedLeft = SELF_CLEAN_SKIP.includes(settings.type) ? left : removeSelfIntersectionLoops(left);
  const cleanedRight = SELF_CLEAN_SKIP.includes(settings.type) ? right : removeSelfIntersectionLoops(right);

  // The edges above are built from the DENSE catmullRomResample points
  // (spaced every ~0.06x brush size) so the nib's width tracks the gesture
  // accurately — but every one of those points becomes a real, editable
  // "corner" node below. On a simple, gently-curving letterform that's
  // hundreds of near-collinear nodes doing the job three or four could do.
  // Thin each edge back down with the same Ramer-Douglas-Peucker pass used
  // elsewhere, at a tolerance tied to the nib's own half-width so it stays
  // invisible at the letter's actual size — corners and genuine texture
  // survive (RDP only drops points that don't deviate from the line
  // between their kept neighbors), only the redundant in-between points
  // along straight/near-straight runs go. Brushes with deliberate
  // per-sample edge noise (grunge/oil/rough) keep every sample, same as
  // the self-intersection cleanup above, since thinning would iron their
  // texture back out.
  // BUG FIX: was `semiMajor * 0.09` which over-simplified curved edges —
  // too many points got dropped from the offset polygon, leaving too few
  // nodes for the Bezier handle fitter below to reconstruct a truly smooth
  // arc. The fitter needs reasonably dense samples around each bend to
  // compute accurate handle lengths. Lowered to 0.055x so gentle curves
  // retain enough geometry for the smooth fit to match the actual nib sweep,
  // without keeping so many near-collinear points that the node count
  // becomes unworkable. Sharp corners still survive (RDP never drops a
  // point that IS the corner between two segments).
  // BUG FIX (ring width inconsistent on curves, esp. Outline Brush): this
  // used to always be derived from THIS call's own `semiMajor` — fine for a
  // single solid stroke, but Outline Brush calls this function twice from
  // outlineBrushOutlineContours (once for the outer boundary at the full
  // nib size, once for the inner hole at a smaller size). The inner call's
  // smaller `semiMajor` produced a smaller epsilon, so the outer and inner
  // edges got Ramer-Douglas-Peucker-simplified to different point densities
  // and then Bezier-refit independently — two curves meant to be a constant
  // offset apart instead drifted non-parallel, worst exactly where fitting
  // error is largest: through bends/curves. That's what read as the
  // border's width visibly pulsing wide/thin around a curve. Accepting a
  // shared override lets a caller building a matched boundary PAIR force
  // identical simplification on both sides so they stay geometrically
  // parallel; single-boundary callers are unaffected since the override is
  // optional and falls back to the old per-call calculation.
  const edgeSimplifyEpsilon = edgeSimplifyEpsilonOverride ?? Math.max(0.5, Math.min(3, semiMajor * 0.055));
  const simplifiedLeft = SELF_CLEAN_SKIP.includes(settings.type) ? cleanedLeft : simplifyPolyline(cleanedLeft, edgeSimplifyEpsilon);
  const simplifiedRight = SELF_CLEAN_SKIP.includes(settings.type) ? cleanedRight : simplifyPolyline(cleanedRight, edgeSimplifyEpsilon);

  const polygon = [...simplifiedLeft, ...endCapPts, ...simplifiedRight.reverse(), ...startCapPts];
  if (polygon.length < 3) return null;
  // BUG FIX: "strong" was missing from this list, so its polygon edges were
  // built from raw corner nodes even though its body is a clean, round-nib
  // stroke — exactly the same faceted look as the other brushes before that
  // fix. Added here so Strong Brush gets the same Catmull-Rom-to-Bezier
  // handle fitting as every other round/constant-width preset.
  const SMOOTH_EDGE_TYPES: BrushType[] = [
    "round", "monoline", "marker", "calligraphic", "pencil", "pressureTaper", "outline", "strong",
  ];
  const smoothEdges = SMOOTH_EDGE_TYPES.includes(settings.type);
  // Outline Brush's "square" cap style ends in a flat-topped plate with
  // hard right-angle corners (see capSquare above). But on a smooth-edge
  // brush type like this one, those corners land right around 90°, just
  // under the ~100° cusp threshold below used to preserve genuine sharp
  // turns — so they were quietly getting rounded into a small curve instead
  // of staying crisp. Force every node around both cap plates (see the
  // `polygon` assembly just above: `[...simplifiedLeft, ...endCapPts,
  // ...simplifiedRight.reverse(), ...startCapPts]`) to stay a hard corner
  // no matter what its measured turn angle comes out to. Also covers plain
  // "none" (non-outline flat-cut brushes), where endCapPts/startCapPts are
  // empty and this reduces to just the four chord-junction indices.
  const forceCornerIndices =
    (capMode === "square" || capMode === "none") && settings.type === "outline"
      ? new Set<number>([
          0,
          simplifiedLeft.length - 1,
          simplifiedLeft.length,
          simplifiedLeft.length + endCapPts.length - 1,
          simplifiedLeft.length + endCapPts.length,
          simplifiedLeft.length + endCapPts.length + simplifiedRight.length - 1,
          simplifiedLeft.length + endCapPts.length + simplifiedRight.length,
          polygon.length - 1,
        ])
      : null;
  const polygonNodes = smoothEdges
    ? polygon.map((point, i) => {
        const prev = polygon[(i - 1 + polygon.length) % polygon.length];
        const next = polygon[(i + 1) % polygon.length];
        const inLen = Math.hypot(point.x - prev.x, point.y - prev.y) || 1;
        const outLen = Math.hypot(next.x - point.x, next.y - point.y) || 1;
        const inUx = (point.x - prev.x) / inLen, inUy = (point.y - prev.y) / inLen;
        const outUx = (next.x - point.x) / outLen, outUy = (next.y - point.y) / outLen;
        const dot = Math.max(-1, Math.min(1, inUx * outUx + inUy * outUy));
        // Preserve genuine cusps (for example a sharp calligraphic turn)
        // while rounding the many tiny polygon facets along a curve.
        // Acos(dot) is the actual turn angle at this vertex — only a real,
        // sharp reversal (~90°+) stays a hard corner; anything gentler
        // gets a fitted curve below.
        if (forceCornerIndices?.has(i) || Math.acos(dot) > (100 * Math.PI) / 180) {
          return { id: shortId("node"), point, handleIn: null, handleOut: null, type: "corner" as const };
        }
        // BUG FIX: handle length used to be a flat `min(inLen, outLen) * 0.22`
        // — a constant fraction of whichever adjacent segment happened to be
        // shorter, from a tangent that only looked at the immediate
        // neighbors' DIRECTION (not how far apart they actually are). Once
        // the offset edge was Ramer-Douglas-Peucker-simplified down to a
        // sparse polygon, that constant under-curved every real bend: the
        // node's OWN type/handles were genuinely "smooth", but the handles
        // were too short to bulge the curve out to where the original swept
        // nib actually was, so the rendered edge still looked faceted/
        // polygonal despite the nodes being curved (exactly the reported
        // bug — visible on nearly every brush that reaches this smoothing
        // path). Using the standard Catmull-Rom-to-Bezier control-point
        // formula instead — (next - prev) / 6, NOT normalized — scales the
        // handle length with the actual local chord distance on both
        // sides, so it tracks real curvature rather than a fixed fraction,
        // and matches the same conversion already used for the centerline
        // itself (see catmullRomPoint above).
        // BUG FIX ("menyong"/lopsided round caps): this used to build ONE
        // shared vector `(next-prev)/6` and mirror it to both handleIn and
        // handleOut, i.e. both handles were forced to the exact same
        // length. That's a fine approximation when `prev`/`next` sit at
        // roughly equal distances from `point`, but Outline Brush's round
        // cap is exactly the one place that assumption breaks: capArc()
        // hands back a dense run of evenly-spaced arc points, stitched
        // directly onto the rail edge's own RDP-simplified points, which
        // are usually spaced very differently (often much farther apart).
        // Right at that arc-to-rail junction, `inLen` and `outLen` differ a
        // lot — but the old code still gave both sides the same handle
        // length, so one side overshot past where the actual geometry was
        // and the other undershot, bulging the tip out unevenly to one
        // side. Scaling handleIn/handleOut independently by their OWN local
        // segment length keeps the tangent direction shared (still C1
        // continuous — no visible kink) while letting each side's bulge
        // amount track its own real spacing, so a round cap stays a even,
        // symmetric arc instead of leaning toward whichever neighbor
        // happened to be closer.
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        const dLen = Math.hypot(dx, dy) || 1;
        const ux = dx / dLen;
        const uy = dy / dLen;
        // 1/3 of the local segment length is the standard smooth-cubic
        // handle length for evenly spaced points; the 0.65x cap (kept from
        // the previous fix) still guards against overshoot on any
        // unusually short segment.
        const inHandleLen = Math.min(inLen / 3, inLen * 0.65);
        const outHandleLen = Math.min(outLen / 3, outLen * 0.65);
        return {
          id: shortId("node"),
          point,
          handleIn: { x: point.x - ux * inHandleLen, y: point.y - uy * inHandleLen },
          handleOut: { x: point.x + ux * outHandleLen, y: point.y + uy * outHandleLen },
          type: "smooth" as const,
        };
      })
    : polygon.map((point) => ({
        id: shortId("node"),
        point,
        handleIn: null,
        handleOut: null,
        type: "corner" as const,
      }));
  return {
    id: shortId("contour"),
    closed: true,
    nodes: polygonNodes,
  };
}

/**
 * Pixel Brush's outline. This deliberately does NOT go through the
 * elliptical nib model above — a smoothed nib swept along grid-snapped
 * points would still look like a rounded line that merely tracks the grid.
 * Instead, every grid cell the stroke actually passes through becomes its
 * own axis-aligned square contour, so the result is genuinely made of
 * blocks (true grid-cell fill), which is what a pixel-font tool needs.
 * A Bresenham walk over cell indices between consecutive points fills in
 * any cell a fast or diagonal move would otherwise skip, so the blocks
 * always stay connected. This path is reached ONLY when `settings.gridSnap`
 * is set (Pixel Brush exclusively) — see `centerlineToOutlineContours`.
 */
export function pixelBlockOutline(centerline: { x: number; y: number }[], cellSize: number): Contour[] {
  if (centerline.length === 0 || cellSize <= 0) return [];

  // Pointer samples sit at CELL CENTERS (never on grid-line intersections).
  // floor() maps each center back to its containing cell; each square's edges
  // then land exactly on the visible grid lines.
  const toCell = (p: { x: number; y: number }) => ({
    cx: Math.floor(p.x / cellSize),
    cy: Math.floor(p.y / cellSize),
  });

  const seen = new Set<string>();
  const cells: { cx: number; cy: number }[] = [];
  const addCell = (cx: number, cy: number) => {
    const key = `${cx},${cy}`;
    if (seen.has(key)) return;
    seen.add(key);
    cells.push({ cx, cy });
  };

  let prevCell = toCell(centerline[0]);
  addCell(prevCell.cx, prevCell.cy);
  for (let i = 1; i < centerline.length; i++) {
    const cur = toCell(centerline[i]);
    let x0 = prevCell.cx;
    let y0 = prevCell.cy;
    const x1 = cur.cx;
    const y1 = cur.cy;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (x0 !== x1 || y0 !== y1) {
      addCell(x0, y0);
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    addCell(x1, y1);
    prevCell = cur;
  }

  return cells.map(({ cx, cy }) => {
    const x0 = cx * cellSize;
    const y0 = cy * cellSize;
    const x1 = x0 + cellSize;
    const y1 = y0 + cellSize;
    const corners: Point[] = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
    return {
      id: shortId("contour"),
      closed: true,
      nodes: corners.map((point) => ({ id: shortId("node"), point, handleIn: null, handleOut: null, type: "corner" as const })),
    };
  });
}

/** Same Bresenham cell-walk as pixelBlockOutline, factored out so Pixel
 * Liquid mode (below) starts from the exact same set of grid cells the
 * crisp block mode would use — only what happens to those cells differs. */
function pixelGridCells(centerline: { x: number; y: number }[], cellSize: number): { cx: number; cy: number }[] {
  const toCell = (p: { x: number; y: number }) => ({ cx: Math.floor(p.x / cellSize), cy: Math.floor(p.y / cellSize) });
  const seen = new Set<string>();
  const cells: { cx: number; cy: number }[] = [];
  const addCell = (cx: number, cy: number) => {
    const key = `${cx},${cy}`;
    if (seen.has(key)) return;
    seen.add(key);
    cells.push({ cx, cy });
  };
  if (centerline.length === 0) return cells;
  let prevCell = toCell(centerline[0]);
  addCell(prevCell.cx, prevCell.cy);
  for (let i = 1; i < centerline.length; i++) {
    const cur = toCell(centerline[i]);
    let x0 = prevCell.cx;
    let y0 = prevCell.cy;
    const x1 = cur.cx;
    const y1 = cur.cy;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (x0 !== x1 || y0 !== y1) {
      addCell(x0, y0);
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    addCell(x1, y1);
    prevCell = cur;
  }
  return cells;
}

/**
/**
 * Pixel Liquid mode: walks the exact same grid cells the crisp Pixel Brush
 * uses (pixelGridCells above) as a single connected skeleton path, then
 * re-strokes that path with a round pen — the same round/pill stroking
 * machinery every other round brush already uses (see centerlineToOutline's
 * ROUND_CAP_TYPES + SMOOTH_EDGE_TYPES handling), just fed a grid-quantized
 * centerline instead of the raw pointer path. A round pen's own offset
 * geometry is what turns each 90° grid corner into a smooth, fused joint —
 * no separate per-cell shape or merge step needed, which is what gives a
 * clean, continuous rounded-pixel/"gummy" look (bars flowing smoothly into
 * each other at grid turns) rather than a pile of separately blended blobs.
 */
export function pixelLiquidOutline(
  centerline: { x: number; y: number }[],
  cellSize: number,
  smoothness: number,
  settings: BrushSettings
): Contour[] {
  if (centerline.length === 0 || cellSize <= 0) return [];
  const s = Math.max(0, Math.min(1, smoothness));
  const cells = pixelGridCells(centerline, cellSize);
  if (cells.length === 0) return [];

  const skeleton: StrokeSample[] = cells.map(({ cx, cy }) => ({
    x: (cx + 0.5) * cellSize,
    y: (cy + 0.5) * cellSize,
    pressure: 1,
  }));
  if (skeleton.length === 1) {
    // A single tapped cell has no direction to stroke along — give it a
    // hair of length so the round pen still draws a full round dot there.
    skeleton.push({ x: skeleton[0].x + 0.01, y: skeleton[0].y, pressure: 1 });
  }

  // Wider than the raw cell size so neighboring/nearby cells' pen sweeps
  // actually overlap into one continuous shape at grid turns instead of
  // pinching to a thin waist; `smoothness` widens that overlap further for
  // a chunkier, more fused "liquid" look.
  const width = cellSize * (0.95 + 0.55 * s);
  const roundSettings: BrushSettings = {
    ...settings,
    type: "round",
    size: width,
    roundness: 1,
    angle: 0,
    taperStart: 0,
    taperEnd: 0,
    sharpStart: false,
    sharpEnd: false,
    pressureEnabled: false,
    jitter: 0,
  };

  const contour = centerlineToOutline(skeleton, roundSettings);
  return contour ? [contour] : [];
}

function signedArea(points: Point[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    a += p1.x * p2.y - p2.x * p1.y;
  }
  return a / 2;
}

/**
 * Small irregular counter-hole, punched by winding it OPPOSITE to the main
 * contour (see pathBuilder.ts's objectFillPath doc comment on nonzero fill
 * + winding). Built as a wobbly polygon — with randomized side count,
 * elongation and rotation per hole — so a cluster reads as genuinely
 * abstract organic voids (torn/eaten-away shapes) rather than a row of
 * near-identical dots.
 *
 * Shape scales with size relative to `refRadius` (the stroke's baseline
 * hole radius before per-hole size variety is applied): holes noticeably
 * smaller than that baseline are rendered as coarse, angular "grit" (fewer
 * sides, stronger per-vertex wobble) so a dense field of them reads as
 * pitted/corroded texture rather than a scatter of tiny circles. Holes at
 * or above the baseline keep the higher side count / gentler wobble of a
 * soft, rounded blob, so the occasional larger void still looks like a
 * genuine torn-away chunk rather than a spiky star.
 */
function makeRoughHole(center: Point, radius: number, seed: number, desiredSign: number, refRadius: number): Contour {
  const isGrit = refRadius > 0 && radius < refRadius * 0.6;
  const sides = isGrit
    ? 5 + Math.round(((pseudoNoise(seed + 5.5) + 1) / 2) * 3) // 5..8 sides — coarse grit speck
    : 9 + Math.round(((pseudoNoise(seed + 5.5) + 1) / 2) * 6); // 9..15 sides — soft blob
  const wobbleAmt = isGrit ? 0.34 : 0.18;
  const stretch = 0.55 + ((pseudoNoise(seed + 12.2) + 1) / 2) * 0.9; // 0.55x..1.45x on one axis
  const rot = pseudoNoise(seed + 19.8) * Math.PI;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const raw: Point[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 + pseudoNoise(seed + i * 2.1) * (isGrit ? 0.22 : 0.12);
    const wobble = 1 + pseudoNoise(seed + i * 3.7) * wobbleAmt;
    const lx = Math.cos(a) * radius * wobble * stretch;
    const ly = Math.sin(a) * radius * wobble;
    raw.push({ x: center.x + lx * cosR - ly * sinR, y: center.y + lx * sinR + ly * cosR });
  }
  const sign = Math.sign(signedArea(raw));
  const pts = sign !== 0 && sign !== desiredSign ? [...raw].reverse() : raw;
  return {
    id: shortId("contour"),
    closed: true,
    nodes: pts.map((point) => ({ id: shortId("node"), point, handleIn: null, handleOut: null, type: "corner" as const })),
  };
}

/**
 * Tiny filled speck — same winding as the main contour (adds ink, doesn't
 * punch through it) — used for Oil Brush's spatter dots near a frayed edge.
 */
function makeSpeckle(center: Point, radius: number, seed: number, desiredSign: number, sides = 12): Contour {
  // 12 sides + smooth (curved, not corner) nodes reads as a soft round ink
  // droplet. The previous 6-corner polygon with sharp "corner" node types
  // faceted into a visible little hexagon at real brush sizes, which is
  // what made the whole spray field look mechanical/blocky instead of like
  // fine atomized specks. `sides` is lowered (still smooth-noded, just
  // coarser) for the Spray Brush's live-drawing `fast` preview — see
  // sprayBrushOutlineContours' doc comment — where speed matters more than
  // per-speck roundness.
  const raw: Point[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 + pseudoNoise(seed + i * 2.1) * 0.35;
    const wobble = 1 + pseudoNoise(seed + i * 4.3) * 0.45;
    raw.push({ x: center.x + Math.cos(a) * radius * wobble, y: center.y + Math.sin(a) * radius * wobble });
  }
  const sign = Math.sign(signedArea(raw));
  const pts = sign !== 0 && sign !== desiredSign ? [...raw].reverse() : raw;
  const n = pts.length;
  return {
    id: shortId("contour"),
    closed: true,
    nodes: pts.map((p, i) => {
      const prev = pts[(i - 1 + n) % n];
      const next = pts[(i + 1) % n];
      const hx = (next.x - prev.x) / 6;
      const hy = (next.y - prev.y) / 6;
      return {
        id: shortId("node"),
        point: p,
        handleIn: { x: p.x - hx, y: p.y - hy },
        handleOut: { x: p.x + hx, y: p.y + hy },
        type: "smooth" as const,
      };
    }),
  };
}

/**
 * Thin oriented rectangle (with a slight taper at each end so it doesn't
 * read as a ruled line) — the vector shape behind Oil Brush's bristle-comb
 * streaks. Built directly rather than via an ellipse, since the comb marks
 * in a real dry-brush pass are straight-ish gaps, not round voids.
 */
function makeCombDash(center: Point, tangent: Point, length: number, thickness: number, desiredSign: number, seed: number): Contour {
  const tLen = Math.hypot(tangent.x, tangent.y) || 1;
  const tx = tangent.x / tLen;
  const ty = tangent.y / tLen;
  const nx = -ty;
  const ny = tx;
  const hl = length / 2;
  const ht = thickness / 2;
  // Slight end taper (70% width at the very tips) so each dash reads as a
  // dry, tapering bristle mark rather than a mechanical slot.
  const rawPts: Point[] = [
    { x: center.x - tx * hl, y: center.y - ty * hl },
    { x: center.x - tx * hl * 0.82 + nx * ht, y: center.y - ty * hl * 0.82 + ny * ht },
    { x: center.x + tx * hl * 0.82 + nx * ht, y: center.y + ty * hl * 0.82 + ny * ht },
    { x: center.x + tx * hl, y: center.y + ty * hl },
    { x: center.x + tx * hl * 0.82 - nx * ht, y: center.y + ty * hl * 0.82 - ny * ht },
    { x: center.x - tx * hl * 0.82 - nx * ht, y: center.y - ty * hl * 0.82 - ny * ht },
  ];
  const sign = Math.sign(signedArea(rawPts));
  const pts = sign !== 0 && sign !== desiredSign ? [...rawPts].reverse() : rawPts;
  void seed;
  return {
    id: shortId("contour"),
    closed: true,
    nodes: pts.map((point) => ({ id: shortId("node"), point, handleIn: null, handleOut: null, type: "corner" as const })),
  };
}

/**
 * Rough Brush: the same constant-width elliptical-nib body every other
 * brush uses (via centerlineToOutline), plus a dense scatter of small
 * irregular counter-holes punched through the interior — real vector
 * counters, so they export cleanly into the font, not a raster texture.
 * Count, size and placement are all deterministically seeded from the
 * stroke's own geometry so the texture doesn't flicker on re-render.
 *
 * Sizing is deliberately bimodal: most holes land small (coarse "grit",
 * see the `isGrit` branch in makeRoughHole) and a minority land
 * noticeably larger, mimicking how corrosion/erosion actually pits a
 * surface — lots of fine pinholes peppering the body with a scatter of
 * bigger eaten-away voids on top — rather than a uniform field of
 * same-sized dots.
 */
function roughBrushOutlineContours(centerline: StrokeSample[], settings: BrushSettings): Contour[] {
  const main = centerlineToOutline(centerline, settings);
  if (!main) return [];
  const outerSign = Math.sign(signedArea(main.nodes.map((n) => n.point))) || 1;
  const holeSign = outerSign >= 0 ? -1 : 1;

  const dense = catmullRomResample(centerline, Math.max(0.6, settings.size * 0.06));
  if (dense.length < 2) return [main];

  const cumulative: number[] = [0];
  for (let i = 1; i < dense.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y));
  }
  const totalLength = cumulative[cumulative.length - 1] || 0;
  const halfWidth = Math.max(0.5, settings.size / 2);
  const margin = Math.max(6, halfWidth * 1.2);

  const density = settings.holeDensity ?? 0.9;
  // Dense pitted-texture field: a much finer divisor than before (18, not
  // 95) so the count scales up sharply with density/length, capped well
  // above the old 28 so a full glyph reads as heavily corroded rather than
  // a light, sparse scatter.
  const holeCount = totalLength <= margin * 2 ? 0 : Math.max(0, Math.min(220, Math.round((totalLength / 18) * density)));

  const baseRadius = halfWidth * (settings.holeSize ?? 0.16);
  const holes: Contour[] = [];
  for (let h = 0; h < holeCount; h++) {
    const seed = h * 971.31 + totalLength * 0.013;
    // Evenly-spaced anchor per hole index, with a jitter of its own slot
    // width — "merata" (evenly spread) coverage along the stroke rather
    // than pure-random placement, which tends to clump and leave empty
    // stretches. The jitter fraction is wider than before so the result
    // doesn't read as a mechanically regular row once density is high.
    const span = Math.max(1, totalLength - margin * 2);
    const slot = span / holeCount;
    const tTarget = margin + (h + 0.5) * slot + pseudoNoise(seed + 5.3) * slot * 0.55;
    let idx = 1;
    while (idx < cumulative.length - 1 && cumulative[idx] < tTarget) idx++;
    const p0 = dense[idx - 1];
    const p1 = dense[idx];
    const tangent = { x: p1.x - p0.x, y: p1.y - p0.y };
    const tLen = Math.hypot(tangent.x, tangent.y) || 1;
    const normal = { x: -tangent.y / tLen, y: tangent.x / tLen };
    const s = totalLength > 0 ? tTarget / totalLength : 0.5;
    const taper = taperFactor(s, settings.taperStart, settings.taperEnd, { sharpStart: settings.sharpStart, sharpEnd: settings.sharpEnd });
    const edgeGuard = Math.max(1.4, halfWidth * 0.2);
    const usableHalf = Math.max(1, halfWidth * taper - edgeGuard);
    // Bimodal size: rand01 is uniform, raising it to a power skews most
    // draws toward 0 (small "grit") while still occasionally producing a
    // draw near 1 (a noticeably bigger eaten-away blotch) — the pitted,
    // unevenly-corroded look, instead of the old near-uniform spread.
    const rand01 = (pseudoNoise(seed + 88.2) + 1) / 2;
    const sizeJitter = 0.35 + Math.pow(rand01, 2.4) * 2.3;
    const radius = Math.max(0.4, baseRadius * sizeJitter);
    if (radius >= usableHalf) continue; // no room for this hole at all
    // Offset is scaled by the room actually left AFTER the hole's own
    // radius, so hole + radius can never reach the outer boundary — this
    // is what previously let big holes bite into the edge and read as
    // sharp, irregular notches instead of a clean interior void. Pushed
    // slightly closer to the boundary (0.95, not 0.85) so the texture
    // visibly reaches near the edge, matching a corroded/pitted stroke.
    const safeRange = Math.max(0, usableHalf - radius);
    const offset = pseudoNoise(seed + 41.7) * safeRange * 0.95;
    const center = { x: p1.x + normal.x * offset, y: p1.y + normal.y * offset };
    holes.push(makeRoughHole(center, radius, seed, holeSign, baseRadius));
  }

  return [main, ...holes];
}

/**
 * Oil Brush: the branching frayed edge (built directly into the left/right
 * arrays inside centerlineToOutline) plus two more things a real dry-brush
 * pass shows that an edge-only effect can't: parallel bristle "comb" gaps
 * running lengthwise through the body, and a scatter of tiny ink spatter
 * specks trailing off the frayed (tail) end. Both are real vector counters/
 * fills — not a raster texture — so they export cleanly into the font.
 */
function oilBrushOutlineContours(centerline: StrokeSample[], settings: BrushSettings): Contour[] {
  const main = centerlineToOutline(centerline, settings);
  if (!main) return [];
  const outerSign = Math.sign(signedArea(main.nodes.map((n) => n.point))) || 1;
  const holeSign = outerSign >= 0 ? -1 : 1;

  const dense = catmullRomResample(centerline, Math.max(0.6, settings.size * 0.06));
  if (dense.length < 2) return [main];

  const cumulative: number[] = [0];
  for (let i = 1; i < dense.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y));
  }
  const totalLength = cumulative[cumulative.length - 1] || 0;
  const halfWidth = Math.max(0.5, settings.size / 2);
  const margin = Math.max(6, halfWidth * 0.9);
  if (totalLength <= margin * 2) return [main];

  const at = (t: number): { p: Point; tangent: Point; taper: number } => {
    const clamped = Math.max(0, Math.min(totalLength, t));
    let idx = 1;
    while (idx < cumulative.length - 1 && cumulative[idx] < clamped) idx++;
    const p0 = dense[idx - 1];
    const p1 = dense[idx];
    const segLen = cumulative[idx] - cumulative[idx - 1] || 1;
    const frac = (clamped - cumulative[idx - 1]) / segLen;
    const p = { x: p0.x + (p1.x - p0.x) * frac, y: p0.y + (p1.y - p0.y) * frac };
    const tangent = { x: p1.x - p0.x, y: p1.y - p0.y };
    const s = totalLength > 0 ? clamped / totalLength : 0;
    return { p, tangent, taper: taperFactor(s, settings.taperStart, settings.taperEnd, { sharpStart: settings.sharpStart, sharpEnd: settings.sharpEnd }) };
  };
  const normalOf = (tangent: Point): Point => {
    const len = Math.hypot(tangent.x, tangent.y) || 1;
    return { x: -tangent.y / len, y: tangent.x / len };
  };

  // Bristle comb streaks: a handful of lanes across the nib's width, each
  // broken into a few dash segments running lengthwise — the parallel light
  // striations a stiff, loaded flat brush leaves through the middle of a
  // dry-brush pass.
  const laneCount = 6;
  const dashHoles: Contour[] = [];
  for (let lane = 0; lane < laneCount; lane++) {
    const laneFrac = (lane + 0.5) / laneCount - 0.5; // -0.42 .. 0.42
    const laneSeed = lane * 133.7 + 4.1;
    const dashCount = 3 + Math.round(((pseudoNoise(laneSeed) + 1) / 2) * 3);
    for (let d = 0; d < dashCount; d++) {
      const seed = laneSeed + d * 57.3;
      const tCenter = margin + ((pseudoNoise(seed) + 1) / 2) * (totalLength - margin * 2);
      const dashLen = Math.max(4, halfWidth * (1.6 + ((pseudoNoise(seed + 8.8) + 1) / 2) * 2.4));
      const { p, tangent, taper } = at(tCenter);
      if (taper < 0.35) continue; // stay clear of the already-frayed taper zones
      const normal = normalOf(tangent);
      const laneOffset = laneFrac * halfWidth * taper * 1.5;
      const jitterOffset = pseudoNoise(seed + 21.4) * halfWidth * 0.08;
      const center = { x: p.x + normal.x * (laneOffset + jitterOffset), y: p.y + normal.y * (laneOffset + jitterOffset) };
      const thickness = Math.max(0.6, halfWidth * (0.05 + ((pseudoNoise(seed + 33.1) + 1) / 2) * 0.045));
      const usableHalf = halfWidth * taper;
      if (Math.abs(laneOffset) + thickness >= usableHalf) continue;
      dashHoles.push(makeCombDash(center, tangent, dashLen, thickness, holeSign, seed));
    }
  }

  // Ink spatter: small solid specks trailing off the frayed tail end,
  // scattered outward beyond the main silhouette — the fine spray a loaded
  // brush leaves as it's dragged and lifted.
  const speckles: Contour[] = [];
  const speckleCount = Math.max(4, Math.min(16, Math.round(totalLength / 40)));
  for (let k = 0; k < speckleCount; k++) {
    const seed = k * 213.5 + 71.9;
    // Weighted toward the tail (s near 1), a little toward the head too.
    const towardTail = pseudoNoise(seed) > -0.3;
    const s = towardTail
      ? 0.82 + ((pseudoNoise(seed + 5) + 1) / 2) * 0.28
      : ((pseudoNoise(seed + 5) + 1) / 2) * 0.12;
    const { p, tangent, taper } = at(s * totalLength);
    const normal = normalOf(tangent);
    const side = pseudoNoise(seed + 11) > 0 ? 1 : -1;
    const reach = halfWidth * taper * (1.05 + ((pseudoNoise(seed + 17) + 1) / 2) * 0.9);
    const along = pseudoNoise(seed + 23) * halfWidth * 0.8;
    const center = {
      x: p.x + normal.x * side * reach + (tangent.x / (Math.hypot(tangent.x, tangent.y) || 1)) * along,
      y: p.y + normal.y * side * reach + (tangent.y / (Math.hypot(tangent.x, tangent.y) || 1)) * along,
    };
    const radius = Math.max(0.5, halfWidth * (0.04 + ((pseudoNoise(seed + 29) + 1) / 2) * 0.07));
    speckles.push(makeSpeckle(center, radius, seed, outerSign));
  }

  return [main, ...dashHoles, ...speckles];
}

/**
 * Spray Brush: a real solid stroke body — the same elliptical-nib sweep
 * every other preset uses (via centerlineToOutline) — with a grainy, torn
 * edge of scattered ink flecks layered on top, instead of a scattered dot
 * field standing in for the WHOLE body.
 *
 * Pure dot field, no solid body underneath: density itself carries the
 * shape. Every speck's distance from the centerline is drawn from a
 * distribution biased toward 0 (see `radiusFrac` below), so most land near
 * the core — tight enough to overlap into what reads as solid ink — and
 * progressively fewer land further out, thinning into individual visible
 * specks and then a light mist at the edge. `roundness` controls how tight
 * vs. loose the graininess reads, `jitter` how heavy/dense it is — reusing
 * the same two sliders every other "reused slider" preset in this file does
 * (see their doc comments in types/brush.ts) rather than adding dedicated
 * fields.
 */
/**
 * PERFORMANCE FIX (Spray Brush stutters/lags while drawing): this function
 * scatters `specksPerStep` little 12-sided speckle contours at every
 * `stepLen` along the WHOLE stroke, from scratch, every single call — and
 * `useBrushTool`'s pointerMove previously called it (via
 * `centerlineToOutlineContours`) unthrottled on every raw pointer-move
 * event, rebuilding the ENTIRE speck field for the whole stroke-so-far each
 * time. For a stroke of length L that's O(L) work per move and O(L^2) total
 * across a single gesture — thousands of speckle contours (each with 12
 * Bezier nodes + a fresh id) regenerated dozens of times a second as the
 * stroke grows, which is exactly what reads as laggy/patah-patah (choppy)
 * while actively spraying, getting worse the longer the stroke gets.
 *
 * `fast`, when true, is used ONLY for the live drawing preview (see
 * `useBrushTool.buildPreview`) and drastically thins the field: far fewer
 * steps along the stroke, far fewer specks per step, and simpler (6-sided
 * instead of 12) speckle polygons — cheap enough to rebuild every frame
 * without stalling the pointer. The committed/final render (glyph canvas,
 * export, thumbnails — anywhere `fast` isn't explicitly passed) still uses
 * the full, dense field exactly as before, so finished artwork is
 * unaffected; only the live in-progress preview gets coarser.
 */
function sprayBrushOutlineContours(centerline: StrokeSample[], settings: BrushSettings, fast = false): Contour[] {
  const dense = catmullRomResample(centerline, Math.max(0.6, settings.size * 0.05));
  if (dense.length < 2) return [];

  const cumulative: number[] = [0];
  for (let i = 1; i < dense.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y));
  }
  const totalLength = cumulative[cumulative.length - 1] || 0;
  if (totalLength <= 0) return [];

  const at = (t: number): { p: Point; tangent: Point; taper: number } => {
    const clamped = Math.max(0, Math.min(totalLength, t));
    let idx = 1;
    while (idx < cumulative.length - 1 && cumulative[idx] < clamped) idx++;
    const p0 = dense[idx - 1];
    const p1 = dense[idx];
    const segLen = cumulative[idx] - cumulative[idx - 1] || 1;
    const frac = (clamped - cumulative[idx - 1]) / segLen;
    const p = { x: p0.x + (p1.x - p0.x) * frac, y: p0.y + (p1.y - p0.y) * frac };
    const tangent = { x: p1.x - p0.x, y: p1.y - p0.y };
    const s = totalLength > 0 ? clamped / totalLength : 0;
    return { p, tangent, taper: taperFactor(s, settings.taperStart, settings.taperEnd, { sharpStart: settings.sharpStart, sharpEnd: settings.sharpEnd }) };
  };

  const halfWidthBase = Math.max(1, settings.size / 2);
  // 1 (default-ish) keeps flecks close and tight; lower roundness loosens
  // them into a wider, coarser scatter.
  const spread = 0.6 + 0.55 * settings.roundness;
  const density = settings.jitter ?? 0.6;

  // `fast` (live preview only, see doc comment above) spaces steps out
  // ~4x further apart and draws ~4x fewer specks at each one — roughly a
  // 16x cut in total speck count, which is what actually removes the lag
  // (specks-per-move, not step count alone, was the dominant cost). The
  // committed/final field (fast=false) is untouched.
  const stepLen = Math.max(0.7, halfWidthBase * 0.2) * (fast ? 4 : 1);
  const stepCount = Math.max(1, Math.round(totalLength / stepLen));
  // BUG FIX (core dots too sparse to actually touch): raised again — this
  // needs to be dense enough that neighboring core dots' radii overlap and
  // fuse into one continuous solid patch, not just "densely scattered but
  // still individually visible".
  const specksPerStep = Math.max(
    fast ? 2 : 5,
    Math.round(halfWidthBase * 1.15 * (0.6 + density) * (fast ? 0.25 : 1))
  );
  const outerSign = 1;
  // Reach pushed out a bit further than before so the sparse mist genuinely
  // has room to fade out and scatter, instead of stopping right where the
  // old, tighter cluster already thinned to nothing.
  const maxReach = 2.3 * spread;
  // Radial layout is two explicit zones instead of one power curve across
  // the whole reach:
  //  - CORE (out to `coreReachFrac` of maxReach): most specks land here
  //    (`coreShare`), with a near-uniform bias (`coreGamma` ~1) so the
  //    whole core area fills in evenly, and large enough dots (see the
  //    radius calc below) that adjacent ones physically touch and read as
  //    one solid patch rather than a dense-but-separate dot cluster.
  //  - EDGE (from the core boundary out to maxReach): the remaining, far
  //    fewer specks, biased toward the inner edge of this band with
  //    `edgeGamma` so they thin out fast — the loose, individually visible
  //    flecks and light mist a real spray can leaves past its solid center.
  // BUG FIX: widened further (0.55 -> 0.7) and pushed more of the specks
  // into it (0.72 -> 0.82) per request — the solid-reading area needed to
  // cover noticeably more of the stroke's width, not just its dead center.
  const coreReachFrac = 0.7;
  const coreShare = 0.82;
  const coreGamma = 1.05;
  const edgeGamma = 2.5;

  const flecks: Contour[] = [];
  let seedBase = 0;
  for (let i = 0; i <= stepCount; i++) {
    const jitterSeed = i * 17.3 + 4.2;
    const tJitter = pseudoNoise(jitterSeed) * 0.5 * stepLen;
    const t = Math.max(0, Math.min(totalLength, (i / stepCount) * totalLength + tJitter));
    const { p, tangent, taper } = at(t);
    if (taper <= 0.02) continue;
    const tLen = Math.hypot(tangent.x, tangent.y) || 1;
    const tx = tangent.x / tLen;
    const ty = tangent.y / tLen;
    const nx = -ty;
    const ny = tx;
    const halfWidth = halfWidthBase * taper;

    const count = Math.max(1, Math.round(specksPerStep * (0.6 + pseudoNoise(jitterSeed + 71) * 0.4 + 0.4)));
    for (let k = 0; k < count; k++) {
      seedBase += 1;
      const seed = seedBase * 91.7 + i * 3.3 + k * 17;
      const zoneRoll = (pseudoNoise(seed * 1.1 + 55.5) + 1) / 2;
      const inCore = zoneRoll < coreShare;
      const u = (pseudoNoise(seed * 1.7 + 0.31) + 1) / 2;
      const radiusFrac = inCore
        ? Math.pow(u, coreGamma) * coreReachFrac
        : coreReachFrac + Math.pow(u, edgeGamma) * (1 - coreReachFrac);
      const angle = Math.PI * ((pseudoNoise(seed * 2.3 + 8.9) + 1) / 2) * 2;
      const across = Math.cos(angle) * radiusFrac * maxReach * halfWidth;
      const along = Math.sin(angle) * radiusFrac * maxReach * halfWidth * 0.7;
      const center = { x: p.x + nx * across + tx * along, y: p.y + ny * across + ty * along };
      // Core dots stay large and close to full size across the WHOLE core
      // disc (only a mild taper, `1 - radiusFrac * 0.15`) so they overlap
      // into solid coverage rather than fading out toward its own rim;
      // edge dots drop sharply in size the further past the core boundary
      // they land, so the mist genuinely reads as fine and sparse.
      const sizeFrac = inCore
        ? 1 - Math.min(1, radiusFrac / coreReachFrac) * 0.15
        : 0.85 - Math.min(1, (radiusFrac - coreReachFrac) / (1 - coreReachFrac)) * 0.6;
      // BUG FIX: core and edge now draw from separate, much wider-apart
      // radius ranges instead of one shared `0.02–0.08x` band. That shared
      // range was sized for individually-visible edge flecks — fine for
      // the mist, but far too small for core dots to overlap at any
      // reasonable spacing. Core dots now draw from a noticeably bigger
      // range so adjacent ones physically overlap and fuse into a solid
      // patch; edge flecks keep the old small range so they still read as
      // fine, separate specks.
      const radiusRange = inCore ? { base: 0.05, spanRand: 0.11 } : { base: 0.02, spanRand: 0.05 };
      const radius = Math.max(0.35, halfWidthBase * (radiusRange.base + ((pseudoNoise(seed * 1.3 + 9.3) + 1) / 2) * radiusRange.spanRand) * sizeFrac);
      // Same winding on every speck so overlapping dots add solid ink under
      // the nonzero fill rule instead of risking a stray hole. `fast` uses a
      // cheaper 6-sided speckle instead of the full 12-sided one — half the
      // nodes per speck, invisible at live-preview scale/speed.
      flecks.push(makeSpeckle(center, radius, seed, outerSign, fast ? 6 : 12));
    }
  }

  return flecks;
}

/**
 * Outline Brush: a hollow ring cross-section rather than a filled stroke.
 * Builds the same elliptical-nib body every other brush uses for the OUTER
 * boundary, then sweeps a second, narrower copy of the identical centerline
 * for the INNER boundary and reverses its winding so it punches a hole
 * straight through the middle — the same nonzero-fill counter technique
 * Rough Brush uses for its texture holes (see makeRoughHole's doc comment),
 * just following the whole stroke rather than a scatter of small dots. The
 * result is a constant-thickness border with the interior left open, like
 * tracing the stroke's shape with a pen instead of filling it with ink.
 */
function outlineBrushOutlineContours(centerline: StrokeSample[], settings: BrushSettings): Contour[] {
  if (centerline.length < 2) return [];

  // Resample the centerline ONCE, at the outer (full) size, and reuse this
  // exact same dense point/arc-length data for both the outer boundary and
  // the inner hole below (via `precomputed`). Resampling independently per
  // call — previously once at the outer size, then again at the smaller
  // inner size — used a slightly different point spacing each time, so the
  // two boundaries' flat end caps didn't land on quite the same physical
  // point. That's what showed up as a small notch left open at the ring's
  // tip instead of a clean, fully closed seam: sharing one resampling pass
  // anchors both boundaries' ends to the identical stroke endpoint.
  const pts = settings.type === "grunge" ? centerline : catmullRomResample(centerline, Math.max(0.6, settings.size * 0.06));
  if (pts.length < 2) return [];
  const cumulative: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const totalLength = cumulative[cumulative.length - 1] || 1;
  const precomputed = { pts, cumulative, totalLength };

  // Border thickness is a fraction of the nib's own half-width, so it
  // scales naturally with stroke size instead of needing its own unit.
  const thickness = Math.max(0.6, (settings.size / 2) * (settings.outlineThickness ?? 0.32));
  const shrink = thickness * 2;
  const innerSize = settings.size - shrink;

  // BUG FIX (square cap reads thicker than the rest of the ring): the
  // outer boundary's "square" cap plate extended by its own FULL half-width
  // (no override -> capSquare falls back to `cap.semiA/semiB`, i.e.
  // `settings.size / 2`), while the inner hole's cap plate was capped to
  // just `thickness` (see capForwardOverride below). Ring width at a flat
  // tip is (outer extension - inner extension), so that mismatch made the
  // tip's visible border noticeably wider than the constant `thickness`
  // the sides use — e.g. size 40 / outlineThickness 0.32 drew a ~13.6-unit
  // tip against a ~6.4-unit body. Capping BOTH plates' forward reach — not
  // just the inner one — to a shared, bounded pair (`capReach` for the
  // outer plate, `thickness` for the inner one, so their difference is
  // exactly `thickness`) keeps the ring's thickness visually uniform all
  // the way around, including a flat squared-off tip, while still bounding
  // how far either plate can reach past the endpoint (the original reason
  // for capForwardOverride — see its doc comment above) instead of the
  // unbounded full half-width the outer boundary used before.
  const capReach = thickness * 2;

  // Shared simplification tolerance for BOTH boundaries below (see
  // centerlineToOutline's edgeSimplifyEpsilonOverride doc comment): computed
  // once from the OUTER nib size and reused for the inner hole too, instead
  // of each call deriving its own from its own (smaller, for the hole)
  // size. Keeps the two ring edges simplified/refit at matching density so
  // they track a true constant offset — no more width pulsing through
  // curves from the two sides drifting out of sync.
  const sharedEdgeSimplifyEpsilon = Math.max(0.5, Math.min(3, (settings.size / 2) * 0.055));

  // NOTE: "open" cap style used to be built here as two independent side
  // strips (left rail pair, right rail pair) instead of a single ring that's
  // joined shut at both tips. That made a lone stroke's ends look right, but
  // broke the crossing-merge story badly: mergeOutlineBrushStrokes() (see
  // glyph/editor/glyphPaths.ts) cleanly fuses touching/crossing strokes for
  // "square"/"round" by unioning every stroke's OUTER boundary together,
  // unioning every stroke's INNER hole together, then subtracting hole-union
  // from outer-union — which works because each stroke's "outer" is already
  // a full, solid, hole-free shape covering its ENTIRE width, so two
  // crossing strokes' outers fully paper over each other at the join before
  // any hole is cut. Two independent thin rail STRIPS never had that full
  // solid coverage to begin with (each strip only covers a thin sliver near
  // one edge), so unioning them just stacked the raw strips on top of each
  // other with no merging at all — exactly the "lines visibly crossing
  // instead of fusing" bug. Building "open" as a normal outer+inner ring
  // (below, shared with "square"/"round") fixes this: it gets the exact same
  // robust union/subtract crossing behavior, and still reads as a genuinely
  // open, uncapped tip because centerlineToOutline's capMode "none" for
  // "open" (see its doc comment) leaves both boundaries' ends as plain
  // flat, un-extended chords instead of a closed plate/bulge.
  const main = centerlineToOutline(centerline, settings, precomputed, capReach, sharedEdgeSimplifyEpsilon);
  if (!main) return [];
  const outerSign = Math.sign(signedArea(main.nodes.map((n) => n.point))) || 1;

  // Stroke too thin for this border thickness at its narrowest point —
  // there's no room left for a hole, so fall back to solid rather than a
  // degenerate/self-intersecting inner contour.
  if (innerSize < 1.5) return [main];

  const innerSettings: BrushSettings = {
    ...settings,
    size: Math.max(1, innerSize),
  };
  // capForwardOverride = thickness: see centerlineToOutline's capSquare doc
  // comment above — keeps a "square"-capped hole from overshooting into a
  // different, overlapping stroke's ink at a deep join.
  const inner = centerlineToOutline(centerline, innerSettings, precomputed, thickness, sharedEdgeSimplifyEpsilon);
  if (!inner) return [main];

  const innerSign = Math.sign(signedArea(inner.nodes.map((n) => n.point))) || 1;
  const desiredInnerSign = -outerSign;
  // Reversing a smoothed contour also has to exchange each node's incoming
  // and outgoing handles. Reversing only the array leaves the handles
  // attached to the wrong side of the path and can reintroduce angular
  // corners or small folds in Outline Brush's inner counter.
  const innerNodes = innerSign !== desiredInnerSign
    ? [...inner.nodes].reverse().map((node) => ({
        ...node,
        handleIn: node.handleOut,
        handleOut: node.handleIn,
      }))
    : inner.nodes;

  return [main, { ...inner, nodes: innerNodes }];
}

/**
 * Multi-contour outline for a centerline. Pixel Brush forks entirely into
 * `pixelBlockOutline` (isolated behind `settings.gridSnap`), Rough Brush
 * adds counter-holes on top of the standard elliptical-nib body, Outline
 * Brush punches a single hole following the whole stroke, Spray Brush skips
 * the elliptical-nib body entirely for a scattered speck field (see
 * sprayBrushOutlineContours), and every other preset (including Strong
 * Brush, whose torn comb-tooth tips are built as a dedicated end cap inside
 * centerlineToOutline() — see combToothCap) uses the single elliptical-nib
 * contour directly.
 */
export function centerlineToOutlineContours(centerline: StrokeSample[], settings: BrushSettings, opts?: { fast?: boolean }): Contour[] {
  if (settings.type === "pixel" && settings.gridSnap === true) {
    return settings.pixelMode === "liquid"
      ? pixelLiquidOutline(centerline, settings.cellSize ?? settings.size, settings.pixelLiquidSmoothness ?? 0.5, settings)
      : pixelBlockOutline(centerline, settings.cellSize ?? settings.size);
  }
  if (settings.type === "rough") {
    return roughBrushOutlineContours(centerline, settings);
  }
  if (settings.type === "oilBrush") {
    return oilBrushOutlineContours(centerline, settings);
  }
  if (settings.type === "outline") {
    return outlineBrushOutlineContours(centerline, settings);
  }
  if (settings.type === "sprayBrush") {
    return sprayBrushOutlineContours(centerline, settings, opts?.fast ?? false);
  }
  const single = centerlineToOutline(centerline, settings);
  return single ? [single] : [];
}

/** Live/committed brush outline (kept for the immediate preview during drawing). */
export function strokeToContour(rawSamples: StrokeSample[], settings: BrushSettings, hitScale = 1): Contour | null {
  const centerline = samplesToCenterline(rawSamples, settings, hitScale);
  return centerlineToOutline(centerline, settings);
}

/** Fallback used only when a brush object has neither a stored settings
 * snapshot nor a recognized preset id — should be unreachable in practice. */
const FALLBACK_BRUSH_SETTINGS: Omit<BrushSettings, "type"> = {
  size: 20,
  opacity: 1,
  spacing: 4,
  smoothing: 0.4,
  roundness: 1,
  angle: 0,
  taperStart: 0.1,
  taperEnd: 0.1,
  pressureEnabled: true,
  pressureSensitivity: 0.6,
};

/**
 * Brings a possibly-older brush settings snapshot up to the current shape.
 * Pre-"single Size" projects stored a `minSize`/`maxSize` range instead of
 * one `size` + `pressureSensitivity`; this reconstructs an equivalent
 * result from that range so strokes already drawn in older saved files
 * keep rendering exactly as they did before, instead of breaking when
 * those fields are read by code that now only understands `size` +
 * `pressureSensitivity`. Anything already in the current shape passes
 * through untouched.
 */
export function normalizeBrushSettings(raw: (Partial<BrushSettings> & { minSize?: number; maxSize?: number }) | undefined): BrushSettings | undefined {
  if (!raw) return undefined;
  const hasLegacyRange = typeof raw.minSize === "number" && typeof raw.maxSize === "number";
  const legacyMax = hasLegacyRange ? (raw.maxSize as number) : undefined;
  const legacyMin = hasLegacyRange ? (raw.minSize as number) : undefined;
  // The OLD engine's actual rendered max width was always `maxSize`, not
  // the separate `size` field (which only fed spacing/resampling math) —
  // so `size` here must migrate to `maxSize` to look identical, not to
  // whatever `size` happened to hold.
  const size = hasLegacyRange ? (legacyMax as number) : raw.size ?? FALLBACK_BRUSH_SETTINGS.size;
  const migratedSensitivity =
    hasLegacyRange && (legacyMax as number) > 0
      ? Math.max(0, Math.min(1, ((legacyMax as number) - (legacyMin as number)) / (legacyMax as number)))
      : undefined;
  return {
    type: raw.type ?? "round",
    size,
    opacity: raw.opacity ?? FALLBACK_BRUSH_SETTINGS.opacity,
    spacing: raw.spacing ?? FALLBACK_BRUSH_SETTINGS.spacing,
    smoothing: raw.smoothing ?? FALLBACK_BRUSH_SETTINGS.smoothing,
    stabilizer: raw.stabilizer,
    roundness: raw.roundness ?? FALLBACK_BRUSH_SETTINGS.roundness,
    angle: raw.angle ?? FALLBACK_BRUSH_SETTINGS.angle,
    taperStart: raw.taperStart ?? FALLBACK_BRUSH_SETTINGS.taperStart,
    taperEnd: raw.taperEnd ?? FALLBACK_BRUSH_SETTINGS.taperEnd,
    pressureEnabled: raw.pressureEnabled ?? FALLBACK_BRUSH_SETTINGS.pressureEnabled,
    pressureSensitivity: raw.pressureSensitivity ?? migratedSensitivity ?? FALLBACK_BRUSH_SETTINGS.pressureSensitivity,
    sharpStart: raw.sharpStart ?? false,
    sharpEnd: raw.sharpEnd ?? false,
    jitter: raw.jitter,
    holeDensity: raw.holeDensity,
    holeSize: raw.holeSize,
    gridSnap: raw.gridSnap,
    cellSize: raw.cellSize,
    outlineThickness: raw.outlineThickness,
    outlineCapStyle: raw.outlineCapStyle,
    pixelMode: raw.pixelMode,
    pixelLiquidSmoothness: raw.pixelLiquidSmoothness,
  };
}

/**
 * Reconstructs the effective brush settings for a stored brush object from its
 * preset (brushType) scaled to the object's current strokeWidth. This is what
 * lets each preset keep its OWN nib shape / taper / pressure response — the
 * geometry, not just a label — when we (re)build its outline.
 */
export function brushSettingsForObject(obj: VectorObject): BrushSettings {
  if (obj.brushSettings) {
    const base = normalizeBrushSettings(obj.brushSettings) as BrushSettings;
    const k = (obj.strokeWidth ?? base.size) / Math.max(1, base.size);
    return { ...base, size: base.size * k };
  }
  const width = obj.strokeWidth ?? 20;
  const preset = obj.brushType ? BRUSH_PRESETS[obj.brushType as BrushType] : undefined;
  const base = preset ? preset.settings : FALLBACK_BRUSH_SETTINGS;
  return {
    type: (obj.brushType as BrushType) ?? "round",
    ...base,
    size: width,
  };
}

function resamplePressure(n: number, samples?: StrokeSample[]): number[] {
  if (!samples || samples.length === 0) return new Array(n).fill(0.6);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const frac = n <= 1 ? 0 : i / (n - 1);
    out.push(samples[Math.round(frac * (samples.length - 1))].pressure);
  }
  return out;
}

/**
 * The LIVE variable-width outline of a brush object, derived from its CURRENT
 * editable centerline (so it follows node edits) plus its brush profile. The
 * object's stored geometry stays a centerline — this is only for rendering and
 * thumbnails. Different presets => visibly different silhouettes on the same path.
 */
export function brushOutlineContours(obj: VectorObject): Contour[] {
  const settings = brushSettingsForObject(obj);
  const contours: Contour[] = [];
  for (const c of obj.contours) {
    const flattened = flattenContour(c, 10);
    const poly =
      settings.type === "grunge"
        ? flattened
        : simplifyPolyline(flattened, Math.max(0.5, settings.size * 0.025));
    if (poly.length < 2) continue;
    const pressures = resamplePressure(poly.length, obj.samples);
    const centerline: StrokeSample[] = poly.map((p, i) => ({ x: p.x, y: p.y, pressure: pressures[i] }));
    contours.push(...centerlineToOutlineContours(centerline, settings));
  }
  return contours;
}


function normalized(dx: number, dy: number): Point {
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

function arcControl(center: Point, radius: number, a0: number, a1: number) {
  const delta = a1 - a0;
  const k = (4 / 3) * Math.tan(delta / 4);
  const p0 = { x: center.x + Math.cos(a0) * radius, y: center.y + Math.sin(a0) * radius };
  const p1 = { x: center.x + Math.cos(a1) * radius, y: center.y + Math.sin(a1) * radius };
  const t0 = { x: -Math.sin(a0), y: Math.cos(a0) };
  const t1 = { x: -Math.sin(a1), y: Math.cos(a1) };
  return {
    p0,
    p1,
    c1: { x: p0.x + t0.x * radius * k, y: p0.y + t0.y * radius * k },
    c2: { x: p1.x - t1.x * radius * k, y: p1.y - t1.y * radius * k },
  };
}

// Shared corner-join geometry for uniform-width (Pen Line / Monoline Brush)
// expansion, used by both the open-path (`uniformCenterlineToOutline`) and
// closed-loop (`uniformClosedLoopOutline`) offset builders below.
//
// BUG FIX ("editor preview menunjukkan round join, hasil export jadi
// runcing/miring/patah" — every Pen Line / Monoline Brush stroke is created
// and always kept at `join: "round"` — see `useGlyphEditor.ts` and
// `useBrushTool.ts`, and the app never exposes any other join choice — and
// the live editor preview genuinely renders that as a true round join via
// native SVG `stroke-linejoin: round` in `glyphPaths.ts`. But the export
// path's corner handling here only ever built a MITERED spike or a flat
// BEVEL cut at a sharp corner, never an actual round arc, regardless of the
// object's join setting — a plain polygon-join approximation, not the
// constant-width round-joined stroke the editor was already showing. That
// mismatch is exactly why a sharp corner (e.g. the joint of a hand-drawn
// "V"/"L"/corner glyph) could look correct in the editor and come out
// spiked or flattened after export.
//
// A stroke join only needs real rounding on the OUTER (convex) side of a
// turn — the inner (concave) side is just where the two offset edges
// naturally cross, which the existing miter-point formula already computes
// exactly (and `removeSelfIntersectionLoops`/the exact-clipper Remove
// Overlap pass downstream already resolve any inner overlap correctly), so
// that side is left exactly as before. Only the convex side is switched
// from a single spike/bevel point to a densely-sampled true circular arc.
const HARD_JOIN_ANGLE = (25 * Math.PI) / 180;
const MAX_MITER_RATIO = 4; // clamp miter spike length to at most 4x stroke radius

/** Sample points along a true circular arc of radius `r` around `base`,
 * sweeping from the direction of `nA` to the direction of `nB` the short
 * way (their actual turn), at roughly 20° per sample. Downstream bezier
 * fitting (`smoothOffsetPolyline`/`smoothOffsetClosedPolyline`) turns this
 * dense, evenly-spaced point set into a smooth curve that closely matches
 * the true circle — this is what gives a real round join instead of a
 * faceted polygon corner. */
function sampleRoundJoinArc(base: Point, r: number, nA: Point, nB: Point): Point[] {
  const a0 = Math.atan2(nA.y, nA.x);
  const rawA1 = Math.atan2(nB.y, nB.x);
  let delta = rawA1 - a0;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const steps = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI / 9)));
  const out: Point[] = [];
  for (let s = 0; s <= steps; s++) {
    const a = a0 + (delta * s) / steps;
    out.push({ x: base.x + Math.cos(a) * r, y: base.y + Math.sin(a) * r });
  }
  return out;
}

/** The concave (inner) side of a sharp join: the exact intersection point
 * of the two offset edges (a true miter), falling back to a two-point
 * bevel only when the corner is too acute for that spike to stay
 * reasonable. `nSideIn`/`nSideOut` must already be the correctly-signed
 * normals for the side being built (left: +n, right: -n). */
function sidedMiterBevelPoints(base: Point, r: number, nSideIn: Point, nSideOut: Point, turn: number): Point[] {
  const bisector = normalized(nSideIn.x + nSideOut.x, nSideIn.y + nSideOut.y);
  const halfAngle = turn / 2;
  const miterLen = r / Math.max(0.05, Math.cos(halfAngle));
  if (miterLen <= r * MAX_MITER_RATIO) {
    return [{ x: base.x + bisector.x * miterLen, y: base.y + bisector.y * miterLen }];
  }
  return [
    { x: base.x + nSideIn.x * r, y: base.y + nSideIn.y * r },
    { x: base.x + nSideOut.x * r, y: base.y + nSideOut.y * r },
  ];
}

/**
 * Fit smooth Bézier handles through an OPEN offset-edge polyline (one side
 * of a uniform-width stroke), matching the Catmull-Rom-to-Bezier fit already
 * used for the round/marker/etc. brush family in `centerlineToOutline`
 * above (see the `smoothEdges` block there for the full rationale).
 *
 * BUG FIX: `uniformCenterlineToOutline` (Pen Line / Monoline Brush) never
 * had this pass — every offset-edge point was emitted as a hard "corner"
 * node with null handles, so ANY curve drawn with those tools exported as a
 * many-sided straight-edge polygon instead of a smooth outline, even though
 * the same curve rendered smoothly in the live editor. That mismatch is
 * exactly the "smooth in-app, faceted/jagged after export+install" report:
 * on-screen the dense polygon is small enough per-facet to disappear under
 * canvas antialiasing, but an installed font's rasterizer draws those same
 * vertices as visible straight facets, especially at display sizes.
 *
 * The two chain endpoints are intentionally left as hard corners (matching
 * prior behavior) since that's where cap geometry attaches; the caller's
 * cap-handling code already overwrites/extends handles on those endpoint
 * nodes as needed.
 */
function smoothOffsetPolyline(points: Point[]): PathNode[] {
  const n = points.length;
  return points.map((point, i) => {
    if (i === 0 || i === n - 1) {
      return { id: shortId("node"), point, handleIn: null as Point | null, handleOut: null as Point | null, type: "corner" as const };
    }
    const prev = points[i - 1];
    const next = points[i + 1];
    const inLen = Math.hypot(point.x - prev.x, point.y - prev.y) || 1;
    const outLen = Math.hypot(next.x - point.x, next.y - point.y) || 1;
    const inUx = (point.x - prev.x) / inLen;
    const inUy = (point.y - prev.y) / inLen;
    const outUx = (next.x - point.x) / outLen;
    const outUy = (next.y - point.y) / outLen;
    const dot = Math.max(-1, Math.min(1, inUx * outUx + inUy * outUy));
    // Preserve genuine sharp corners; smooth everything gentler than that,
    // same ~100° cusp threshold used for the other brush family.
    if (Math.acos(dot) > (100 * Math.PI) / 180) {
      return { id: shortId("node"), point, handleIn: null as Point | null, handleOut: null as Point | null, type: "corner" as const };
    }
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const dLen = Math.hypot(dx, dy) || 1;
    const ux = dx / dLen;
    const uy = dy / dLen;
    const inHandleLen = Math.min(inLen / 3, inLen * 0.65);
    const outHandleLen = Math.min(outLen / 3, outLen * 0.65);
    return {
      id: shortId("node"),
      point,
      handleIn: { x: point.x - ux * inHandleLen, y: point.y - uy * inHandleLen },
      handleOut: { x: point.x + ux * outHandleLen, y: point.y + uy * outHandleLen },
      type: "smooth" as const,
    };
  });
}

/**
 * Clean uniform-width outline for Pen Line / Monoline brush.
 * Uses the editable centerline geometry, keeps node density bounded, and
 * represents round caps with cubic arcs so the expanded result stays smooth
 * without dozens of cap points.
 *
 * BUG FIX ("cacat"/solid-black closed letterforms — o, e, g, 8, 0, 6, 9,
 * ... — after switching a glyph's objects to Monoline brush): this always
 * built ONE ring — offset one side out, cap around the stroke's start/end,
 * offset the other side back, cap around again — i.e. it unconditionally
 * treated every centerline as an OPEN path with two ends that need capping.
 * That's correct for an actual open stroke (a stem, a crossbar, ...), but a
 * letterform whose stroke is a genuinely CLOSED loop — traced all the way
 * back to its own start, `contour.closed === true`, e.g. the bowl of an
 * "o"/"e"/"g", or a digit like "0"/"8" — has no real start/end to cap at
 * all. Capping it anyway welds the outer and inner offset edges together
 * right at that arbitrary seam point instead of leaving them as two
 * separate boundaries, so the "hole" only ever existed as a razor-thin
 * pinch at the seam — exactly the self-intersecting topology the exact
 * clipper then resolves unreliably (see the doc comments on
 * `multiPolygonToContours`/`objectToMultiPolygon` in editor/booleanOps.ts),
 * commonly collapsing the whole counter away into solid ink. Confirmed
 * directly against exported OTFs: glyphs built from an explicitly closed
 * source contour ("0", "8", "e", "g", ...) came back as a single solid
 * contour with their counter gone, while glyphs whose counter was its own
 * separate (already non-self-intersecting) contour — e.g. "d" — kept it.
 *
 * Fix: when the source centerline is closed — OR when it's technically
 * "open" but its own two ends would physically touch once capped, see
 * `strokeEndsPhysicallyOverlap` below for why that case needs the same
 * treatment — skip capping entirely and return the LEFT and RIGHT offset
 * curves as two independent closed rings (an outer boundary and an inner
 * hole boundary) instead of one welded ring — see `uniformClosedLoopOutline`
 * below. Which one ends up "outer" vs "inner", and their final relative
 * winding, doesn't need to be worked out here: `objectToMultiPolygon`'s
 * even-odd XOR of an object's own contours (the same rule that already
 * correctly resolves a hand-drawn outer+hole pair — see "d" above) sorts
 * that out downstream.
 */
/**
 * Local, physical test for "would this open stroke's own two ends actually
 * touch once capped" — i.e. does the ink overlap at the gap, the way it
 * would with a real pen/brush — rather than a global guess about whether
 * the overall shape "looks like a loop".
 *
 * BUG FIX ("lubang jadi tertutup" — holes closing up on export): an earlier
 * version of this fix compared the gap to the shape's overall bounding
 * diagonal (e.g. "gap is under 12% of how big the letter is"). That is
 * exactly what broke "C": a deliberately narrow-but-real aperture on a
 * fairly round letterform can easily be under 12% of its own diagonal, so
 * that version welded "C" shut into an "O". A stroke's end caps are each
 * `r` (half the stroke width) wide — physically, the ink from both ends
 * can only actually meet or overlap when the gap between the two endpoints
 * is smaller than roughly `2r`. That is a fact about the stroke itself, not
 * about the letter it happens to be part of, so it can't be fooled by a
 * big vs. small letterform the way a diagonal-relative test can: a real,
 * legible open aperture is — by definition of being visible at all — wider
 * than the ink around it, so this never fires for one. It only fires for
 * the case that actually needs a fix: a hand-drawn bowl whose pen-up point
 * landed within its own stroke width of its pen-down point.
 */
function strokeEndsPhysicallyOverlap(pts: Point[], r: number): boolean {
  if (pts.length < 4) return false;

  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  // Guard against a tiny dot/jab — require the stroke to actually have
  // travelled a real distance, several times its own width, before its
  // ends closing up means anything.
  if (length < r * 4) return false;

  const first = pts[0];
  const last = pts[pts.length - 1];
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  return gap < r * 1.9;
}

export function uniformCenterlineToOutline(contour: Contour, width: number, cap: StrokeCap): Contour[] {
  const flattened = flattenContour(contour, 8);
  if (flattened.length < 2) return [];
  const pts = simplifyPolyline(flattened, Math.max(0.5, width * 0.025));
  if (pts.length < 2) return [];

  const r = Math.max(0.5, width / 2);

  if (contour.closed || strokeEndsPhysicallyOverlap(pts, r)) {
    // A near-touching pair of ends is only ever APPROXIMATELY coincident —
    // never pixel-exact the way an explicitly closed contour already is.
    // Snap the end back onto the start before building the two offset
    // rings so the loop closes on a single shared point instead of leaving
    // a near-miss gap of its own, which would just reintroduce the same
    // kind of degenerate seam this fix exists to get rid of.
    const loopPts = contour.closed ? pts : [...pts.slice(0, -1), { ...pts[pts.length - 1], x: pts[0].x, y: pts[0].y }];
    return uniformClosedLoopOutline(loopPts, r);
  }

  const tangents = pts.map((p, i) => {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    return normalized(next.x - prev.x, next.y - prev.y);
  });

  // BUG FIX ("hasil expand ada notch/loncatan di sudut tajam" — a visible
  // notch/step right at a hard corner of a Pen Line / Monoline Brush stroke,
  // e.g. the stem/foot corner of "L"): every interior vertex used to be
  // offset along a SINGLE averaged tangent (`next - prev`, blended across
  // both flanking segments) with no actual corner-join geometry. On a
  // smooth curve that average is a fine approximation of the local tangent,
  // but at a genuinely sharp vertex it is neither a correct miter nor a
  // bevel: on the convex (outer) side it UNDERSHOOTS, slicing a flat notch
  // across what should be a clean point; on the concave (inner) side the
  // two segments' true offset lines cross somewhere else entirely, so the
  // shape only looked right because `removeSelfIntersectionLoops` (a
  // generic forward-window crossing cleanup, not a real join) happened to
  // patch over it — and can leave a stray/misplaced vertex exactly at the
  // joint when the geometry doesn't fit its assumptions. That single wrong
  // vertex is what reads as "hasil jauh dari sebelum expand" right at a
  // node.
  //
  // Fix: compute each segment's OWN normal, and at any interior vertex
  // whose turn angle is sharp enough to matter, emit a proper join instead
  // of one averaged point.
  //
  // FOLLOW-UP FIX ("editor round join vs export miter/bevel mismatch" — see
  // `sampleRoundJoinArc`/`sidedMiterBevelPoints` doc comment above): every
  // Pen Line / Monoline Brush object is always created and kept at
  // `join: "round"`, and the live editor already renders that as a true
  // round join via native SVG stroking — so the export side must match:
  // the OUTER (convex) side of a sharp corner now gets a real circular arc
  // instead of a miter spike or flat bevel; the INNER (concave) side, which
  // has no visible "roundness" to show either way, keeps the exact
  // miter-intersection point (falling back to a bevel only when that spike
  // would be unreasonably long). Gentle bends keep the previous
  // single-point-per-side averaged offset, which is already correct there
  // and keeps node count low.
  const segNormals: Point[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const t = normalized(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segNormals.push({ x: -t.y, y: t.x });
  }

  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    let base = pts[i];
    if (cap === "square") {
      const t = tangents[i];
      if (i === 0) base = { x: base.x - t.x * r, y: base.y - t.y * r };
      if (i === pts.length - 1) base = { x: base.x + t.x * r, y: base.y + t.y * r };
    }

    if (i === 0) {
      const n = segNormals[0];
      left.push({ x: base.x + n.x * r, y: base.y + n.y * r });
      right.push({ x: base.x - n.x * r, y: base.y - n.y * r });
      continue;
    }
    if (i === pts.length - 1) {
      const n = segNormals[segNormals.length - 1];
      left.push({ x: base.x + n.x * r, y: base.y + n.y * r });
      right.push({ x: base.x - n.x * r, y: base.y - n.y * r });
      continue;
    }

    const nIn = segNormals[i - 1];
    const nOut = segNormals[i];
    const dot = Math.max(-1, Math.min(1, nIn.x * nOut.x + nIn.y * nOut.y));
    const turn = Math.acos(dot);

    if (turn <= HARD_JOIN_ANGLE) {
      // Gentle bend: previous behavior — single averaged normal.
      const n = normalized(nIn.x + nOut.x, nIn.y + nOut.y);
      left.push({ x: base.x + n.x * r, y: base.y + n.y * r });
      right.push({ x: base.x - n.x * r, y: base.y - n.y * r });
      continue;
    }

    // Sharp corner: round join on the convex (outer) side, true miter
    // (clamped to a bevel fallback) on the concave (inner) side. Which side
    // is convex flips with the turn direction — a CCW (left) turn's outer
    // side is the right (-n) offset, and vice versa.
    const crossN = nIn.x * nOut.y - nIn.y * nOut.x;
    const leftIsConvex = crossN < 0;
    const nInR = { x: -nIn.x, y: -nIn.y };
    const nOutR = { x: -nOut.x, y: -nOut.y };

    if (leftIsConvex) {
      right.push(...sidedMiterBevelPoints(base, r, nInR, nOutR, turn));
      left.push(...sampleRoundJoinArc(base, r, nIn, nOut));
    } else {
      left.push(...sidedMiterBevelPoints(base, r, nIn, nOut, turn));
      right.push(...sampleRoundJoinArc(base, r, nInR, nOutR));
    }
  }

  // BUG FIX: unlike `centerlineToOutline` (the round/marker/etc. brush
  // family), this function never cleaned up self-intersection loops on its
  // offset edges. Wherever the stroke's half-width is larger than the local
  // curve radius — a tight bend, or two strokes/segments crossing close
  // together (e.g. a diagonal accent crossing a stem) — the offset edge
  // pinches into a small loop instead of staying a simple curve. Filled
  // with nonzero/evenodd winding, that pinched loop becomes an unwanted
  // hole (shows as a transparent/checkerboard cutout) instead of solid
  // ink. Same fix as centerlineToOutline: collapse those loops before
  // building nodes from the edge.
  const cleanedLeft = removeSelfIntersectionLoops(left);
  const cleanedRight = removeSelfIntersectionLoops(right);

  const leftNodes = smoothOffsetPolyline(cleanedLeft);
  const rightNodes = smoothOffsetPolyline(cleanedRight);
  const nodes: PathNode[] = [...leftNodes];

  if (cap === "round") {
    const end = pts[pts.length - 1];
    const theta = Math.atan2(tangents[tangents.length - 1].y, tangents[tangents.length - 1].x);
    const a = arcControl(end, r, theta + Math.PI / 2, theta);
    const b = arcControl(end, r, theta, theta - Math.PI / 2);
    const leftEnd = nodes[nodes.length - 1];
    leftEnd.handleOut = a.c1;
    const mid = { id: shortId("node"), point: a.p1, handleIn: a.c2, handleOut: b.c1, type: "smooth" as const };
    nodes.push(mid);
    const rightEnd = {
      id: shortId("node"), point: b.p1, handleIn: b.c2, handleOut: null as Point | null, type: "smooth" as const,
    };
    nodes.push(rightEnd);
  } else {
    nodes.push(rightNodes[rightNodes.length - 1]);
  }

  // BUG FIX: this used to loop against `right.length` (the pre-cleanup
  // array). Once `removeSelfIntersectionLoops` can change the point count,
  // that stale bound either walked off the end of `rightNodes` or skipped
  // its last real point. Loop against `rightNodes.length` instead.
  for (let i = rightNodes.length - 2; i >= 0; i--) {
    nodes.push(rightNodes[i]);
  }

  if (cap === "round") {
    const start = pts[0];
    const theta = Math.atan2(tangents[0].y, tangents[0].x);
    const a = arcControl(start, r, theta - Math.PI / 2, theta - Math.PI);
    const b = arcControl(start, r, theta - Math.PI, theta - (3 * Math.PI) / 2);
    const rightStart = nodes[nodes.length - 1];
    rightStart.handleOut = a.c1;
    const mid = { id: shortId("node"), point: a.p1, handleIn: a.c2, handleOut: b.c1, type: "smooth" as const };
    nodes.push(mid);
    // The closing segment lands on left[0]; give that first node the incoming
    // Bézier handle so the cap joins with no tiny fill seam/gap.
    nodes[0].handleIn = b.c2;
    nodes[0].type = "smooth";
  }

  return [{ id: shortId("contour"), closed: true, nodes }];
}

// Same self-intersection cleanup `removeSelfIntersectionLoops` already does
// for an open stroke edge, but for a ring: that function only scans
// forward through the array, so a fold sitting right across the array's
// arbitrary start/end point (very likely here — flattening always starts
// at the source contour's own node 0, which has no special geometric
// meaning on a closed loop) would never be seen. Running a second pass
// after rotating the ring by half moves any such seam-straddling fold into
// the middle of the array, where the same forward scan finds it like any
// other. Where the ring starts afterward doesn't matter — it's a closed
// ring either way.
function cleanClosedOffsetRing(ring: Point[]): Point[] {
  if (ring.length < 4) return ring;
  const pass1 = removeSelfIntersectionLoops(ring);
  if (pass1.length < 4) return pass1;
  const half = Math.floor(pass1.length / 2);
  const rotated = [...pass1.slice(half), ...pass1.slice(0, half)];
  return removeSelfIntersectionLoops(rotated);
}

// Same tangent/corner-vs-smooth handle fit as `smoothOffsetPolyline`, but
// wrapping every point's neighbors around the ring instead of forcing
// index 0 and the last index to be plain corners — there's no start/end
// on a closed loop, every point gets the same treatment.
function smoothOffsetClosedPolyline(points: Point[]): PathNode[] {
  const n = points.length;
  return points.map((point, i) => {
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const inLen = Math.hypot(point.x - prev.x, point.y - prev.y) || 1;
    const outLen = Math.hypot(next.x - point.x, next.y - point.y) || 1;
    const inUx = (point.x - prev.x) / inLen;
    const inUy = (point.y - prev.y) / inLen;
    const outUx = (next.x - point.x) / outLen;
    const outUy = (next.y - point.y) / outLen;
    const dot = Math.max(-1, Math.min(1, inUx * outUx + inUy * outUy));
    if (Math.acos(dot) > (100 * Math.PI) / 180) {
      return { id: shortId("node"), point, handleIn: null as Point | null, handleOut: null as Point | null, type: "corner" as const };
    }
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const dLen = Math.hypot(dx, dy) || 1;
    const ux = dx / dLen;
    const uy = dy / dLen;
    const inHandleLen = Math.min(inLen / 3, inLen * 0.65);
    const outHandleLen = Math.min(outLen / 3, outLen * 0.65);
    return {
      id: shortId("node"),
      point,
      handleIn: { x: point.x - ux * inHandleLen, y: point.y - uy * inHandleLen },
      handleOut: { x: point.x + ux * outHandleLen, y: point.y + uy * outHandleLen },
      type: "smooth" as const,
    };
  });
}

/**
 * Builds the two independent offset rings (outer boundary + inner hole
 * boundary) for a CLOSED monoline centerline — see the BUG FIX doc comment
 * on `uniformCenterlineToOutline` above for why a closed loop needs this
 * instead of the capped single-ring path.
 */
function uniformClosedLoopOutline(loopPts: Point[], r: number): Contour[] {
  // `loopPts` comes from flattening a closed source contour, so its last
  // sample lands back on (approximately) its first — drop that duplicate
  // so the wrap-around tangent below uses the true neighboring point
  // instead of a zero-length step onto itself.
  const ring = [...loopPts];
  if (ring.length > 2) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) ring.pop();
  }
  const n = ring.length;
  if (n < 3) return [];

  // BUG FIX ("notch di sudut tajam pada closed loop" — the same sharp-corner
  // notch/spike bug already found and fixed for OPEN Pen Line / Monoline
  // strokes in `uniformCenterlineToOutline` above also applies here: this
  // used a single per-point tangent averaged across both flanking segments,
  // with no real join geometry at all. A closed loop with a genuinely sharp
  // vertex — a hand-drawn closed shape with a hard corner, not just smooth
  // bowls like "o"/"e" — got the same undershooting flat notch on its outer
  // side. Fixed the same way: per-segment normals, a hard-corner threshold,
  // and a true round join on the convex side (matching every Pen Line /
  // Monoline Brush object's `join: "round"` setting and what the editor's
  // native SVG stroke preview already shows) with the exact miter
  // intersection (clamped to a bevel) on the concave side.
  const segNormals: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const t = normalized(b.x - a.x, b.y - a.y);
    segNormals.push({ x: -t.y, y: t.x });
  }

  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < n; i++) {
    const base = ring[i];
    const nIn = segNormals[(i - 1 + n) % n];
    const nOut = segNormals[i];
    const dot = Math.max(-1, Math.min(1, nIn.x * nOut.x + nIn.y * nOut.y));
    const turn = Math.acos(dot);

    if (turn <= HARD_JOIN_ANGLE) {
      const nrm = normalized(nIn.x + nOut.x, nIn.y + nOut.y);
      left.push({ x: base.x + nrm.x * r, y: base.y + nrm.y * r });
      right.push({ x: base.x - nrm.x * r, y: base.y - nrm.y * r });
      continue;
    }

    const crossN = nIn.x * nOut.y - nIn.y * nOut.x;
    const leftIsConvex = crossN < 0;
    const nInR = { x: -nIn.x, y: -nIn.y };
    const nOutR = { x: -nOut.x, y: -nOut.y };

    if (leftIsConvex) {
      right.push(...sidedMiterBevelPoints(base, r, nInR, nOutR, turn));
      left.push(...sampleRoundJoinArc(base, r, nIn, nOut));
    } else {
      left.push(...sidedMiterBevelPoints(base, r, nIn, nOut, turn));
      right.push(...sampleRoundJoinArc(base, r, nInR, nOutR));
    }
  }

  const cleanedLeft = cleanClosedOffsetRing(left);
  const cleanedRight = cleanClosedOffsetRing(right);

  // BUG FIX ("kontur luar dan lubang muter ke arah yang sama" — outer and
  // hole ring wound the same direction, e.g. CCW-CCW, instead of opposite):
  // `left` and `right` above are both walked in the SAME index order as the
  // source loop (`for i in 0..n`), so regardless of which one physically
  // ends up being the outer boundary vs. the inner hole, they always come
  // out with the SAME signed-area sign as each other — offsetting to the
  // other side of the centerline doesn't reverse traversal direction. A
  // rasterizer's nonzero fill rule (what the OTF/TTF writers ultimately
  // target — see `normalizeObjectContourDirections` in utils/fontIO.ts)
  // needs a hole's winding to be OPPOSITE its outer boundary's winding to
  // read as a hole rather than more ink. Test Lab's own preview never
  // caught this because it renders objects as SVG `evenodd`, which resolves
  // holes correctly regardless of relative winding direction — so the shape
  // looked right in-app while exporting wrong. And downstream
  // `normalizeObjectContourDirections` only performs ONE uniform flip of
  // every contour in an object together (to match the target sfnt
  // convention) — it can't fix a same-sign outer/inner pair authored here,
  // since flipping both together preserves their (wrong) relative winding.
  // Fix it at the source: whichever ring encloses the larger area is the
  // outer boundary; if the smaller (hole) ring's winding sign matches it,
  // reverse the hole ring's point order so the two are always opposite.
  if (cleanedLeft.length >= 3 && cleanedRight.length >= 3) {
    const leftArea = signedArea(cleanedLeft);
    const rightArea = signedArea(cleanedRight);
    const holePts = Math.abs(leftArea) >= Math.abs(rightArea) ? cleanedRight : cleanedLeft;
    const outerSign = Math.sign(Math.abs(leftArea) >= Math.abs(rightArea) ? leftArea : rightArea) || 1;
    const holeSign = Math.sign(Math.abs(leftArea) >= Math.abs(rightArea) ? rightArea : leftArea) || 1;
    if (outerSign === holeSign) holePts.reverse();
  }

  const outlines: Contour[] = [];
  if (cleanedLeft.length >= 3) {
    outlines.push({ id: shortId("contour"), closed: true, nodes: smoothOffsetClosedPolyline(cleanedLeft) });
  }
  if (cleanedRight.length >= 3) {
    outlines.push({ id: shortId("contour"), closed: true, nodes: smoothOffsetClosedPolyline(cleanedRight) });
  }
  return outlines;
}

/**
 * "Expand Stroke": convert a centerline stroke object (line or brush) into a
 * closed, filled "expanded" object. Non-destructive source stays editable
 * until this is invoked.
 */
export function expandStrokeObject(obj: VectorObject): VectorObject | null {
  const width = obj.strokeWidth ?? 20;

  // Uniform centerlines (Pen Line + Monoline Brush) expand from the CURRENT
  // centerline, so node edits, width and cap appearance are all preserved.
  if (obj.kind === "line" || (obj.kind === "brush" && obj.brushType === "monoline")) {
    const raw = obj.contours.flatMap((c) => uniformCenterlineToOutline(c, width, obj.cap ?? "round"));
    if (raw.length === 0) return null;

    // BUG FIX ("hasil expand berantakan/ngaco" — Expand Stroke output
    // scrambled into a self-crossing "bowtie" tangle instead of matching
    // the stroke exactly, specific to Monoline/Pen Line and worst on
    // closed-loop letterforms like "g", "e", "8"): `uniformClosedLoopOutline`
    // above only cleans up self-intersections with a small forward-looking
    // WINDOW (48 points) via `removeSelfIntersectionLoops`, plus one extra
    // pass after rotating the ring halfway to catch a fold sitting across
    // the array's arbitrary start/end seam. Both passes only ever find
    // crossings between points that are close together in the array. A
    // letterform like the bowl+tail of a "g" naturally brings two points
    // that are FAR apart along the traced path physically close together
    // (the neck where the tail curls back near the bowl) — exactly the case
    // neither local pass can see, so a real self-intersection was silently
    // left in the offset ring. Filled with nonzero/evenodd winding, that
    // leftover crossing is what read as the tangled, wrong-shaped mess: the
    // ring effectively folds part of itself inside-out instead of tracing a
    // simple loop matching the original stroke.
    //
    // This is exactly the same class of bug `normalizeSelfIntersectingContours`
    // (booleanOps.ts) already exists to fix for a single hand-drawn Outline
    // Brush stroke that crosses itself near a "g"/"e" neck — see its doc
    // comment. Unlike the local point-removal heuristic above, it resolves
    // self-crossings through the exact polygon clipper (a real nonzero
    // union/XOR), which has no "how far apart in the array" limitation at
    // all and always returns a valid, simple set of contours. Routing every
    // Monoline/Pen Line expand result through it — the outer boundary and
    // inner hole ring together — guarantees the exported shape is exactly
    // the filled silhouette of the current stroke, on any geometry, matching
    // how the other brush presets' Expand already comes out clean below.
    const contours = normalizeSelfIntersectingContours(raw);
    return contours.length ? { id: shortId("obj"), kind: "expanded", contours } : null;
  }

  if (obj.kind === "brush") {
    // Variable-profile brushes also expand from their current editable
    // centerline. brushOutlineContours resamples captured pressure onto the
    // edited path, avoiding the old "snap back to raw samples" behavior.
    const raw = brushOutlineContours(obj);
    if (raw.length === 0) return null;
    // Same fix as above, applied for consistency: a freehand gesture with
    // any other preset can trace the same close-neck geometry (a "g" drawn
    // with Round/Marker/etc.), so it deserves the same guarantee of a
    // clean, non-self-intersecting expanded result. (normalizeSelfIntersectingContours
    // itself falls back to the raw contours if the clip step ever comes back empty.)
    const contours = normalizeSelfIntersectingContours(raw);
    return { id: shortId("obj"), kind: "expanded", contours };
  }

  return null;
}
