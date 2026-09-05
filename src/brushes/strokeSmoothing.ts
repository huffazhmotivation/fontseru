import type { Point } from "@/types/geometry";
import { simplifyPolyline } from "@/utils/simplify";

/**
 * Shared freehand-stroke smoothing engine.
 *
 * Originally written for the Pencil tool (see the old `smoothPencilPoints`
 * in `editor/usePencilTool.ts`) and now the single source of truth for how
 * ANY freehand input stream — Pencil's centerline, or the Brush's live
 * pointer stream / captured sample buffer — gets cleaned up. Both tools
 * call `smoothStroke` below so "Stabilizer" and "Smoothing" behave the same
 * way, and read the same way, regardless of which tool is active.
 *
 * Generic over `T extends Point` so it works directly on plain `Point[]`
 * (Pencil) as well as `StrokeSample[]` (Brush, which also carries a
 * `pressure` field per sample) — pressure is preserved (weighted-averaged
 * alongside x/y) automatically for any sample shape that has it.
 */

/** Weighted moving average, generic over any point-like sample. Extra
 * numeric fields other than x/y are passed through unchanged from the
 * center sample EXCEPT `pressure`, which — when present — is smoothed
 * alongside x/y so brush width and stabilization move together. */
export function movingAverageSamples<T extends Point>(points: T[], windowRadius: number): T[] {
  if (windowRadius <= 0) return points;
  const n = points.length;
  const hasPressure = n > 0 && typeof (points[0] as unknown as { pressure?: number }).pressure === "number";
  const sumsX = new Array<number>(n + 1).fill(0);
  const sumsY = new Array<number>(n + 1).fill(0);
  const sumsP = hasPressure ? new Array<number>(n + 1).fill(0) : null;
  for (let i = 0; i < n; i++) {
    sumsX[i + 1] = sumsX[i] + points[i].x;
    sumsY[i + 1] = sumsY[i] + points[i].y;
    if (sumsP) sumsP[i + 1] = sumsP[i] + (points[i] as unknown as { pressure: number }).pressure;
  }
  return points.map((p, i) => {
    const from = Math.max(0, i - windowRadius);
    const to = Math.min(n - 1, i + windowRadius) + 1;
    const count = to - from;
    const out: T = { ...p, x: (sumsX[to] - sumsX[from]) / count, y: (sumsY[to] - sumsY[from]) / count };
    if (sumsP) (out as unknown as { pressure: number }).pressure = (sumsP[to] - sumsP[from]) / count;
    return out;
  });
}

/**
 * Roughness score in [0, 1]: the fraction of interior samples where the
 * RAW (unsmoothed) hand-drawn gesture reverses direction sharply from one
 * sample to the next. Real hand tremor shows up as many small, high-
 * frequency direction flips; a deliberate curve turns gradually over many
 * samples and barely trips this at all. Used to boost smoothing
 * automatically on a shaky stroke instead of requiring the Stabilizer/
 * Smoothing setting to be cranked up globally — which would also flatten
 * intentional curvature on every OTHER stroke.
 */
export function estimateRoughness<T extends Point>(points: T[]): number {
  if (points.length < 5) return 0;
  const JITTER_ANGLE = (16 * Math.PI) / 180;
  let jittery = 0;
  let counted = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const u0x = b.x - a.x, u0y = b.y - a.y;
    const u1x = c.x - b.x, u1y = c.y - b.y;
    const l0 = Math.hypot(u0x, u0y);
    const l1 = Math.hypot(u1x, u1y);
    if (l0 < 1e-6 || l1 < 1e-6) continue;
    const dot = Math.max(-1, Math.min(1, (u0x * u1x + u0y * u1y) / (l0 * l1)));
    counted++;
    if (Math.acos(dot) > JITTER_ANGLE) jittery++;
  }
  return counted === 0 ? 0 : jittery / counted;
}

/**
 * Box-average window radius (in SAMPLE COUNT, not distance) for a given
 * effective smoothing strength and stream length.
 *
 * BUG FIX: this used to be `Math.round(effective * 8)` with no relation to
 * `n` at all. For a short, jittery/"putus-putus" gesture — a quick stroke
 * that reverses direction a lot and therefore has few raw samples AND high
 * measured roughness — that fixed radius-of-8 window is wider than (or
 * close to) the whole sample buffer. `movingAverageSamples` clamps its
 * window to the array bounds, so once the radius covers nearly every
 * sample, EVERY output point collapses toward the same single average —
 * effectively the centroid of the whole back-and-forth path. The stroke
 * doesn't just get smoother, it shrinks to a single point, and since the
 * brush outline is swept along that near-zero-length centerline, nothing
 * visible gets drawn. This only showed up once Stabilizer/Smoothing was
 * raised above 0 (at 0 the raw samples are returned untouched, see below).
 *
 * Fix: cap the radius at a fraction of the available samples so a short
 * stroke can never be averaged over (most of) its own length, regardless
 * of how rough it measures.
 */
export function windowRadiusFor(effective: number, n: number): number {
  const desired = Math.round(effective * 8);
  const maxForLength = Math.max(1, Math.floor((n - 1) / 4));
  return Math.max(1, Math.min(desired, maxForLength));
}

