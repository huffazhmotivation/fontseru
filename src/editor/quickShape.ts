import type { Point } from "@/types/geometry";

/**
 * "QuickShape"-style freehand shape recognition, modeled on Procreate's
 * behavior: draw a line or a round shape by hand, pause with the pointer
 * still down at the end of the gesture, and — if what you drew reads as an
 * intentional straight line or circle/ellipse despite the hand wobble —
 * the tool that's holding the pointer down (Pencil, Brush) swaps its
 * preview to the geometrically perfect version and commits that instead
 * of the raw wobbly path when you lift.
 *
 * This module only *detects* the shape and produces sample points for it;
 * it has no knowledge of pointer timing — see `QUICK_SHAPE_HOLD_MS` and
 * each tool's own hold-timer (usePencilTool.ts / useBrushTool.ts) for how
 * "pause while still down" is turned into a call to `detectQuickShape`.
 */

/** How long the pointer must stay effectively still (no new point cleared
 * the tool's hold timer) before a hold-recognition pass runs. Long enough
 * that normal drawing pauses (a corner, lifting to check the shape) don't
 * accidentally trigger it, short enough to feel responsive once you do
 * intentionally hold. */
export const QUICK_SHAPE_HOLD_MS = 350;

export type QuickShapeResult =
  | { kind: "line"; start: Point; end: Point }
  | { kind: "circle" | "ellipse"; center: Point; rx: number; ry: number; rotation: number };

/**
 * Snaps a nearly-axis/diagonal line to the nearest common angle (0°, 15°,
 * 30°... every 15°) when it's already close, the way Procreate's own
 * QuickShape line has a "magnetic" pull toward horizontal/vertical/45°.
 * Left untouched otherwise, so an intentionally-angled line isn't forced
 * onto a grid it wasn't aimed at.
 */
function snapLineAngle(start: Point, end: Point): { start: Point; end: Point } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { start, end };
  const SNAP_STEP_DEG = 15;
  const SNAP_TOLERANCE_DEG = 4;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const nearest = Math.round(deg / SNAP_STEP_DEG) * SNAP_STEP_DEG;
  if (Math.abs(deg - nearest) > SNAP_TOLERANCE_DEG) return { start, end };
  const rad = (nearest * Math.PI) / 180;
  const mx = (start.x + end.x) / 2;
  const my = (start.y + end.y) / 2;
  const half = len / 2;
  const ex = Math.cos(rad);
  const ey = Math.sin(rad);
  return {
    start: { x: mx - ex * half, y: my - ey * half },
    end: { x: mx + ex * half, y: my + ey * half },
  };
}

/**
 * Looks at a raw freehand point stream and decides whether it reads as an
 * intentional straight line or a circle/ellipse, despite hand tremor.
 * Returns null when the gesture doesn't confidently match either — that's
 * the common case, and callers should just keep drawing normally.
 *
 * `hitScale` (screen-px-to-native-unit factor, same one every other
 * tolerance in the editor is scaled by — see usePencilTool/useBrushTool)
 * keeps the tolerances feeling the same regardless of zoom level.
 *
 * `allowLine` gates line detection off for tools where a straight line
 * isn't a meaningful committed result on its own (Pencil always closes
 * into a filled shape, where a zero-area line has nothing to fill) — the
 * Brush tool, which commits an open centerline stroke, passes true.
 */
