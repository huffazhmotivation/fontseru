import type { GlyphMap } from "@/types/glyph";
import type { FontMetrics } from "@/types/font";
import type { GlyphOutline, Point } from "@/types/geometry";
import { isFilledObject, isStrokeObject } from "@/types/geometry";
import { outlineBounds, flattenContour } from "@/editor/objectOps";
import { kerningKey } from "@/types/kerning";

/**
 * A geometry-based kerning suggestion.
 *
 * Refines a coarse whole-glyph ink bounding box (via the same
 * `outlineBounds` used elsewhere for selection/fit) with an *optical
 * profile*: many horizontal scanlines through the height range the two
 * glyphs actually share are sampled, and the tightest real gap between
 * their letterform edges at any of those heights is used instead of the
 * outer bbox gap. This is what lets, e.g., a diagonal stroke like "V"'s
 * varying protrusion at different heights be told apart from a straight
 * stem like "H" — a single bounding box can't distinguish the two, but a
 * scanline through the middle of each can. It's a real analysis of the
 * user's actual letterforms, not a static pair table.
 *
 * For a glyph with no outline drawn yet, falls back to its side-bearing
 * metrics (advanceWidth/lsb/rsb) so a sensible suggestion still exists
 * before anything has been drawn.
 *
 * Two things specifically guard against letters ending up jammed together
 * ("berdempetan") on curved or diagonal letterforms:
 *
 * 1. Curves are flattened at a much finer resolution here
 *    (`KERN_FLATTEN_STEPS`) than the editor's normal render/selection
 *    flatten, and the scanline count adapts to the glyphs' shared height
 *    so there's always a dense set of samples through that range — plus a
 *    local refinement pass around whichever sample came back tightest, to
 *    pinpoint the true closest approach between two curves instead of
 *    settling for whatever a coarse, evenly-spaced grid happened to land
 *    on. A shallow, evenly-spaced scan can walk right past the one point
 *    where two curves actually get close, which is exactly what "not
 *    reading the letterform" looks like in practice.
 * 2. The suggested kerning is never allowed to close the *measured*
 *    tightest gap past a hard safety floor (`MIN_SAFE_GAP_RATIO`),
 *    regardless of the softer aesthetic min/max ratios below. Those
 *    min/max ratios exist to keep kerning values looking natural; the
 *    safety floor exists purely to guarantee no suggestion can ever push
 *    two letterforms into visual contact, even for a pair whose natural
 *    (zero-kerning) side-bearings already sit unusually close together.
 */
const TARGET_GAP_RATIO = 0.09; // ~ comfortable optical gap, as a fraction of UPM
const MIN_KERN_RATIO = -0.22;
const MAX_KERN_RATIO = 0.08;
// Hard floor: whatever else happens, the real measured gap between the two
// letterforms' closest edges is never allowed to shrink below this once the
// suggested kerning is applied. This is what actually stops glyphs from
// touching — the ratios above only shape how *natural* the value looks.
const MIN_SAFE_GAP_RATIO = 0.014;
const BASE_SCAN_SAMPLES = 24; // coarse first pass across the full shared height range
const MAX_SCAN_SAMPLES = 64; // hard cap so very tall shared ranges don't blow up cost
const SCAN_STEP_RATIO = 0.01; // aim for at least one coarse scanline per 1% of UPM
const REFINE_SAMPLES = 16; // extra samples zoomed into the neighborhood of the coarse minimum
// Curves get flattened far finer here than the editor's default (16 steps)
// used for rendering/selection — this is an offline, batched calculation,
// not a per-frame one, so it can afford the extra precision needed to
// actually find where two curved or diagonal strokes come closest.
const KERN_FLATTEN_STEPS = 48;

/** x-crossings of a closed, already-flattened polygon with the line y = height. */
function polygonCrossings(points: Point[], y: number): number[] {
  const xs: number[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (a.y === b.y) continue;
    if ((y >= a.y && y < b.y) || (y >= b.y && y < a.y)) {
      xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
  }
  return xs;
}

/** x-crossings of an open polyline (a stroke centerline) with the line y = height. */
function polylineCrossings(points: Point[], y: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.y === b.y) continue;
    if ((y >= a.y && y < b.y) || (y >= b.y && y < a.y)) {
      xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
  }
  return xs;
}

/**
 * Leftmost/rightmost ink x at one scanline, or null when the glyph has no
 * ink crossing that height at all (e.g. below "T"'s crossbar there's only
 * the stem — a sample taken off to the side contributes nothing rather
 * than inventing a false edge).
 *
 * `steps` controls how finely Bézier segments are flattened before being
 * scanned; callers hunting for an exact closest-approach point (auto-kern)
 * should pass a much finer value than the editor's default render/select
 * flatten, since a coarse flatten can round off exactly the bit of curve
 * that matters.
 */
