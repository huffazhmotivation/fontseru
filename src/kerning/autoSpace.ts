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
const OPTICAL_SAMPLES: number = 16;
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

const WORD_SPACE_RATIO = 0.45; // NORMAL-class default advance (600) * 0.45 = unitsPerEm * 0.27 — matches the app's existing fallback exactly, so a freshly-started font's "Auto" suggestion doesn't jump.
const WORD_SPACE_MIN_RATIO = 0.15; // never suggest a space so tight words visually merge
const WORD_SPACE_MAX_RATIO = 0.5; // never suggest a space so wide it reads as a tab

/**
 * Suggests a single, consistent inter-word space width ("Word Spacing") for
 * the whole font, instead of leaving it as one flat default that ignores
 * how wide this particular typeface's letters actually are — a bold or
 * wide display face needs a visibly bigger space than a light condensed
 * one, or the gap between words reads as too tight/too loose relative to
 * the letters around it.
 *
 * The estimate is the average advance width of the lowercase letters the
 * user has actually drawn (lowercase is what dominates running text),
 * scaled down by WORD_SPACE_RATIO — a word space reads as "one blank
 * letter's worth of room," not a full extra letter. Falls back to
 * uppercase, then to any drawn glyph, then to the same flat
 * `unitsPerEm * 0.27` the rest of the app already uses when nothing has
 * been drawn yet, so an empty project still gets a sensible number.
 */
export function suggestWordSpacing(glyphs: GlyphMap, metrics: FontMetrics): number {
  const fallback = metrics.unitsPerEm * 0.27;

  const drawnAdvances = (chars: string): number[] =>
    chars
      .split("")
      .map((ch) => glyphs[ch])
      .filter((g): g is Glyph => !!g && hasOutline(g) && g.advanceWidth > 0)
      .map((g) => g.advanceWidth);

  let sample = drawnAdvances("abcdefghijklmnopqrstuvwxyz");
  if (sample.length === 0) sample = drawnAdvances("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  if (sample.length === 0) {
    sample = Object.values(glyphs)
      .filter((g) => hasOutline(g) && g.advanceWidth > 0)
      .map((g) => g.advanceWidth);
  }
  if (sample.length === 0) return Math.round(fallback);

  const avgAdvance = sample.reduce((sum, w) => sum + w, 0) / sample.length;
  const raw = avgAdvance * WORD_SPACE_RATIO;

  const min = metrics.unitsPerEm * WORD_SPACE_MIN_RATIO;
  const max = metrics.unitsPerEm * WORD_SPACE_MAX_RATIO;
  return Math.round(Math.min(max, Math.max(min, raw)));
}

export interface AutoSpaceResult {
  glyphs: GlyphMap;
  updated: number;
  skipped: number;
  /** Glyphs left untouched because they're in `excludeChars` (already manually kerned). */
  skippedManual: number;
}

/** Yields to the browser so a large glyph set doesn't freeze the UI thread. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const SPACE_CHUNK_SIZE = 60; // glyphs processed per tick before yielding + reporting progress

/**
 * Applies `suggestGlyphSidebearings` across every glyph in `glyphs`.
 * `applyPatch` performs the actual LSB/RSB mutation (translating the
 * outline for LSB, resizing the advance for RSB) — kept as an injected
 * callback so this stays a pure function with no dependency on the app
 * store's glyph-metric semantics; the store supplies its own
 * `applyGlyphMetricPatch` here.
 *
 * `excludeChars`, when given, skips re-spacing any glyph in the set —
 * used to leave glyphs the user has already hand-tuned kerning for
 * (a manual kerning pair) untouched, since shifting their LSB/RSB out
 * from under an existing manual kern value is what causes collisions.
 *
 * Runs in chunks (yielding back to the browser between them), the same way
 * `autoKernAllAvailablePairs` does, so a caller can pass `onProgress` to
 * drive a real, non-fake loading indicator on the triggering button.
 */
export async function autoSpaceAllGlyphs(
  glyphs: GlyphMap,
  metrics: FontMetrics,
  applyPatch: (glyph: Glyph, patch: GlyphSpacingSuggestion) => Glyph,
  excludeChars?: Set<string>,
  onProgress?: (fraction: number) => void
): Promise<AutoSpaceResult> {
  let next = glyphs;
  let updated = 0;
  let skipped = 0;
  let skippedManual = 0;

  const entries = Object.entries(glyphs);
  const total = entries.length;
  let processed = 0;
  let sinceYield = 0;

  for (const [char, glyph] of entries) {
    processed++;
    if (excludeChars?.has(char)) {
      skippedManual++;
    } else {
      const suggestion = suggestGlyphSidebearings(glyph, metrics);
      if (!suggestion) {
        skipped++;
      } else if (glyph.lsb !== suggestion.lsb || glyph.rsb !== suggestion.rsb) {
        if (next === glyphs) next = { ...glyphs };
        next[char] = applyPatch(glyph, suggestion);
        updated++;
      }
    }

    sinceYield++;
    if (sinceYield >= SPACE_CHUNK_SIZE) {
      sinceYield = 0;
      onProgress?.(total > 0 ? processed / total : 1);
      await yieldToBrowser();
    }
  }

  onProgress?.(1);
  return { glyphs: next, updated, skipped, skippedManual };
}
