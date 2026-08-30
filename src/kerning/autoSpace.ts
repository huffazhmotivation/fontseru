import type { Glyph, GlyphMap } from "@/types/glyph";
import { hasOutline } from "@/types/glyph";
import type { FontMetrics } from "@/types/font";
import { outlineBounds } from "@/editor/objectOps";
import { inkExtentAtY } from "./autoKern";

/**
 * Optical, per-glyph sidebearing suggestions ("Auto Spacing").
 *
 * Auto Kern only ever refines the *gap between two specific glyphs*; it
 * can't fix a glyph whose own LSB/RSB are simply inconsistent with the rest
 * of the font (e.g. hand-drawn glyphs that each ended up with wildly
 * different left/right margins). This gives every glyph a shared baseline
 * margin instead, so the whole alphabet reads as one consistent typeface
 * before kerning does its finer, pair-specific work on top.
 *
 * Like autoKern's own optical profile, this samples several horizontal
 * scanlines through the glyph's own ink height and compares the *average*
 * ink edge to the bounding-box edge. A straight stem (H, I, l) recedes
 * ~0 from its own bbox at every height; a curve or diagonal (O, C, V, W, A)
 * recedes more through the middle than at its single extreme touch-point.
 * That recession is traded back into a tighter mechanical sidebearing, so
 * round/diagonal letters don't end up looking airier than straight-stem
 * ones once every glyph shares the same nominal margin — the same optical
 * compensation a type designer applies by eye.
 */
const SIDE_MARGIN_RATIO = 0.07; // comfortable single-side optical margin, as a fraction of UPM
const MIN_MARGIN_RATIO = 0.015; // never squeeze a margin away entirely
const OPTICAL_SAMPLES = 16;
const OPTICAL_COMPENSATION = 0.6; // how much of the recession to trade back

export interface GlyphSpacingSuggestion {
  lsb: number;
  rsb: number;
}

export function suggestGlyphSidebearings(glyph: Glyph, metrics: FontMetrics): GlyphSpacingSuggestion | null {
  if (!hasOutline(glyph)) return null;
  const bounds = outlineBounds(glyph.outline);
  if (!bounds) return null;

  const target = metrics.unitsPerEm * SIDE_MARGIN_RATIO;
  const minMargin = metrics.unitsPerEm * MIN_MARGIN_RATIO;

  let leftRecessSum = 0;
  let rightRecessSum = 0;
  let samples = 0;
  for (let i = 0; i < OPTICAL_SAMPLES; i++) {
    const t = OPTICAL_SAMPLES === 1 ? 0.5 : i / (OPTICAL_SAMPLES - 1);
    const y = bounds.minY + t * (bounds.maxY - bounds.minY);
    const ink = inkExtentAtY(glyph.outline, y);
    if (!ink) continue;
    leftRecessSum += Math.max(0, ink.min - bounds.minX);
    rightRecessSum += Math.max(0, bounds.maxX - ink.max);
    samples++;
  }

  const leftRecess = samples > 0 ? leftRecessSum / samples : 0;
  const rightRecess = samples > 0 ? rightRecessSum / samples : 0;

  const lsb = Math.round(Math.max(minMargin, target - leftRecess * OPTICAL_COMPENSATION));
  const rsb = Math.round(Math.max(minMargin, target - rightRecess * OPTICAL_COMPENSATION));

  return { lsb, rsb };
}

export interface AutoSpaceResult {
  glyphs: GlyphMap;
  updated: number;
  skipped: number;
}

/**
 * Applies `suggestGlyphSidebearings` across every glyph in `glyphs`.
 * `applyPatch` performs the actual LSB/RSB mutation (translating the
 * outline for LSB, resizing the advance for RSB) — kept as an injected
 * callback so this stays a pure function with no dependency on the app
 * store's glyph-metric semantics; the store supplies its own
 * `applyGlyphMetricPatch` here.
 */
export function autoSpaceAllGlyphs(
  glyphs: GlyphMap,
  metrics: FontMetrics,
  applyPatch: (glyph: Glyph, patch: GlyphSpacingSuggestion) => Glyph
): AutoSpaceResult {
  let next = glyphs;
  let updated = 0;
  let skipped = 0;

  for (const [char, glyph] of Object.entries(glyphs)) {
    const suggestion = suggestGlyphSidebearings(glyph, metrics);
    if (!suggestion) {
      skipped++;
      continue;
    }
    if (glyph.lsb === suggestion.lsb && glyph.rsb === suggestion.rsb) continue;

    if (next === glyphs) next = { ...glyphs };
    next[char] = applyPatch(glyph, suggestion);
    updated++;
  }

  return { glyphs: next, updated, skipped };
}