/**
 * Append-only, O(1)-per-sample approximation of `smoothStroke` for the LIVE
 * preview while the pointer is still down.
 *
 * BUG FIX: the Brush tool used to call the full `smoothStroke` (double
 * moving-average pass + RDP simplification) on the WHOLE raw buffer, from
 * scratch, on every single pointermove. Two different problems came from
 * that once Stabilizer was above 0:
 *  - Cost grows with the stroke's own length (RDP recursion plus two full
 *    array passes every move), so a longer gesture visibly laggeed more and
 *    more the further you drew — "ngelag".
 *  - RDP's kept-point selection depends on the ENTIRE buffer, so as new
 *    points arrived the set of points kept from a moment ago could change
 *    completely, snapping the live line into a different shape frame to
 *    frame instead of smoothly extending it — this is what read as the
 *    stroke coming out broken/discontinuous ("putus-putus") or sometimes
 *    seeming not to appear at all while a slower device fell behind.
 *
 * Fix: only ever compute ONE new stabilized point per call, from a small,
 * fixed-size trailing window of the raw buffer, and append it after
 * whatever was already there. Earlier points are never revisited or
 * reshaped, so the preview grows incrementally at a cost independent of
 * total stroke length. The FINAL committed stroke still runs the exact,
 * full `smoothStroke` once on pointer-up (see useBrushTool.ts), so accuracy
 * of the actual saved geometry is unaffected — only the live preview uses
 * this cheaper approximation.
 */
export function appendStabilizedSample<T extends Point>(
  raw: T[],
  prevSmoothed: T[],
  smoothing: number
): T[] {
  if (raw.length === 0) return prevSmoothed;
  const last = raw[raw.length - 1];
  if (smoothing <= 0) return [...prevSmoothed, last];
  const TAIL = 24; // small fixed window — enough samples for a meaningful average, independent of total stroke length
  const tail = raw.slice(Math.max(0, raw.length - TAIL));
  const roughness = estimateRoughness(tail);
  const effective = Math.max(0, Math.min(1, smoothing + roughness * 0.5));
  const radius = windowRadiusFor(effective, tail.length);
  const window = tail.slice(Math.max(0, tail.length - 1 - radius));
  const hasPressure = typeof (window[0] as unknown as { pressure?: number }).pressure === "number";
  let sx = 0, sy = 0, sp = 0;
  for (const p of window) {
    sx += p.x;
    sy += p.y;
    if (hasPressure) sp += (p as unknown as { pressure: number }).pressure;
  }
  const n = window.length;
  const out: T = { ...last, x: sx / n, y: sy / n };
  if (hasPressure) (out as unknown as { pressure: number }).pressure = sp / n;
  return [...prevSmoothed, out];
}

/**
 * Cleans a raw freehand point/sample stream into a sparse, editable set.
 * Two passes of moving-average smoothing round out hand tremor without
 * flattening the gesture's real shape, then Ramer-Douglas-Peucker collapses
 * the dense pointer samples down to just the points needed to keep the
 * curve's silhouette. Both the smoothing window and the simplification
 * tolerance scale with `smoothing` (the tool's own Stabilizer/Smoothing
 * setting) AND with the stroke's own measured roughness — a shaky gesture
 * gets extra smoothing automatically, without needing the user to
 * preemptively max out the setting.
 *
 * `epsilonScale` converts the tolerance from "screen-pixel-equivalent"
 * units into whatever coordinate space `points` is in — pass `hitScale`
 * for a screen-space caller (Pencil, Brush) so crispness holds regardless
 * of zoom level. This is the FULL, exact engine — see `appendStabilizedSample`
 * above for the cheap live-preview approximation used while the pointer is
 * still down.
 */
export function smoothStroke<T extends Point>(rawPoints: T[], smoothing: number, epsilonScale: number): T[] {
  if (rawPoints.length < 3) return rawPoints;
  // `smoothing` at exactly 0 means "no smoothing at all" — the raw,
  // untouched gesture, point for point (and sample for sample, pressure
  // included). Both a live pass and a final/committed pass can genuinely
  // go to zero and preserve every hand-drawn wobble this way.
  if (smoothing <= 0) return rawPoints;
  const roughness = estimateRoughness(rawPoints);
  const effective = Math.max(0, Math.min(1, smoothing + roughness * 0.5));
  const windowRadius = windowRadiusFor(effective, rawPoints.length);
  let smoothed = movingAverageSamples(rawPoints, windowRadius);
  // A second, lighter pass approximates a Gaussian kernel far better than a
  // single box-average pass alone — it noticeably rounds out curved
  // gestures (fewer visible facets through bends) without flattening
  // intentional corners, since simplifyPolyline below still preserves
  // sharp turns regardless of how much this smooths the curve itself.
  smoothed = movingAverageSamples(smoothed, Math.max(1, Math.round(windowRadius * 0.6)));
  // Tolerance is in screen-pixel terms (scaled via epsilonScale) so the
  // same visual crispness holds regardless of zoom level. RDP only ever
  // drops a point that doesn't deviate from the line between its kept
  // neighbors by more than this tolerance, so a real corner is always kept.
  const epsilon = Math.max(2.6, 2.4 + effective * 11) * epsilonScale;
  return simplifyPolyline(smoothed, epsilon);
}
