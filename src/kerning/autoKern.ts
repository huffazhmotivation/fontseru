import type { GlyphMap } from "@/types/glyph";
import type { FontMetrics } from "@/types/font";
import type { GlyphOutline, Point } from "@/types/geometry";
import { isFilledObject, isStrokeObject } from "@/types/geometry";
import { outlineBounds, flattenContour } from "@/editor/objectOps";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
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
// (Value itself now lives in `INK_CONTOUR_STEPS`, shared with autoSpace.ts.)

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

/**
 * Resolves every object in `outline` into the actual filled polygon(s) its
 * ink occupies, flattened to `steps` resolution — the SAME shape that ends
 * up on screen/in the exported font, not an approximation of it.
 *
 * This used to be two different code paths: filled objects were flattened
 * directly, while "line"/"brush" stroke objects were reduced to their bare
 * centerline plus a constant `strokeWidth/2` added in the X DIRECTION ONLY
 * at each scanline crossing. That shortcut is only correct for a perfectly
 * VERTICAL piece of stroke. For anything closer to horizontal — a "T"
 * crossbar, a serif, a brush terminal, a nearly-flat hand-drawn stroke —
 * the true horizontal footprint of a stroke of width `w` tilted `θ` from
 * vertical is `w / cos(θ)`, which blows up as the stroke flattens out. A
 * centerline crossing straight-up missing a strictly horizontal segment
 * entirely (no x/y change to interpolate a crossing from) is the extreme
 * case of the same bug. Since a hand-drawn "rough"-brush alphabet is full
 * of exactly these near-horizontal strokes, this silently underestimated
 * ink width was the actual cause of letters reading as touching/overlapping
 * even though a "safety floor" already existed downstream — the floor was
 * only ever as good as this measurement, and this measurement was wrong.
 *
 * The fix: reuse `brushOutlineContours`, the SAME stroke-to-outline sweep
 * the app already uses to render/export brush and pen strokes (nib shape,
 * pressure, taper, and the current brush preset's own edge treatment —
 * e.g. Rough's jitter/pitting — all included), instead of a hand-rolled
 * approximation of it. A stroke's true ink is then just another filled
 * polygon, exactly like a "shape"/"expanded" object, so both cases can
 * share one crossing test.
 */
interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function polyBox(p: Point[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pt of p) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Drops polygons whose bounding box sits strictly inside another polygon's
 * (from the SAME object's resolved contours) — i.e. interior counters/holes
 * (a rough/grunge brush's pitting, Outline Brush's hollow-ring inner edge,
 * a glyph's own counter like "O"'s hole). A contour fully enclosed by
 * another can, by construction, never reach further left/right at any
 * height than its enclosing contour already does — so it can never be the
 * one that determines an ink-extent min/max — but a naive scan still has
 * to walk every one of its edges at every single scanline to find that out
 * empirically. A "rough" brush stroke alone can carry 100+ tiny pitting
 * holes (see roughBrushOutlineContours' `holeCount`), so across a whole
 * alphabet's worth of auto-kern scanlines that dead weight adds up to the
 * dominant cost. Pruning once, up front, is what keeps a full n² auto-kern
 * pass tractable without changing the measured extent at all — disjoint
 * regions (a stroke that crosses itself, separate strokes making up one
 * letter) never satisfy strict containment, so they're always kept.
 */
function pruneEnclosedPolys(polys: Point[][]): Point[][] {
  if (polys.length <= 1) return polys;
  const boxes = polys.map(polyBox);
  const keep = polys.map(() => true);
  for (let i = 0; i < polys.length; i++) {
    const a = boxes[i];
    for (let j = 0; j < polys.length; j++) {
      if (i === j) continue;
      const b = boxes[j];
      const strictlyInside =
        a.minX >= b.minX && a.maxX <= b.maxX && a.minY >= b.minY && a.maxY <= b.maxY &&
        (a.minX > b.minX || a.maxX < b.maxX || a.minY > b.minY || a.maxY < b.maxY);
      if (strictlyInside) {
        keep[i] = false;
        break;
      }
    }
  }
  return polys.filter((_, i) => keep[i]);
}

export function resolveInkContours(outline: GlyphOutline, steps = 16): Point[][] {
  const polys: Point[][] = [];
  for (const obj of outline.objects) {
    const objPolys: Point[][] = [];
    if (isFilledObject(obj)) {
      for (const contour of obj.contours) {
        const flat = flattenContour(contour, steps);
        if (flat.length >= 3) objPolys.push(flat);
      }
    } else if (isStrokeObject(obj)) {
      for (const contour of brushOutlineContours(obj)) {
        const flat = flattenContour(contour, steps);
        if (flat.length >= 3) objPolys.push(flat);
      }
    }
    polys.push(...pruneEnclosedPolys(objPolys));
  }
  return polys;
}

/** Per-glyph-outline cache for `resolveInkContours`, keyed by the outline
 *  object's own identity (a new glyph edit always produces a new `outline`
 *  object in this app's store, matching the pattern `glyphPathCache` in
 *  editor/glyphPaths.ts already relies on). `brushOutlineContours` runs a
 *  real geometry sweep per stroke object, so without this cache an n² auto-
 *  kern pass over the whole alphabet would redo that sweep for every glyph
 *  on every one of the ~2n pairs it appears in, instead of once.
 *
 *  Exported so `autoSpace.ts`'s `suggestGlyphSidebearings` can share this
 *  SAME cache (both always resolve at `INK_CONTOUR_STEPS`, see that
 *  constant) instead of calling `resolveInkContours` directly. Auto
 *  Spacing's "toggle Auto Metrik on" flow always re-kerns immediately
 *  afterward (`autoSpaceAllGlyphs`'s `reKernAfter`), so without sharing this
 *  cache every glyph whose outline DIDN'T change across that combined pass
 *  had its ink geometry resolved twice — once for the spacing suggestion,
 *  once more for the kerning pass right after — for no reason, since the
 *  measurement is identical either way. */
const inkContoursCache = new WeakMap<GlyphOutline, Point[][]>();

/** Flatten resolution shared by BOTH Auto Spacing and Auto Kern's optical
 *  measurements, and the cache key steps they must always agree on — a
 *  single source of truth instead of two constants that merely happened to
 *  be kept equal by convention (see `cachedInkContours`'s own doc comment
 *  for why a steps mismatch between callers sharing this cache would be a
 *  silent correctness bug, not just a missed optimization). */
export const INK_CONTOUR_STEPS = 48;

export function cachedInkContours(outline: GlyphOutline, steps: number = INK_CONTOUR_STEPS): Point[][] {
  const cached = inkContoursCache.get(outline);
  if (cached) return cached;
  const resolved = resolveInkContours(outline, steps);
  inkContoursCache.set(outline, resolved);
  return resolved;
}

/**
 * Leftmost/rightmost ink x at one scanline through `contours` (pre-resolved
 * via `resolveInkContours`/`cachedInkContours`), or null when nothing
 * crosses that height at all (e.g. below "T"'s crossbar there's only the
 * stem — a sample taken off to the side contributes nothing rather than
 * inventing a false edge).
 */
export function inkExtentAtY(contours: Point[][], y: number): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  let found = false;

  for (const poly of contours) {
    for (const x of polygonCrossings(poly, y)) {
      found = true;
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }

  return found ? { min, max } : null;
}

interface IndexedEdge {
  yLo: number;
  yHi: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface InkIndex {
  minY: number;
  maxY: number;
  binSize: number;
  bins: IndexedEdge[][];
}

// One bin roughly every this many edges — a plain "l" (a handful of edges)
// gets the floor (MIN_INK_INDEX_BINS) since partitioning it further buys
// nothing; a Rough/Oil brush glyph with 100+ pitting-hole contours (see
// `pruneEnclosedPolys`'s doc comment) gets many more bins, so each one
// still holds only a handful of edges to check.
const MIN_INK_INDEX_BINS = 8;
const MAX_INK_INDEX_BINS = 160;
const EDGES_PER_BIN_TARGET = 6;

/**
 * Bins `contours`' edges by the horizontal band(s) of the glyph's own
 * height range they actually span, so a scanline query only has to walk
 * the edges near ITS height instead of the glyph's entire edge list.
 *
 * This changes nothing about which crossings are found or how their x is
 * computed — `inkExtentAtYIndexed` below re-applies the exact same
 * half-open test (`y >= yLo && y < yHi`, algebraically identical to
 * `polygonCrossings`'s per-edge test: for an edge a→b it's equivalent to
 * `y` lying in `[min(a.y,b.y), max(a.y,b.y))` regardless of which endpoint
 * is "first") and the exact same crossing-x formula to whatever a bin
 * contains. It's purely a "which edges are even worth looking at" index,
 * not a change to the measurement — the set of crossings, and therefore
 * every gap and every suggested kerning value, comes out identical to the
 * unindexed version.
 *
 * An edge whose span touches more than one bin is registered in all of
 * them (harmless duplication, since the exact test at query time is what
 * actually decides a crossing, not bin membership) — this is what keeps a
 * tall diagonal stroke's edge from being missed by whichever bin a query
 * happens to land in.
 */
function buildInkIndex(contours: Point[][]): InkIndex {
  let minY = Infinity;
  let maxY = -Infinity;
  let edgeCount = 0;
  for (const poly of contours) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const pt = poly[i];
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
      if (pt.y !== poly[(i + 1) % n].y) edgeCount++;
    }
  }

  // No ink (or a degenerate zero-height glyph) — a single, effectively
  // empty bin still answers every query with "nothing here", matching
  // `inkExtentAtY`'s existing behavior for an ink-less glyph.
  if (!Number.isFinite(minY)) {
    minY = 0;
    maxY = 0;
  }

  const span = Math.max(1e-6, maxY - minY);
  const numBins = Math.min(
    MAX_INK_INDEX_BINS,
    Math.max(MIN_INK_INDEX_BINS, Math.round(edgeCount / EDGES_PER_BIN_TARGET))
  );
  const binSize = span / numBins;
  const bins: IndexedEdge[][] = Array.from({ length: numBins }, () => []);

  const binOf = (y: number): number => {
    const idx = Math.floor((y - minY) / binSize);
    return Math.min(numBins - 1, Math.max(0, idx));
  };

  for (const poly of contours) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      if (a.y === b.y) continue;
      const yLo = Math.min(a.y, b.y);
      const yHi = Math.max(a.y, b.y);
      const edge: IndexedEdge = { yLo, yHi, ax: a.x, ay: a.y, bx: b.x, by: b.y };
      const startBin = binOf(yLo);
      const endBin = binOf(yHi);
      for (let bi = startBin; bi <= endBin; bi++) bins[bi].push(edge);
    }
  }

  return { minY, maxY, binSize, bins };
}

