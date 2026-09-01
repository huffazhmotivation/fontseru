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
 * profile*: several horizontal scanlines through the height range the two
 * glyphs actually share are sampled, and the tightest real gap between
 * their letterform edges at any of those heights is used instead of the
 * outer bbox gap. This is what lets, e.g., a diagonal stroke like "V"'s
 * varying protrusion at different heights be told apart from a straight
 * stem like "H" — a single bounding box can't distinguish the two, but a
 * scanline through the middle of each can. It's a real analysis of the
 * user's actual letterforms, not a static pair table — but, matching the
 * original project brief's own framing, it's meant as "a strong starting
 * point, not perfect professional typography."
 *
 * For a glyph with no outline drawn yet, falls back to its side-bearing
 * metrics (advanceWidth/lsb/rsb) so a sensible suggestion still exists
 * before anything has been drawn.
 */
const TARGET_GAP_RATIO = 0.09; // ~ comfortable optical gap, as a fraction of UPM
const MIN_KERN_RATIO = -0.22;
const MAX_KERN_RATIO = 0.08;
const SCAN_SAMPLES: number = 24; // horizontal scanlines sampled through the shared ink zone

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
 */
export function inkExtentAtY(outline: GlyphOutline, y: number): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  let found = false;

  for (const obj of outline.objects) {
    if (isFilledObject(obj)) {
      for (const contour of obj.contours) {
        for (const x of polygonCrossings(flattenContour(contour), y)) {
          found = true;
          if (x < min) min = x;
          if (x > max) max = x;
        }
      }
    } else if (isStrokeObject(obj)) {
      const half = (obj.strokeWidth ?? 0) / 2;
      for (const contour of obj.contours) {
        for (const x of polylineCrossings(flattenContour(contour), y)) {
          found = true;
          if (x - half < min) min = x - half;
          if (x + half > max) max = x + half;
        }
      }
    }
  }

  return found ? { min, max } : null;
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

    let tightestGap = Infinity;
    for (let i = 0; i < SCAN_SAMPLES; i++) {
      const t = SCAN_SAMPLES === 1 ? 0.5 : i / (SCAN_SAMPLES - 1);
      const y = minY + t * (maxY - minY);

      const leftInk = inkExtentAtY(l.outline, y);
      const rightInk = inkExtentAtY(r.outline, y);
      if (!leftInk || !rightInk) continue; // no ink from one side at this height — no collision risk here

      const gapHere = l.advanceWidth - leftInk.max + rightInk.min;
      if (gapHere < tightestGap) tightestGap = gapHere;
    }

    if (Number.isFinite(tightestGap)) naturalGap = tightestGap;
  }

  const targetGap = metrics.unitsPerEm * TARGET_GAP_RATIO;

  let suggestion = targetGap - naturalGap;
  const min = metrics.unitsPerEm * MIN_KERN_RATIO;
  const max = metrics.unitsPerEm * MAX_KERN_RATIO;
  suggestion = Math.max(min, Math.min(max, suggestion));
  return Math.round(suggestion / 5) * 5;
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
