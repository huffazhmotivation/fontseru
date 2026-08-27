import type { Glyph, GlyphMap } from "@/types/glyph";
import { hasOutline } from "@/types/glyph";
import type { FontMetrics } from "@/types/font";
import { outlineBounds, translateObject, cloneObjectWithNewIds } from "@/editor/objectOps";
import { standardGlyphMetrics } from "./defaultGlyphs";

/**
 * Multilingual Glyphs composer.
 *
 * Builds common accented Latin letters (and a couple of arithmetic symbols)
 * purely by REPOSITIONING clones of already-drawn base + mark outlines —
 * never redrawing or reshaping anything. A composite is only produced when
 * every glyph it needs already has real ink (`hasOutline`); anything that
 * can't be formed yet is left alone so the user's own drawing is what
 * ultimately defines the mark's shape.
 *
 * This intentionally reuses `Glyph.components` (already declared in
 * types/glyph.ts as "an architectural placeholder for composite glyphs" —
 * unused everywhere else in the app) to record the recipe, so re-running
 * the composer can tell a glyph is one of ours and never double-creates or
 * clobbers a hand-drawn glyph of the same character.
 */

type DiacriticPlacement = "capHeight" | "xHeight" | "below";

interface DiacriticRecipe {
  char: string;
  unicode: number;
  base: string;
  mark: string;
  placement: DiacriticPlacement;
}

// Mark characters most fonts won't have drawn yet — registered as empty
// placeholder slots (same as any other undrawn default glyph) so the user
// can draw them once, then every recipe using that mark becomes available.
export const MULTILINGUAL_MARK_SLOTS: { char: string; unicode: number }[] = [
  { char: "´", unicode: 0x00b4 }, // acute
  { char: "`", unicode: 0x0060 }, // grave
  { char: "¨", unicode: 0x00a8 }, // diaeresis
  { char: "¸", unicode: 0x00b8 }, // cedilla
  { char: "ˇ", unicode: 0x02c7 }, // caron / háček
  { char: "˛", unicode: 0x02db }, // ogonek
  { char: "¯", unicode: 0x00af }, // macron
  { char: "˘", unicode: 0x02d8 }, // breve
  { char: "˙", unicode: 0x02d9 }, // dot above
  { char: "˝", unicode: 0x02dd }, // double acute
];

// Arithmetic symbols that can't be safely formed by repositioning an
// existing letterform (× ÷ would need genuinely new artwork, not a
// reused "x" or "-") — registered as empty slots too so they're at least
// available to draw, without ever being auto-filled with a wrong shape.
export const MULTILINGUAL_SYMBOL_SLOTS: { char: string; unicode: number }[] = [
  { char: "×", unicode: 0x00d7 },
  { char: "÷", unicode: 0x00f7 },
];

// Letters that genuinely need new artwork — no combination of existing
// letterforms + marks reproduces them (a stroke through the bowl, a
// distinct ligature shape, etc.) — registered as empty draw slots for the
// same reason × ÷ are above, just letters instead of symbols. Covers
// Nordic/Icelandic, Polish/Slovak stroke letters, German ß, and the
// Turkish dotted/dotless I pair.
export const MULTILINGUAL_LETTER_SLOTS: { char: string; unicode: number }[] = [
  { char: "Ø", unicode: 0x00d8 },
  { char: "ø", unicode: 0x00f8 },
  { char: "Æ", unicode: 0x00c6 },
  { char: "æ", unicode: 0x00e6 },
  { char: "Œ", unicode: 0x0152 },
  { char: "œ", unicode: 0x0153 },
  { char: "Ð", unicode: 0x00d0 },
  { char: "ð", unicode: 0x00f0 },
  { char: "Þ", unicode: 0x00de },
  { char: "þ", unicode: 0x00fe },
  { char: "Ł", unicode: 0x0141 },
  { char: "ł", unicode: 0x0142 },
  { char: "Đ", unicode: 0x0110 },
  { char: "đ", unicode: 0x0111 },
  { char: "ß", unicode: 0x00df },
  { char: "İ", unicode: 0x0130 }, // Turkish dotted capital I
  { char: "ı", unicode: 0x0131 }, // Turkish dotless lowercase i
];

