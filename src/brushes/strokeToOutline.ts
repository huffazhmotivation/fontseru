import type { Contour, PathNode, Point, VectorObject, StrokeCap, StrokeSample } from "@/types/geometry";
import type { BrushSettings, BrushType } from "@/types/brush";
import { shortId } from "@/utils/id";
import { simplifyPolyline } from "@/utils/simplify";
import { BRUSH_PRESETS } from "./presets";
import { flattenContour } from "@/editor/objectOps";

function movingAverage(samples: StrokeSample[], windowRadius: number): StrokeSample[] {
  if (windowRadius <= 0) return samples;
  const out: StrokeSample[] = [];
  for (let i = 0; i < samples.length; i++) {
    let sx = 0, sy = 0, sp = 0, n = 0;
    for (let j = Math.max(0, i - windowRadius); j <= Math.min(samples.length - 1, i + windowRadius); j++) {
      sx += samples[j].x; sy += samples[j].y; sp += samples[j].pressure; n++;
    }
    out.push({ x: sx / n, y: sy / n, pressure: sp / n });
  }
  return out;
}

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

function taperFactor(s: number, taperStart: number, taperEnd: number): number {
  let f = 1;
  if (taperStart > 0 && s < taperStart) {
    const t = s / taperStart;
    f = Math.min(f, t * t * (3 - 2 * t));
  }
  if (taperEnd > 0 && s > 1 - taperEnd) {
    const t = (1 - s) / taperEnd;
    f = Math.min(f, t * t * (3 - 2 * t));
  }
  return Math.max(0.08, f);
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
 */
const HARD_CORNER_ANGLE = (55 * Math.PI) / 180;

export function catmullRomResample(points: StrokeSample[], spacing: number): StrokeSample[] {
  if (points.length < 3 || spacing <= 0) return points;

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

/** Clean, simplified centerline (font units) from raw samples. */
export function samplesToCenterline(rawSamples: StrokeSample[], settings: BrushSettings): StrokeSample[] {
  if (rawSamples.length < 2) return rawSamples;
  const windowRadius = Math.round(settings.smoothing * 6);
  let smoothed = movingAverage(rawSamples, windowRadius);
  // Grunge needs dense edge events all along the stroke; simplifying a
  // straight gesture down to two endpoints would erase the jagged profile.
  if (settings.type === "grunge") return smoothed;
  // A second, lighter pass approximates a Gaussian kernel far better than a
  // single box-average pass alone — it noticeably rounds out curved
  // gestures (fewer visible facets through bends) without flattening
  // intentional corners, since simplifyPolyline below still preserves
  // sharp turns regardless of how much this smooths the curve itself.
  if (windowRadius > 0) {
    smoothed = movingAverage(smoothed, Math.max(1, Math.round(windowRadius * 0.6)));
  }
  const epsilon = Math.max(0.4, settings.size * 0.03);
  return simplifyPolyline(smoothed, epsilon);
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
  autoSmooth = true
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

  const unit = (dx: number, dy: number) => {
    const d = Math.hypot(dx, dy) || 1;
    return { x: dx / d, y: dy / d };
  };
  const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

  // Freehand gestures are biased toward smoothness: even a fairly strong
  // bend should remain a smooth node. Only very sharp cusp-like changes stay
  // corners so the brush never turns a deliberate point into a loop/overshoot.
  const maxSmoothTurn = (120 * Math.PI) / 180;
  const smoothFlags = new Array(points.length).fill(false);

  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const u0 = unit(b.x - a.x, b.y - a.y);
    const u1 = unit(c.x - b.x, c.y - b.y);
    const dot = Math.max(-1, Math.min(1, u0.x * u1.x + u0.y * u1.y));
    const turn = Math.acos(dot);
    smoothFlags[i] = turn <= maxSmoothTurn;
  }

  // Give endpoints a one-sided smooth handle when the adjacent section is
  // smooth. This avoids a visibly straight first/last segment on a curved
  // freehand stroke without pretending the endpoint has two equal handles.
  smoothFlags[0] = smoothFlags[1] ?? false;
  smoothFlags[points.length - 1] = smoothFlags[points.length - 2] ?? false;

  for (let i = 0; i < points.length; i++) {
    if (!smoothFlags[i]) continue;
    const prev = points[Math.max(0, i - 1)];
    const cur = points[i];
    const next = points[Math.min(points.length - 1, i + 1)];

    let tangent: Point;
    if (i === 0) tangent = unit(next.x - cur.x, next.y - cur.y);
    else if (i === points.length - 1) tangent = unit(cur.x - prev.x, cur.y - prev.y);
    else tangent = unit(next.x - prev.x, next.y - prev.y);

    // Independent incoming/outgoing lengths are deliberate: this is a
    // `smooth` node, not a `symmetric` node. The 0.30 factor keeps the fitted
    // curve close to the user's gesture and avoids overshoot on dense samples.
    const inLen = i > 0 ? Math.max(0.5, dist(prev, cur) * 0.30) : 0;
    const outLen = i < points.length - 1 ? Math.max(0.5, dist(cur, next) * 0.30) : 0;

    nodes[i].type = "smooth";
    if (inLen > 0) {
      nodes[i].handleIn = { x: cur.x - tangent.x * inLen, y: cur.y - tangent.y * inLen };
    }
    if (outLen > 0) {
      nodes[i].handleOut = { x: cur.x + tangent.x * outLen, y: cur.y + tangent.y * outLen };
    }
  }

  return { id: shortId("contour"), closed: false, nodes };
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
  precomputed?: { pts: StrokeSample[]; cumulative: number[]; totalLength: number }
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
  const capMode: "round" | "comb" | "none" = ROUND_CAP_TYPES.includes(settings.type)
    ? "round"
    : COMB_CAP_TYPES.includes(settings.type)
      ? "comb"
      : "none";
  let startCap: { center: Point; tangentAngle: number; semiA: number; semiB: number } | null = null;
  let endCap: { center: Point; tangentAngle: number; semiA: number; semiB: number } | null = null;

  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const tangent = { x: next.x - prev.x, y: next.y - prev.y };
    const tLen = Math.hypot(tangent.x, tangent.y) || 1;
    const normal = { x: -tangent.y / tLen, y: tangent.x / tLen };
    const normalAngle = Math.atan2(normal.y, normal.x);

    const pressure = settings.pressureEnabled ? pts[i].pressure : 1;
    const widthFromPressure = settings.minSize + (settings.maxSize - settings.minSize) * pressure;
    const s = cumulative[i] / totalLength;
    const taper = taperFactor(s, settings.taperStart, settings.taperEnd);
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
      const mag = Math.max(Math.hypot(vx, vy) * factor, semiMajor * 0.12);
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
      const minMag = semiMajor * 0.12;
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
  const endCapPts = endCap
    ? capMode === "comb"
      // Teeth point straight OUT along the direction of travel (the stroke
      // is heading this way and keeps going past the tip).
      ? combToothCap(endCap, endCap.tangentAngle + Math.PI / 2, endCap.tangentAngle, nibAngleRad, 11.3)
      : capArc(endCap, endCap.tangentAngle + Math.PI / 2)
    : [];
  const startCapPts = startCap
    ? capMode === "comb"
      // Teeth point straight BACK, opposite the direction of travel (the
      // stroke starts here and heads forward, so the tip trails behind).
      ? combToothCap(startCap, startCap.tangentAngle - Math.PI / 2, startCap.tangentAngle + Math.PI, nibAngleRad, 83.1)
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

  const polygon = [...cleanedLeft, ...endCapPts, ...cleanedRight.reverse(), ...startCapPts];
  if (polygon.length < 3) return null;
  return {
    id: shortId("contour"),
    closed: true,
    nodes: polygon.map((p) => ({ id: shortId("node"), point: p, handleIn: null, handleOut: null, type: "corner" as const })),
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
function makeSpeckle(center: Point, radius: number, seed: number, desiredSign: number): Contour {
  const sides = 6;
  const raw: Point[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const wobble = 1 + pseudoNoise(seed + i * 4.3) * 0.4;
    raw.push({ x: center.x + Math.cos(a) * radius * wobble, y: center.y + Math.sin(a) * radius * wobble });
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
    const taper = taperFactor(s, settings.taperStart, settings.taperEnd);
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
    return { p, tangent, taper: taperFactor(s, settings.taperStart, settings.taperEnd) };
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

  const main = centerlineToOutline(centerline, settings, precomputed);
  if (!main) return [];
  const outerSign = Math.sign(signedArea(main.nodes.map((n) => n.point))) || 1;

  // Border thickness is a fraction of the nib's own half-width, so it
  // scales naturally with stroke size instead of needing its own unit.
  const thickness = Math.max(0.6, (settings.size / 2) * (settings.outlineThickness ?? 0.32));
  const shrink = thickness * 2;
  const innerSize = settings.size - shrink;
  const innerMin = settings.minSize - shrink;
  const innerMax = settings.maxSize - shrink;
  // Stroke too thin for this border thickness at its narrowest point —
  // there's no room left for a hole, so fall back to solid rather than a
  // degenerate/self-intersecting inner contour.
  if (innerSize < 1.5 || innerMax < 1.5) return [main];

  const innerSettings: BrushSettings = {
    ...settings,
    size: Math.max(1, innerSize),
    minSize: Math.max(0.5, innerMin),
    maxSize: Math.max(0.5, innerMax),
  };
  const inner = centerlineToOutline(centerline, innerSettings, precomputed);
  if (!inner) return [main];

  const innerSign = Math.sign(signedArea(inner.nodes.map((n) => n.point))) || 1;
  const desiredInnerSign = -outerSign;
  const innerNodes = innerSign !== desiredInnerSign ? [...inner.nodes].reverse() : inner.nodes;

  return [main, { ...inner, nodes: innerNodes }];
}

/**
 * Multi-contour outline for a centerline. Pixel Brush forks entirely into
 * `pixelBlockOutline` (isolated behind `settings.gridSnap`), Rough Brush
 * adds counter-holes on top of the standard elliptical-nib body, Outline
 * Brush punches a single hole following the whole stroke, and every other
 * preset (including Strong Brush, whose torn comb-tooth tips are built as
 * a dedicated end cap inside centerlineToOutline() — see combToothCap)
 * uses the single elliptical-nib contour directly.
 */
export function centerlineToOutlineContours(centerline: StrokeSample[], settings: BrushSettings): Contour[] {
  if (settings.type === "pixel" && settings.gridSnap === true) {
    return pixelBlockOutline(centerline, settings.cellSize ?? settings.size);
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
  const single = centerlineToOutline(centerline, settings);
  return single ? [single] : [];
}

/** Live/committed brush outline (kept for the immediate preview during drawing). */
export function strokeToContour(rawSamples: StrokeSample[], settings: BrushSettings): Contour | null {
  const centerline = samplesToCenterline(rawSamples, settings);
  return centerlineToOutline(centerline, settings);
}

/**
 * Reconstructs the effective brush settings for a stored brush object from its
 * preset (brushType) scaled to the object's current strokeWidth. This is what
 * lets each preset keep its OWN nib shape / taper / pressure response — the
 * geometry, not just a label — when we (re)build its outline.
 */
export function brushSettingsForObject(obj: VectorObject): BrushSettings {
  if (obj.brushSettings) {
    const base = obj.brushSettings;
    const k = (obj.strokeWidth ?? base.size) / Math.max(1, base.size);
    return { ...base, size: base.size * k, minSize: base.minSize * k, maxSize: base.maxSize * k };
  }
  const width = obj.strokeWidth ?? 20;
  const preset = obj.brushType ? BRUSH_PRESETS[obj.brushType as BrushType] : undefined;
  const base = preset
    ? preset.settings
    : { size: 20, minSize: 12, maxSize: 20, opacity: 1, spacing: 4, smoothing: 0.4, roundness: 1, angle: 0, taperStart: 0.1, taperEnd: 0.1, pressureEnabled: true };
  const k = width / Math.max(1, base.size);
  return {
    type: (obj.brushType as BrushType) ?? "round",
    ...base,
    size: width,
    minSize: base.minSize * k,
    maxSize: base.maxSize * k,
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

/**
 * Clean uniform-width outline for Pen Line / Monoline brush.
 * Uses the editable centerline geometry, keeps node density bounded, and
 * represents round caps with cubic arcs so the expanded result stays smooth
 * without dozens of cap points.
 */
export function uniformCenterlineToOutline(contour: Contour, width: number, cap: StrokeCap): Contour | null {
  const flattened = flattenContour(contour, 8);
  if (flattened.length < 2) return null;
  const pts = simplifyPolyline(flattened, Math.max(0.5, width * 0.025));
  if (pts.length < 2) return null;

  const r = Math.max(0.5, width / 2);
  const tangents = pts.map((p, i) => {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    return normalized(next.x - prev.x, next.y - prev.y);
  });

  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const t = tangents[i];
    let base = pts[i];
    if (cap === "square") {
      if (i === 0) base = { x: base.x - t.x * r, y: base.y - t.y * r };
      if (i === pts.length - 1) base = { x: base.x + t.x * r, y: base.y + t.y * r };
    }
    const n = { x: -t.y, y: t.x };
    left.push({ x: base.x + n.x * r, y: base.y + n.y * r });
    right.push({ x: base.x - n.x * r, y: base.y - n.y * r });
  }

  const nodes: PathNode[] = left.map((point) => ({
    id: shortId("node"), point, handleIn: null as Point | null, handleOut: null as Point | null, type: "corner" as const,
  }));

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
    const point = right[right.length - 1];
    nodes.push({ id: shortId("node"), point, handleIn: null, handleOut: null, type: "corner" as const });
  }

  for (let i = right.length - 2; i >= 0; i--) {
    nodes.push({ id: shortId("node"), point: right[i], handleIn: null, handleOut: null, type: "corner" as const });
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

  return { id: shortId("contour"), closed: true, nodes };
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
    const contours = obj.contours
      .map((c) => uniformCenterlineToOutline(c, width, obj.cap ?? "round"))
      .filter((c): c is Contour => Boolean(c));
    return contours.length ? { id: shortId("obj"), kind: "expanded", contours } : null;
  }

  if (obj.kind === "brush") {
    // Variable-profile brushes also expand from their current editable
    // centerline. brushOutlineContours resamples captured pressure onto the
    // edited path, avoiding the old "snap back to raw samples" behavior.
    const contours = brushOutlineContours(obj);
    if (contours.length) return { id: shortId("obj"), kind: "expanded", contours };
    return null;
  }

  return null;
}
