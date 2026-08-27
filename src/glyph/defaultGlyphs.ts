import type { Glyph, GlyphGroup, GlyphMap } from "@/types/glyph";
import { emptyOutline } from "@/types/geometry";

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const LOWER = "abcdefghijklmnopqrstuvwxyz".split("");
const DIGITS = "0123456789".split("");
const PUNCT = ".,:;!?'\"-–—()[]{}/\\@#&*_%".split("");
const SYMBOLS = "+=<>~^$€£¥§©®™°|".split("");

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
  const cls = widthClassFor(char) ?? { advanceWidth: 600, lsb: 60, rsb: 60 }; // NORMAL: everything not called out above.
  return {
    advanceWidth: Math.round(cls.advanceWidth * upmScale),
    lsb: Math.round(cls.lsb * upmScale),
    rsb: Math.round(cls.rsb * upmScale),
  };
}

export const GLYPH_GROUPS: GlyphGroup[] = [
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
export function getOrderedChars(glyphs: GlyphMap): string[] {
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