export function inkExtentAtY(outline: GlyphOutline, y: number, steps = 16): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  let found = false;

  for (const obj of outline.objects) {
    if (isFilledObject(obj)) {
      for (const contour of obj.contours) {
        for (const x of polygonCrossings(flattenContour(contour, steps), y)) {
          found = true;
          if (x < min) min = x;
          if (x > max) max = x;
        }
      }
    } else if (isStrokeObject(obj)) {
      const half = (obj.strokeWidth ?? 0) / 2;
      for (const contour of obj.contours) {
        for (const x of polylineCrossings(flattenContour(contour, steps), y)) {
          found = true;
          if (x - half < min) min = x - half;
          if (x + half > max) max = x + half;
        }
      }
    }
  }

  return found ? { min, max } : null;
}

/**
 * Tightest optical gap between two glyphs (at zero kerning) across a given
 * height range. Runs a coarse, evenly-spaced pass first, then zooms in with
 * a second, denser pass around whichever coarse sample came back tightest —
 * since the true closest approach between two curves usually sits *between*
 * two coarse samples, not exactly on one of them.
 */
function tightestGapInRange(
  l: { outline: GlyphOutline; advanceWidth: number },
  r: { outline: GlyphOutline },
  minY: number,
  maxY: number,
  unitsPerEm: number
): number {
  const range = maxY - minY;
  // At least one scanline every SCAN_STEP_RATIO of the font's UPM (an
  // absolute, font-scaled spacing, not a fixed sample count), bounded to
  // [BASE_SCAN_SAMPLES, MAX_SCAN_SAMPLES] so a tall shared range still gets
  // real density while a very large range can't blow up the sample count.
  const stepSize = Math.max(1, unitsPerEm * SCAN_STEP_RATIO);
  const wantedForRange = range > 0 ? Math.ceil(range / stepSize) + 1 : BASE_SCAN_SAMPLES;
  const count = Math.min(MAX_SCAN_SAMPLES, Math.max(BASE_SCAN_SAMPLES, wantedForRange));

  let tightest = Infinity;
  let prevY = minY;
  let nextY = maxY;

  const gapAt = (y: number): number | null => {
    const leftInk = inkExtentAtY(l.outline, y, KERN_FLATTEN_STEPS);
    const rightInk = inkExtentAtY(r.outline, y, KERN_FLATTEN_STEPS);
    if (!leftInk || !rightInk) return null;
    return l.advanceWidth - leftInk.max + rightInk.min;
  };

  const ys: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    ys.push(minY + t * range);
  }

  for (let i = 0; i < ys.length; i++) {
    const gap = gapAt(ys[i]);
    if (gap != null && gap < tightest) {
      tightest = gap;
      prevY = ys[i - 1] ?? minY;
      nextY = ys[i + 1] ?? maxY;
    }
  }

  if (!Number.isFinite(tightest)) return tightest;

  // Refine: zoom into the neighborhood around the coarse minimum with a
  // denser set of samples, so a dip that fell between two coarse scanlines
  // still gets found.
  const refineSpan = nextY - prevY;
  if (refineSpan > 0) {
    for (let i = 0; i <= REFINE_SAMPLES; i++) {
      const y = prevY + (i / REFINE_SAMPLES) * refineSpan;
      const gap = gapAt(y);
      if (gap != null && gap < tightest) tightest = gap;
    }
  }

  return tightest;
}