// base + mark → composite. `^` and `~` (circumflex/tilde) and `°` (ring,
// reused for Å/å) already ship in the default Symbols set, so no extra
// mark slot is needed for those three.
const RECIPES: DiacriticRecipe[] = [
  // Acute
  ...pairs("AEIOUYaeiouy", "´", "acute"),
  // Grave
  ...pairs("AEIOUaeiou", "`", "grave"),
  // Diaeresis
  ...pairs("AEIOUaeiouy", "¨", "diaeresis"),
  // Circumflex (mark already in default Symbols)
  ...pairs("AEIOUaeiou", "^", "circumflex"),
  // Tilde (mark already in default Symbols)
  ...pairs("ANOano", "~", "tilde"),
  // Ring above (mark already in default Symbols, as °)
  ...pairs("Aa", "°", "ring"),
  // Cedilla (below) — Romance/Turkish
  { char: "Ç", unicode: 0x00c7, base: "C", mark: "¸", placement: "below" },
  { char: "ç", unicode: 0x00e7, base: "c", mark: "¸", placement: "below" },
  // Caron / háček — Czech, Slovak, Slovenian, Croatian, Latvian, etc.
  ...pairs("CDELNRSTZcdelnrstz", "ˇ", "caron"),
  // Ogonek (below) — Polish, Lithuanian
  ...pairs("AEae", "˛", "ogonek", "below"),
  // Macron — Latvian, Lithuanian, Maori, romanized Japanese
  ...pairs("AEIOUaeiou", "¯", "macron"),
  // Breve — Romanian, Turkish, Esperanto
  ...pairs("Aa", "˘", "breve"),
  // Dot above — Polish, Maltese, Lithuanian, Turkish
  ...pairs("CEGZcegz", "˙", "dotabove"),
  // Double acute — Hungarian
  ...pairs("OUou", "˝", "doubleacute"),
];

function accentedCodepoint(base: string, markKind: string): number | null {
  // Precomputed via Unicode NFC composition for the exact base+mark pairs
  // this file uses; kept as a lookup (not String.normalize at runtime)
  // so the recipe table above stays the single source of truth.
  const TABLE: Record<string, Record<string, number>> = {
    acute: { A: 0xc1, E: 0xc9, I: 0xcd, O: 0xd3, U: 0xda, Y: 0xdd, a: 0xe1, e: 0xe9, i: 0xed, o: 0xf3, u: 0xfa, y: 0xfd },
    grave: { A: 0xc0, E: 0xc8, I: 0xcc, O: 0xd2, U: 0xd9, a: 0xe0, e: 0xe8, i: 0xec, o: 0xf2, u: 0xf9 },
    diaeresis: { A: 0xc4, E: 0xcb, I: 0xcf, O: 0xd6, U: 0xdc, a: 0xe4, e: 0xeb, i: 0xef, o: 0xf6, u: 0xfc, y: 0xff },
    circumflex: { A: 0xc2, E: 0xca, I: 0xce, O: 0xd4, U: 0xdb, a: 0xe2, e: 0xea, i: 0xee, o: 0xf4, u: 0xfb },
    tilde: { A: 0xc3, N: 0xd1, O: 0xd5, a: 0xe3, n: 0xf1, o: 0xf5 },
    ring: { A: 0xc5, a: 0xe5 },
    // Latin Extended-A additions below (Central/Eastern European, Baltic,
    // Nordic-adjacent, Hungarian, Turkish).
    caron: {
      C: 0x010c, c: 0x010d, D: 0x010e, d: 0x010f, E: 0x011a, e: 0x011b,
      L: 0x013d, l: 0x013e, N: 0x0147, n: 0x0148, R: 0x0158, r: 0x0159,
      S: 0x0160, s: 0x0161, T: 0x0164, t: 0x0165, Z: 0x017d, z: 0x017e,
    },
    ogonek: { A: 0x0104, a: 0x0105, E: 0x0118, e: 0x0119 },
    macron: {
      A: 0x0100, a: 0x0101, E: 0x0112, e: 0x0113, I: 0x012a, i: 0x012b,
      O: 0x014c, o: 0x014d, U: 0x016a, u: 0x016b,
    },
    breve: { A: 0x0102, a: 0x0103 },
    dotabove: { C: 0x010a, c: 0x010b, E: 0x0116, e: 0x0117, G: 0x0120, g: 0x0121, Z: 0x017b, z: 0x017c },
    doubleacute: { O: 0x0150, o: 0x0151, U: 0x0170, u: 0x0171 },
  };
  return TABLE[markKind]?.[base] ?? null;
}

function pairs(
  bases: string,
  markChar: string,
  markKind: string,
  placementOverride?: DiacriticPlacement
): DiacriticRecipe[] {
  const out: DiacriticRecipe[] = [];
  for (const base of bases) {
    const unicode = accentedCodepoint(base, markKind);
    if (unicode === null) continue;
    const isLower = base === base.toLowerCase() && base !== base.toUpperCase();
    out.push({
      char: String.fromCodePoint(unicode),
      unicode,
      base,
      mark: markChar,
      placement: placementOverride ?? (isLower ? "xHeight" : "capHeight"),
    });
  }
  return out;
}

