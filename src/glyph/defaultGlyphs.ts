import type { Glyph, GlyphGroup, GlyphMap } from "@/types/glyph";
import { emptyOutline } from "@/types/geometry";

const SPACE = [" "];
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const LOWER = "abcdefghijklmnopqrstuvwxyz".split("");
const DIGITS = "0123456789".split("");
const PUNCT = ".,:;!?'\"-–—()[]{}/\\@#&*_%".split("");
// Math-operator symbols (Unicode Mathematical Operators block, not the
// Greek-letter lookalikes — e.g. Σ/Π/Δ here are U+2211/220F/2206, not the
// Greek capitals) so a font's default glyph set can actually render them
// instead of silently falling back to the system font wherever they're
// typed (Test Lab's free-type "Type Test" box surfaces this immediately).
const MATH_SYMBOLS = "∞√Σ∏Δ∂∫±≠≈≤≥".split("");
const SYMBOLS = "+=<>~^$€£¥§©®™°|".split("").concat(MATH_SYMBOLS);

/**
 * Default advance width / LSB / RSB for a brand-new font, by glyph shape
 * category — not one flat number for every character. This follows the
 * width-class convention every mainstream type design tool (Glyphs,
 * FontLab, FontForge) starts a new font's sidebearings from: stem letters
 * (I, l, i...) are visibly narrower than average, round letters (O, C, e...)
 * get tighter optical sidebearings than straight-sided letters of the same
 * width (a round outline already reads as having more surrounding space
 * than a flat one at the same measured distance), and a couple of
 * genuinely wide letters (M, W) get more room. Digits are deliberately
 * kept in NORMAL (all the same width) — tabular/lining figures that align
 * in a column is the standard default, not width-per-digit.
 *
 * Every number below is expressed at 1000 UPM and scaled by `upmScale` for
 * fonts created at a different unitsPerEm, so the same proportions hold
 * regardless of the project's UPM.
 */
const WIDTH_CLASSES: { chars: string; advanceWidth: number; lsb: number; rsb: number }[] = [
  // Thin vertical-stem letters/marks — the classic "I is narrower than A" case.
  { chars: "Iijl'\"!|", advanceWidth: 280, lsb: 90, rsb: 90 },
  // Narrow letters and small punctuation that sits with a lot of white space.
  { chars: "ftrJ.,:;-–—()[]{}/\\", advanceWidth: 380, lsb: 70, rsb: 70 },
  // Round/curved letterforms: tighter sidebearing than a straight-sided
  // letter of the same advance, per standard optical-correction practice.
  { chars: "OQCGDocaeq", advanceWidth: 620, lsb: 44, rsb: 44 },
  // Genuinely wide letters and a few wide symbols.
  { chars: "MWmw%@&#", advanceWidth: 760, lsb: 70, rsb: 70 },
];

function widthClassFor(char: string) {
  return WIDTH_CLASSES.find((c) => c.chars.includes(char));
}

/**
 * Standard default metrics for a single character, used both when building
 * a brand-new font's glyph set and as the fallback for any glyph created
 * later with no better template to copy metrics from (e.g. an unmapped
 * multilingual character). `upm` lets the same width-class proportions
 * apply at any unitsPerEm, not just the 1000 these numbers were tuned at.
 */
export function standardGlyphMetrics(char: string, upm = 1000): { advanceWidth: number; lsb: number; rsb: number } {
  const upmScale = upm / 1000;
  // The space glyph has no outline, so sidebearings are meaningless — its
  // advance IS the inter-word gap. 270/1000 matches fallbackAdvance's own
  // 0.27 * unitsPerEm default (editor/textLayout.ts) so a freshly-created
  // font's live preview and its exported OTF agree on word spacing from
  // the start, with no synthetic-space fallback (utils/fontIO.ts) needed.
  if (char === " ") return { advanceWidth: Math.round(270 * upmScale), lsb: 0, rsb: 0 };
  const cls = widthClassFor(char) ?? { advanceWidth: 600, lsb: 60, rsb: 60 }; // NORMAL: everything not called out above.
  return {
    advanceWidth: Math.round(cls.advanceWidth * upmScale),
    lsb: Math.round(cls.lsb * upmScale),
    rsb: Math.round(cls.rsb * upmScale),
  };
}