export function detectQuickShape(points: Point[], hitScale: number, allowLine: boolean): QuickShapeResult | null {
  const n = points.length;
  if (n < 8) return null;

  let sx = 0;
  let sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  const cx = sx / n;
  const cy = sy / n;

  let pathLen = 0;
  for (let i = 1; i < n; i++) pathLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);

  const minSpan = 6 * hitScale;
  if (pathLen < minSpan) return null; // stray tap/jitter, not a shape attempt

  const start = points[0];
  const end = points[n - 1];
  const chord = Math.hypot(end.x - start.x, end.y - start.y);

  if (allowLine) {
    // Total-least-squares line fit through the centroid (principal axis of
    // the point cloud), then check how far every point strays from it.
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of points) {
      const dx = p.x - cx, dy = p.y - cy;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    let maxDev = 0;
    for (const p of points) {
      const dx = p.x - cx, dy = p.y - cy;
      const perp = Math.abs(-dirY * dx + dirX * dy);
      if (perp > maxDev) maxDev = perp;
    }
    const lineTolerance = Math.max(3.2 * hitScale, pathLen * 0.045);
    // chord close to the full traveled length rules out a gesture that
    // doubled back on itself (that's a candidate for the circle check
    // below, not a line).
    if (maxDev < lineTolerance && chord > pathLen * 0.85) {
      const proj = (p: Point) => (p.x - cx) * dirX + (p.y - cy) * dirY;
      const t0 = proj(start);
      const t1 = proj(end);
      const sPt = { x: cx + dirX * t0, y: cy + dirY * t0 };
      const ePt = { x: cx + dirX * t1, y: cy + dirY * t1 };
      const snapped = snapLineAngle(sPt, ePt);
      return { kind: "line", start: snapped.start, end: snapped.end };
    }
  }

  // A circle/ellipse attempt should come back close to where it started —
  // a gesture that ended far from its start isn't a closed round shape.
  if (chord > pathLen * 0.35) return null;

  let sumR = 0;
  let sweep = 0;
  let prevAngle: number | null = null;
  for (const p of points) {
    const dx = p.x - cx, dy = p.y - cy;
    sumR += Math.hypot(dx, dy);
    const a = Math.atan2(dy, dx);
    if (prevAngle !== null) {
      let d = a - prevAngle;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      sweep += d;
    }
    prevAngle = a;
  }
  const avgR = sumR / n;
  if (avgR < 4 * hitScale) return null; // too small to be an intentional circle
  if (Math.abs(sweep) < Math.PI * 1.5) return null; // never swept most of the way around

  // Pure-circle check: every point roughly the same distance from centroid.
  let maxRDev = 0;
  for (const p of points) {
    const dx = p.x - cx, dy = p.y - cy;
    maxRDev = Math.max(maxRDev, Math.abs(Math.hypot(dx, dy) - avgR));
  }
  const circleTolerance = Math.max(0.16 * avgR, 3 * hitScale);
  if (maxRDev < circleTolerance) {
    return { kind: "circle", center: { x: cx, y: cy }, rx: avgR, ry: avgR, rotation: 0 };
  }

  // Ellipse fallback: fit the point cloud's principal axes (via its
  // covariance matrix) and check every point against that boundary instead
  // of a single radius — catches an intentionally oval gesture that a
  // pure-circle check would reject.
  const covxx = sxx_(points, cx) / n;
  const covyy = syy_(points, cy) / n;
  const covxy = sxy_(points, cx, cy) / n;
  const tr = covxx + covyy;
  const det = covxx * covyy - covxy * covxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(0, tr / 2 - disc);
  const a = Math.sqrt(2 * l1);
  const b = Math.sqrt(2 * l2);
  if (a < 4 * hitScale || b < 2 * hitScale) return null;
  const majorAngle = 0.5 * Math.atan2(2 * covxy, covxx - covyy);
  const cosA = Math.cos(-majorAngle), sinA = Math.sin(-majorAngle);
  let maxEllDev = 0;
  for (const p of points) {
    const dx = p.x - cx, dy = p.y - cy;
    const lx = dx * cosA - dy * sinA;
    const ly = dx * sinA + dy * cosA;
    const rNorm = Math.hypot(lx / a, ly / b);
    maxEllDev = Math.max(maxEllDev, Math.abs(rNorm - 1));
  }
  if (maxEllDev < 0.22) {
    return { kind: "ellipse", center: { x: cx, y: cy }, rx: a, ry: b, rotation: majorAngle };
  }

  return null;
}

function sxx_(points: Point[], cx: number): number {
  let s = 0;
  for (const p of points) { const d = p.x - cx; s += d * d; }
  return s;
}
function syy_(points: Point[], cy: number): number {
  let s = 0;
  for (const p of points) { const d = p.y - cy; s += d * d; }
  return s;
}
function sxy_(points: Point[], cx: number, cy: number): number {
  let s = 0;
  for (const p of points) s += (p.x - cx) * (p.y - cy);
  return s;
}

/**
 * Turns a recognized QuickShape into a dense polyline that the existing
 * `centerlineToContour` pipeline can turn into real (curved, node-based)
 * geometry — a line becomes its two endpoints, a circle/ellipse becomes a
 * ring of points sampled evenly around its perimeter so the auto-smoothing
 * pass reconstructs it as a smooth closed curve.
 */
export function quickShapePolyline(shape: QuickShapeResult, segments = 48): Point[] {
  if (shape.kind === "line") return [shape.start, shape.end];
  const { center, rx, ry, rotation } = shape;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const pts: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const lx = Math.cos(t) * rx;
    const ly = Math.sin(t) * ry;
    pts.push({ x: center.x + lx * cos - ly * sin, y: center.y + lx * sin + ly * cos });
  }
  return pts;
}