export interface MultilingualResult {
  glyphs: GlyphMap;
  created: number;
  markSlotsAdded: number;
  symbolSlotsAdded: number;
  letterSlotsAdded: number;
  skippedExisting: number;
}

function emptySlotGlyph(char: string, unicode: number, template: Glyph | undefined, upm: number): Glyph {
  // Falls back to the same shape-category defaults as a brand-new font
  // (see standardGlyphMetrics) instead of one flat number, so a narrow
  // slot glyph doesn't inherit "a"'s wider metrics just because there was
  // no better template to copy.
  const fallback = standardGlyphMetrics(char, upm);
  return {
    char,
    unicode,
    category: "multilingual",
    advanceWidth: template?.advanceWidth ?? fallback.advanceWidth,
    lsb: template?.lsb ?? fallback.lsb,
    rsb: template?.rsb ?? fallback.rsb,
    outline: { objects: [] },
    components: [],
  };
}

function composeOne(base: Glyph, mark: Glyph, recipe: DiacriticRecipe, metrics: FontMetrics): Glyph | null {
  const baseBounds = outlineBounds(base.outline);
  const markBounds = outlineBounds(mark.outline);
  if (!baseBounds || !markBounds) return null;

  const gap = metrics.unitsPerEm * 0.02;
  const baseCenterX = (baseBounds.minX + baseBounds.maxX) / 2;
  const markCenterX = (markBounds.minX + markBounds.maxX) / 2;
  const dx = baseCenterX - markCenterX;
  const dy =
    recipe.placement === "below"
      ? metrics.baseline - markBounds.maxY
      : (recipe.placement === "capHeight" ? metrics.capHeight : metrics.xHeight) + gap - markBounds.minY;

  const baseObjects = base.outline.objects.map((o) => cloneObjectWithNewIds(o));
  const markObjects = mark.outline.objects.map((o) => translateObject(cloneObjectWithNewIds(o), dx, dy));

  return {
    char: recipe.char,
    unicode: recipe.unicode,
    category: "multilingual",
    advanceWidth: base.advanceWidth,
    lsb: base.lsb,
    rsb: base.rsb,
    outline: { objects: [...baseObjects, ...markObjects] },
    components: [recipe.base, recipe.mark],
  };
}

/**
 * Pure function: given the current Regular glyph map + font metrics,
 * returns an updated map with every composable multilingual glyph added,
 * plus empty placeholder slots for marks/symbols that don't exist yet.
 * Never overwrites a glyph that already has an outline (hand-drawn or
 * composed earlier) — safe to call repeatedly with zero duplicates.
 */
export function composeMultilingualGlyphs(glyphs: GlyphMap, metrics: FontMetrics): MultilingualResult {
  const next: GlyphMap = { ...glyphs };
  let created = 0;
  let markSlotsAdded = 0;
  let symbolSlotsAdded = 0;
  let letterSlotsAdded = 0;
  let skippedExisting = 0;

  for (const slot of MULTILINGUAL_MARK_SLOTS) {
    if (!next[slot.char]) {
      next[slot.char] = emptySlotGlyph(slot.char, slot.unicode, next["a"], metrics.unitsPerEm);
      markSlotsAdded++;
    }
  }
  for (const slot of MULTILINGUAL_SYMBOL_SLOTS) {
    if (!next[slot.char]) {
      next[slot.char] = emptySlotGlyph(slot.char, slot.unicode, next["a"], metrics.unitsPerEm);
      symbolSlotsAdded++;
    }
  }
  for (const slot of MULTILINGUAL_LETTER_SLOTS) {
    if (!next[slot.char]) {
      next[slot.char] = emptySlotGlyph(slot.char, slot.unicode, next["a"], metrics.unitsPerEm);
      letterSlotsAdded++;
    }
  }

  for (const recipe of RECIPES) {
    const existing = next[recipe.char];
    if (existing && hasOutline(existing)) {
      skippedExisting++;
      continue;
    }
    const base = next[recipe.base];
    const mark = next[recipe.mark];
    if (!base || !hasOutline(base)) continue;
    if (!mark || !hasOutline(mark)) continue;
    const composite = composeOne(base, mark, recipe, metrics);
    if (!composite) continue;
    next[recipe.char] = composite;
    created++;
  }

  return { glyphs: next, created, markSlotsAdded, symbolSlotsAdded, letterSlotsAdded, skippedExisting };
}