export const GLYPH_GROUPS: GlyphGroup[] = [
  // Encoded first and separately from Punctuation — it has no outline to
  // draw (its advance width IS the whole glyph), and QA Check specifically
  // looks for it at U+0020 (see utils/unicodeValidator.ts), so it shouldn't
  // get buried in a group full of drawable marks.
  { id: "spacing", label: "Spacing", chars: SPACE },
  { id: "upper", label: "Uppercase", chars: UPPER },
  { id: "lower", label: "Lowercase", chars: LOWER },
  { id: "digits", label: "Numbers", chars: DIGITS },
  { id: "punct", label: "Punctuation", chars: PUNCT },
  { id: "symbols", label: "Symbols", chars: SYMBOLS },
  // Populated on demand by "+ Multilingual Glyphs" (src/glyph/multilingual.ts).
  // Starts empty like every other group's base list — glyphs show up here
  // via the same "extras by category" mechanism already used for imported
  // chars, so no other file needs to know this group exists.
  { id: "multilingual", label: "Multilingual", chars: [] },
  // Populated on demand by the Feature Builder (src/glyph/featureGlyphs.ts):
  // every ligature target, alternate, and swash glyph the user creates gets
  // category "feature" and lands here — in its own list, separate from
  // "Symbols" — via the same "extras by category" mechanism above.
  { id: "feature", label: "Feature", chars: [] },
];

/**
 * Flattened glyph order the whole app agrees on: Uppercase → Lowercase →
 * Numbers → Punctuation → Symbols, each group's own imported extras sorted
 * by code point, followed by anything left over. Mirrors the grouping
 * GlyphNav already renders (see its `filteredGroups`), just without the
 * search-query filter, so Prev/Next glyph navigation always agrees with
 * what's shown in the glyph list.
 */
// Ordering depends only on the key set + each glyph's category/unicode, which
// almost never change during editing. Every stroke commit produces a new map
// though, so cache by identity and, failing that, reuse the previous order
// when an O(n) check shows nothing order-relevant changed (avoids re-sorting
// thousands of keys several times per commit).
const orderByMap = new WeakMap<GlyphMap, string[]>();
let lastOrderMap: GlyphMap | null = null;
let lastOrder: string[] = [];

function sameOrderInputs(prev: GlyphMap, next: GlyphMap, prevCount: number): boolean {
  let count = 0;
  for (const ch in next) {
    count++;
    const a = prev[ch];
    const b = next[ch];
    if (!a) return false;
    if (a !== b && (a.category !== b.category || a.unicode !== b.unicode)) return false;
  }
  return count === prevCount;
}

export function getOrderedChars(glyphs: GlyphMap): string[] {
  const hit = orderByMap.get(glyphs);
  if (hit) return hit;
  if (lastOrderMap && sameOrderInputs(lastOrderMap, glyphs, lastOrder.length)) {
    orderByMap.set(glyphs, lastOrder);
    lastOrderMap = glyphs;
    return lastOrder;
  }
  const ordered = computeOrderedChars(glyphs);
  orderByMap.set(glyphs, ordered);
  lastOrderMap = glyphs;
  lastOrder = ordered;
  return ordered;
}

function computeOrderedChars(glyphs: GlyphMap): string[] {
  const baseChars = new Set(GLYPH_GROUPS.flatMap((g) => g.chars));
  const extrasByCategory = new Map<string, string[]>();
  for (const [ch, glyph] of Object.entries(glyphs)) {
    if (baseChars.has(ch)) continue;
    const arr = extrasByCategory.get(glyph.category) ?? [];
    arr.push(ch);
    extrasByCategory.set(glyph.category, arr);
  }
  const ordered: string[] = [];
  for (const group of GLYPH_GROUPS) {
    for (const ch of group.chars) if (glyphs[ch]) ordered.push(ch);
    const extras = (extrasByCategory.get(group.id) ?? []).sort((a, b) => glyphs[a].unicode - glyphs[b].unicode);
    ordered.push(...extras);
  }
  const assigned = new Set(ordered);
  const remaining = Object.keys(glyphs)
    .filter((ch) => !assigned.has(ch))
    .sort((a, b) => glyphs[a].unicode - glyphs[b].unicode);
  ordered.push(...remaining);
  return ordered;
}

export function buildDefaultGlyphs(): GlyphMap {
  const map: GlyphMap = {};
  for (const group of GLYPH_GROUPS) {
    for (const ch of group.chars) {
      const { advanceWidth, lsb, rsb } = standardGlyphMetrics(ch);
      const glyph: Glyph = {
        char: ch,
        unicode: ch.codePointAt(0) ?? 0,
        category: group.id,
        advanceWidth,
        lsb,
        rsb,
        outline: emptyOutline(),
        components: [],
      };
      map[ch] = glyph;
    }
  }
  return map;
}