const inkIndexCache = new WeakMap<GlyphOutline, InkIndex>();

/** Same cache-by-outline-identity pattern as `cachedInkContours` (built ON
 *  TOP of it, so the two share one resolve of the raw contours), shared
 *  between autoKern's pair loop and autoSpace's per-glyph pass exactly like
 *  `cachedInkContours` already is. */
export function cachedInkIndex(outline: GlyphOutline, steps: number = INK_CONTOUR_STEPS): InkIndex {
  const cached = inkIndexCache.get(outline);
  if (cached) return cached;
  const contours = cachedInkContours(outline, steps);
  const index = buildInkIndex(contours);
  inkIndexCache.set(outline, index);
  return index;
}

/** Indexed equivalent of `inkExtentAtY` — same result for the same query,
 *  found by walking only the one bin `y` falls into instead of every
 *  polygon's every edge. See `buildInkIndex`'s doc comment for why this
 *  can never change which crossing wins the min/max. */
export function inkExtentAtYIndexed(index: InkIndex, y: number): { min: number; max: number } | null {
  const binIdx = Math.min(index.bins.length - 1, Math.max(0, Math.floor((y - index.minY) / index.binSize)));
  const bin = index.bins[binIdx];
  let min = Infinity;
  let max = -Infinity;
  let found = false;

  for (const e of bin) {
    if (y >= e.yLo && y < e.yHi) {
      const x = e.ax + ((y - e.ay) / (e.by - e.ay)) * (e.bx - e.ax);
      found = true;
      if (x < min) min = x;
      if (x > max) max = x;
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

  // Resolved (and bin-indexed) once per glyph, cached across the whole
  // auto-kern pass (see `cachedInkIndex`), then reused for every scanline
  // below — both the accuracy fix (real stroke geometry, not a centerline
  // approximation) and what keeps an n² alphabet pass affordable. Each
  // query below only walks the one height-bin it falls into rather than
  // every edge of the glyph (see `inkExtentAtYIndexed`'s doc comment) —
  // same crossings found, same gap values, just fewer edges checked to
  // find them.
  const leftIndex = cachedInkIndex(l.outline);
  const rightIndex = cachedInkIndex(r.outline);

  const gapAt = (y: number): number | null => {
    const leftInk = inkExtentAtYIndexed(leftIndex, y);
    const rightInk = inkExtentAtYIndexed(rightIndex, y);
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

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// How long a chunk is allowed to keep the main thread busy before it MUST
// yield, regardless of how many pairs that turned out to be. A fixed pair
// COUNT (the old `CHUNK_SIZE = 400`) assumes every pair costs about the
// same — true for simple pen/shape glyphs, false for brush glyphs (Rough/Oil
// Brush strokes resolve real stroke geometry, including up to ~220 pitting
// holes per stroke; see `brushOutlineContours`). A font mixing a few heavy
// brush glyphs into an otherwise light alphabet could blow well past a
// fixed count's assumed per-pair cost and freeze the tab for multiple
// seconds in a single chunk before ever reaching the yield check — this is
// what read as "lag sangat lambat" when re-running Auto Kern/Auto Metrik on
// an existing project. A TIME budget yields as soon as the browser has
// actually been busy too long, however few or many pairs that took.
const YIELD_BUDGET_MS = 12; // roughly one animation frame

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
  let chunkStart = now();

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

      if (now() - chunkStart >= YIELD_BUDGET_MS) {
        onProgress?.(total > 0 ? processed / total : 1);
        await yieldToBrowser();
        chunkStart = now();
      }
    }
  }

  onProgress?.(1);
  return { pairs, manual, processed, updated, preservedManual };
}