export function suggestKerningPair(glyphs: GlyphMap, metrics: FontMetrics, left: string, right: string): number {
  const l = glyphs[left];
  const r = glyphs[right];
  if (!l || !r) return 0;

  const lBounds = outlineBounds(l.outline);
  const rBounds = outlineBounds(r.outline);

  const leftInkRight = lBounds ? lBounds.maxX : l.advanceWidth - l.rsb;
  const leftGap = Math.max(0, l.advanceWidth - leftInkRight);

  const rightInkLeft = rBounds ? rBounds.minX : r.lsb;
  const rightGap = Math.max(0, rightInkLeft);

  // Coarse bbox-based gap — always available, and the only option when
  // either glyph has no outline drawn yet.
  let naturalGap = leftGap + rightGap;

  // When both glyphs have real ink, refine with the optical scanline
  // profile described above.
  if (lBounds && rBounds) {
    const overlapMinY = Math.max(lBounds.minY, rBounds.minY);
    const overlapMaxY = Math.min(lBounds.maxY, rBounds.maxY);
    const hasOverlap = overlapMinY <= overlapMaxY;
    const minY = hasOverlap ? overlapMinY : Math.min(lBounds.minY, rBounds.minY);
    const maxY = hasOverlap ? overlapMaxY : Math.max(lBounds.maxY, rBounds.maxY);

    const tightest = tightestGapInRange(l, r, minY, maxY, metrics.unitsPerEm);
    if (Number.isFinite(tightest)) naturalGap = tightest;
  }

  const targetGap = metrics.unitsPerEm * TARGET_GAP_RATIO;
  const minSafeGap = metrics.unitsPerEm * MIN_SAFE_GAP_RATIO;

  const min = metrics.unitsPerEm * MIN_KERN_RATIO;
  const max = metrics.unitsPerEm * MAX_KERN_RATIO;

  // The kerning needed so the measured tightest gap ends up at exactly the
  // safety floor. Below this, the two letterforms would visually touch or
  // overlap — this floor always wins over the softer aesthetic min/max
  // ratios, expanding whichever of them would otherwise allow a collision.
  const requiredForSafety = minSafeGap - naturalGap;
  const effectiveMin = Math.max(min, requiredForSafety);
  const effectiveMax = Math.max(max, effectiveMin);

  let suggestion = targetGap - naturalGap;
  suggestion = Math.max(effectiveMin, Math.min(effectiveMax, suggestion));

  // Snap to a "nice" multiple of 5 for a cleaner pair table — but nearest-5
  // rounding can round DOWN, and when the safety floor above is the actual
  // binding constraint (naturalGap deeply negative/overlapping, so
  // requiredForSafety pushed effectiveMin well past the aesthetic min/max
  // ratios), rounding down can silently reopen up to ~2.5 units of exactly
  // the collision the floor exists to prevent. Round up instead whenever
  // nearest-5 would land below the real (unrounded) safety requirement, so
  // the hard guarantee always holds for the value actually returned/applied,
  // not just for the pre-rounded intermediate.
  let rounded = Math.round(suggestion / 5) * 5;
  if (rounded < requiredForSafety) rounded = Math.ceil(requiredForSafety / 5) * 5;
  return rounded;
}


export interface GlobalAutoKernResult {
  pairs: Record<string, number>;
  manual: Record<string, boolean>;
  processed: number;
  updated: number;
  preservedManual: number;
}

/** Yields to the browser so a long chunked loop doesn't freeze the UI thread. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const CHUNK_SIZE = 400; // pairs processed per tick before yielding + reporting progress

/**
 * Process every ordered pair in the currently available glyph set.
 * Manual overrides are treated as user-owned and survive subsequent passes.
 * Zero-valued automatic pairs are omitted to keep persisted state compact.
 * When `fallbackPairs` is supplied for a layered style, an explicit zero is
 * retained only when it is needed to override a non-zero inherited value.
 * Existing callers omit this argument and keep the exact original behavior.
 *
 * Runs in chunks (yielding back to the browser between them) rather than as
 * one blocking loop, so a large glyph set (n^2 pairs, each now sampling the
 * optical scanline profile) doesn't freeze the tab — and so a caller can
 * pass `onProgress` to drive a real, non-fake loading indicator.
 */
export async function autoKernAllAvailablePairs(
  glyphs: GlyphMap,
  metrics: FontMetrics,
  currentPairs: Record<string, number>,
  manualFlags: Record<string, boolean>,
  fallbackPairs?: Record<string, number>,
  onProgress?: (fraction: number) => void
): Promise<GlobalAutoKernResult> {
  // The space glyph (unicode 0x20) is excluded here: it has no ink to
  // measure a real optical gap against, so suggestKerningPair would just
  // fall back to its bare advanceWidth/lsb/rsb and manufacture kerning
  // pairs against word-space out of nothing. Word spacing already has its
  // own dedicated, purpose-built control (RightPanel's "Word Spacing" /
  // "Auto") — auto-kern shouldn't quietly duplicate or fight it.
  const chars = Object.keys(glyphs).filter((ch) => glyphs[ch].unicode !== 0x20);
  const pairs = { ...currentPairs };
  const manual = { ...manualFlags };
  let processed = 0;
  let updated = 0;
  let preservedManual = 0;

  const total = chars.length * chars.length;
  let sinceYield = 0;

  for (const left of chars) {
    for (const right of chars) {
      processed++;
      const key = kerningKey(left, right);
      if (manual[key]) {
        preservedManual++;
      } else {
        const suggestion = suggestKerningPair(glyphs, metrics, left, right);
        if (suggestion === 0) {
          const needsExplicitZero = (fallbackPairs?.[key] ?? 0) !== 0;
          if (needsExplicitZero) {
            if (pairs[key] !== 0) updated++;
            pairs[key] = 0;
            manual[key] = false;
          } else {
            if (key in pairs) {
              delete pairs[key];
              updated++;
            }
            delete manual[key];
          }
        } else {
          if (pairs[key] !== suggestion) updated++;
          pairs[key] = suggestion;
          manual[key] = false;
        }
      }

      sinceYield++;
      if (sinceYield >= CHUNK_SIZE) {
        sinceYield = 0;
        onProgress?.(total > 0 ? processed / total : 1);
        await yieldToBrowser();
      }
    }
  }

  onProgress?.(1);
  return { pairs, manual, processed, updated, preservedManual };
}