/**
 * Migration for glyph maps saved before the space glyph became part of
 * `buildDefaultGlyphs()` (older IndexedDB autosaves, older .fs project
 * files, and any imported .ttf/.otf that genuinely has no space glyph
 * of its own). Returns `glyphs` unchanged — same reference — when a real
 * U+0020 mapping already exists, so calling this on every load is cheap
 * and never overwrites a space a user already drew or an imported font
 * already shipped.
 */
export function ensureSpaceGlyph(glyphs: GlyphMap, unitsPerEm: number): GlyphMap {
  const hasSpace = glyphs[" "]?.unicode === 0x20 || Object.values(glyphs).some((g) => g.unicode === 0x20 || g.unicodes?.includes(0x20));
  if (hasSpace) return glyphs;
  const { advanceWidth, lsb, rsb } = standardGlyphMetrics(" ", unitsPerEm);
  return {
    ...glyphs,
    " ": { char: " ", unicode: 0x20, category: "spacing", advanceWidth, lsb, rsb, outline: emptyOutline(), components: [] },
  };
}

/**
 * Migration for glyph maps saved before MATH_SYMBOLS (∞ √ Σ ∏ Δ ∂ ∫ ± ≠ ≈
 * ≤ ≥) joined the base "symbols" group. Same shape as `ensureSpaceGlyph`:
 * only ADDS a char that's genuinely missing (checked by unicode, not just
 * the map key, so it never double-adds a glyph already reachable under a
 * different key) and never touches one the user already has — imported
 * font, older autosave, or older .fs project file alike.
 */
export function ensureDefaultSymbols(glyphs: GlyphMap, unitsPerEm: number): GlyphMap {
  const haveUnicodes = new Set(
    Object.values(glyphs).flatMap((g) => [g.unicode, ...(g.unicodes ?? [])])
  );
  const missing = MATH_SYMBOLS.filter((ch) => !haveUnicodes.has(ch.codePointAt(0) ?? 0) && !glyphs[ch]);
  if (missing.length === 0) return glyphs;
  const additions: GlyphMap = {};
  for (const ch of missing) {
    const { advanceWidth, lsb, rsb } = standardGlyphMetrics(ch, unitsPerEm);
    additions[ch] = { char: ch, unicode: ch.codePointAt(0) ?? 0, category: "symbols", advanceWidth, lsb, rsb, outline: emptyOutline(), components: [] };
  }
  return { ...glyphs, ...additions };
}

/**
 * Migration/self-heal for glyph maps that are missing part of FontSeru's
 * standard glyph inventory — Numbers, Punctuation, base Symbols, or even
 * letters. This happens for any project that did not start from
 * `buildDefaultGlyphs()`: an imported .ttf/.otf only carries the glyphs that
 * font happened to ship (e.g. a font with no digits), and that map is then
 * saved into the .fs project and autosave as-is. The glyph list hides any
 * group with zero glyphs, so the whole "Numbers" section simply vanished.
 *
 * Same contract as `ensureSpaceGlyph` / `ensureDefaultSymbols`: it only ADDS
 * an empty, ready-to-draw slot for a standard character that is genuinely
 * absent (checked by code point, not just the map key, so a glyph reachable
 * under another key is never duplicated) and never touches a glyph that
 * already exists. Returns `glyphs` unchanged — same reference — when nothing
 * is missing, so calling it on every load is cheap.
 */
export function ensureDefaultGlyphSlots(glyphs: GlyphMap, unitsPerEm: number): GlyphMap {
  const haveUnicodes = new Set<number>();
  for (const g of Object.values(glyphs)) {
    haveUnicodes.add(g.unicode);
    for (const u of g.unicodes ?? []) haveUnicodes.add(u);
  }
  let additions: GlyphMap | null = null;
  for (const group of GLYPH_GROUPS) {
    for (const ch of group.chars) {
      const code = ch.codePointAt(0) ?? 0;
      if (glyphs[ch] || haveUnicodes.has(code)) continue;
      const { advanceWidth, lsb, rsb } = standardGlyphMetrics(ch, unitsPerEm);
      (additions ??= {})[ch] = {
        char: ch,
        unicode: code,
        category: group.id,
        advanceWidth,
        lsb,
        rsb,
        outline: emptyOutline(),
        components: [],
      };
    }
  }
  return additions ? { ...glyphs, ...additions } : glyphs;
}
