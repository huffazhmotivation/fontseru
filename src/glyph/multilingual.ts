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

type DiacriticPlacement = "capHeight" | "xHeight" | "below" | "aboveGlyph";

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
  // Vietnamese tone marks — previously missing entirely, which is why
  // hook-above/dot-below vowels (ả ẻ ỉ ỏ ủ ỷ / ạ ẹ ị ọ ụ ỵ) and every
  // layered combination built on top of them (ẩ ể ổ / ậ ệ ộ / ẳ / ặ /
  // ở / ợ / ử / ự, etc.) never had a mark to compose from.
  { char: "\u0309", unicode: 0x0309 }, // combining hook above
  { char: "\u0323", unicode: 0x0323 }, // combining dot below
];

// Arithmetic symbols that can't be safely formed by repositioning an
// existing letterform (× ÷ would need genuinely new artwork, not a
// reused "x" or "-"), plus punctuation marks in the standard "minimum
// recommended character set" most type foundries/marketplaces check for
// (Monotype's submission review flags exactly these as missing if a font
// doesn't have them) that FontSeru's default Punctuation/Symbols groups
// don't include — registered as empty slots too so they're at least
// available to draw, without ever being auto-filled with a wrong shape.
export const MULTILINGUAL_SYMBOL_SLOTS: { char: string; unicode: number }[] = [
  { char: "×", unicode: 0x00d7 },
  { char: "÷", unicode: 0x00f7 },
  { char: "¢", unicode: 0x00a2 }, // cent sign
  { char: "†", unicode: 0x2020 }, // dagger
  { char: "•", unicode: 0x2022 }, // bullet
  { char: "·", unicode: 0x00b7 }, // middle dot
  { char: "«", unicode: 0x00ab }, // left guillemet
  { char: "»", unicode: 0x00bb }, // right guillemet
  { char: "¿", unicode: 0x00bf }, // inverted question mark
  { char: "¡", unicode: 0x00a1 }, // inverted exclamation mark
  { char: "\u2018", unicode: 0x2018 }, // left single curly quote
  { char: "\u2019", unicode: 0x2019 }, // right single curly quote
  { char: "\u201a", unicode: 0x201a }, // single low-9 quote
  { char: "\u201c", unicode: 0x201c }, // left double curly quote
  { char: "\u201d", unicode: 0x201d }, // right double curly quote
  { char: "\u201e", unicode: 0x201e }, // double low-9 quote
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
  // Vietnamese horn letters — the horn is a distinct curl grafted onto the
  // letter's own bowl, not a repositionable mark, so like Ø/Æ/ß above it
  // needs genuine artwork. Without these, no ơ/ư-based tone letter (ớ ờ ở
  // ỡ ợ / ứ ừ ử ữ ự) could ever be composed, since there was no base to
  // compose them from.
  { char: "Ơ", unicode: 0x01a0 },
  { char: "ơ", unicode: 0x01a1 },
  { char: "Ư", unicode: 0x01af },
  { char: "ư", unicode: 0x01b0 },
];

// base + mark → composite. `^` and `~` (circumflex/tilde) and `°` (ring,
// reused for Å/å) already ship in the default Symbols set, so no extra
// mark slot is needed for those three.
const RECIPES: DiacriticRecipe[] = [
  // Acute (vowels + the Polish/Slovak/Sorbian consonants Ć/Ń/Ś/Ź that also
  // take a plain acute — previously missing, which left Polish's own
  // pangram unable to compose ć/ń/ś/ź even though C/N/S/Z and ´ both exist)
  ...pairs("AEIOUYaeiouyCNSZcnsz", "´", "acute"),
  // Grave
  ...pairs("AEIOUaeiou", "`", "grave"),
  // Diaeresis
  ...pairs("AEIOUYaeiouy", "¨", "diaeresis"),
  // Circumflex (mark already in default Symbols)
  ...pairs("AEIOUaeiou", "^", "circumflex"),
  // Tilde (mark already in default Symbols)
  ...pairs("ANOano", "~", "tilde"),
  // Ring above (mark already in default Symbols, as °)
  ...pairs("Aa", "°", "ring"),
  // Cedilla (below) — Romance/Turkish
  { char: "Ç", unicode: 0x00c7, base: "C", mark: "¸", placement: "below" },
  { char: "ç", unicode: 0x00e7, base: "c", mark: "¸", placement: "below" },
  // Turkish also cedillas S (Ş/ş) — previously missing, which left Turkish's
  // own pangram unable to compose ş even though S and ¸ both exist.
  { char: "Ş", unicode: 0x015e, base: "S", mark: "¸", placement: "below" },
  { char: "ş", unicode: 0x015f, base: "s", mark: "¸", placement: "below" },
  // Caron / háček — Czech, Slovak, Slovenian, Croatian, Latvian, etc.
  // Letters without an ascender take the full caron mark as-is.
  ...pairs("CENRSZcenrsz", "ˇ", "caron"),
  // D/d, L/l, T/t have a tall ascender that a full caron would visually
  // collide with, so Czech/Slovak orthography substitutes a small
  // apostrophe-like mark instead (Ď ď, Ľ ľ, Ť ť). Reuses the right single
  // quote already registered as a symbol slot — `markKind` stays "caron"
  // so the Unicode codepoint lookup (accentedCodepoint) is unaffected;
  // only the visual mark and its placement differ. Anchored to the base
  // glyph's own top (not a fixed x-height/cap-height line) since the
  // ascender's actual height varies by design.
  ...pairs("DLTdlt", "\u2019", "caron", "aboveGlyph"),
  // Ogonek (below) — Polish, Lithuanian
  ...pairs("AEae", "˛", "ogonek", "below"),
  // Macron — Latvian, Lithuanian, Maori, romanized Japanese
  ...pairs("AEIOUaeiou", "¯", "macron"),
  // Breve — Romanian, Turkish, Esperanto (G/g added for Turkish ğ/Ğ, the
  // "yumuşak ge" that made Turkish's own pangram fail the same way)
  ...pairs("AaGg", "˘", "breve"),
  // Dot above — Polish, Maltese, Lithuanian, Turkish
  ...pairs("CEGZcegz", "˙", "dotabove"),
  // Double acute — Hungarian
  ...pairs("OUou", "˝", "doubleacute"),

  // --- Vietnamese tone marks -------------------------------------------
  // Layer 1: hook-above / dot-below on the plain vowels (+ y), giving
  // ả ẻ ỉ ỏ ủ ỷ and ạ ẹ ị ọ ụ ỵ.
  ...pairs("AEIOUYaeiouy", "\u0309", "hookabove"),
  ...pairs("AEIOUYaeiouy", "\u0323", "dotbelow", "below"),

  // Layer 2: the same five tones (acute, grave, hook-above, tilde,
  // dot-below) stacked on top of vowels that already carry a circumflex,
  // breve, or horn. Placement is forced to "aboveGlyph" for the
  // above-vowel marks so they sit above the existing circumflex/breve
  // instead of colliding with it at the fixed cap-height/x-height line;
  // dot-below is unaffected by the base's height so it keeps its normal
  // "below" placement.
  ...pairs("ÂÊÔâêôĂăƠơƯư", "´", "acute", "aboveGlyph"), // ấ ế ố ắ ớ ứ (+ caps)
  ...pairs("ÂÊÔâêôĂăƠơƯư", "`", "grave", "aboveGlyph"), // ầ ề ồ ằ ờ ừ
  ...pairs("ÂÊÔâêôĂăƠơƯư", "\u0309", "hookabove", "aboveGlyph"), // ẩ ể ổ ẳ ở ử
  ...pairs("ÂÊÔâêôĂăƠơƯư", "~", "tilde", "aboveGlyph"), // ẫ ễ ỗ ẵ ỡ ữ
  ...pairs("ÂÊÔâêôĂăƠơƯư", "\u0323", "dotbelow", "below"), // ậ ệ ộ ặ ợ ự
];

function accentedCodepoint(base: string, markKind: string): number | null {
  // Precomputed via Unicode NFC composition for the exact base+mark pairs
  // this file uses; kept as a lookup (not String.normalize at runtime)
  // so the recipe table above stays the single source of truth.
  const TABLE: Record<string, Record<string, number>> = {
    acute: {
      A: 0xc1, E: 0xc9, I: 0xcd, O: 0xd3, U: 0xda, Y: 0xdd, a: 0xe1, e: 0xe9, i: 0xed, o: 0xf3, u: 0xfa, y: 0xfd,
      // Polish/Slovak/Sorbian consonants that also take a plain acute.
      C: 0x0106, c: 0x0107, N: 0x0143, n: 0x0144, S: 0x015a, s: 0x015b, Z: 0x0179, z: 0x017a,
      // Vietnamese "sắc" tone stacked on circumflex/breve/horn vowels.
      "\u00c2": 0x1ea4, "\u00ca": 0x1ebe, "\u00d4": 0x1ed0, "\u00e2": 0x1ea5, "\u00ea": 0x1ebf, "\u00f4": 0x1ed1,
      "\u0102": 0x1eae, "\u0103": 0x1eaf, "\u01a0": 0x1eda, "\u01a1": 0x1edb, "\u01af": 0x1ee8, "\u01b0": 0x1ee9,
    },
    grave: {
      A: 0xc0, E: 0xc8, I: 0xcc, O: 0xd2, U: 0xd9, a: 0xe0, e: 0xe8, i: 0xec, o: 0xf2, u: 0xf9,
      // Vietnamese "huyền" tone stacked on circumflex/breve/horn vowels.
      "\u00c2": 0x1ea6, "\u00ca": 0x1ec0, "\u00d4": 0x1ed2, "\u00e2": 0x1ea7, "\u00ea": 0x1ec1, "\u00f4": 0x1ed3,
      "\u0102": 0x1eb0, "\u0103": 0x1eb1, "\u01a0": 0x1edc, "\u01a1": 0x1edd, "\u01af": 0x1eea, "\u01b0": 0x1eeb,
    },
    diaeresis: { A: 0xc4, E: 0xcb, I: 0xcf, O: 0xd6, U: 0xdc, Y: 0x0178, a: 0xe4, e: 0xeb, i: 0xef, o: 0xf6, u: 0xfc, y: 0xff },
    circumflex: { A: 0xc2, E: 0xca, I: 0xce, O: 0xd4, U: 0xdb, a: 0xe2, e: 0xea, i: 0xee, o: 0xf4, u: 0xfb },
    tilde: {
      A: 0xc3, N: 0xd1, O: 0xd5, a: 0xe3, n: 0xf1, o: 0xf5,
      // Vietnamese "ngã" tone stacked on circumflex/breve/horn vowels.
      "\u00c2": 0x1eaa, "\u00ca": 0x1ec4, "\u00d4": 0x1ed6, "\u00e2": 0x1eab, "\u00ea": 0x1ec5, "\u00f4": 0x1ed7,
      "\u0102": 0x1eb4, "\u0103": 0x1eb5, "\u01a0": 0x1ee0, "\u01a1": 0x1ee1, "\u01af": 0x1eee, "\u01b0": 0x1eef,
    },
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
    breve: { A: 0x0102, a: 0x0103, G: 0x011e, g: 0x011f },
    dotabove: { C: 0x010a, c: 0x010b, E: 0x0116, e: 0x0117, G: 0x0120, g: 0x0121, Z: 0x017b, z: 0x017c },
    doubleacute: { O: 0x0150, o: 0x0151, U: 0x0170, u: 0x0171 },
    // Vietnamese "hỏi" tone (hook above): base vowels + the same vowels
    // already wearing a circumflex, breve, or horn.
    hookabove: {
      A: 0x1ea2, E: 0x1eba, I: 0x1ec8, O: 0x1ece, U: 0x1ee6, Y: 0x1ef6,
      a: 0x1ea3, e: 0x1ebb, i: 0x1ec9, o: 0x1ecf, u: 0x1ee7, y: 0x1ef7,
      "\u00c2": 0x1ea8, "\u00ca": 0x1ec2, "\u00d4": 0x1ed4, "\u00e2": 0x1ea9, "\u00ea": 0x1ec3, "\u00f4": 0x1ed5,
      "\u0102": 0x1eb2, "\u0103": 0x1eb3, "\u01a0": 0x1ede, "\u01a1": 0x1edf, "\u01af": 0x1eec, "\u01b0": 0x1eed,
    },
    // Vietnamese "nặng" tone (dot below): base vowels + the same vowels
    // already wearing a circumflex, breve, or horn.
    dotbelow: {
      A: 0x1ea0, E: 0x1eb8, I: 0x1eca, O: 0x1ecc, U: 0x1ee4, Y: 0x1ef4,
      a: 0x1ea1, e: 0x1eb9, i: 0x1ecb, o: 0x1ecd, u: 0x1ee5, y: 0x1ef5,
      "\u00c2": 0x1eac, "\u00ca": 0x1ec6, "\u00d4": 0x1ed8, "\u00e2": 0x1ead, "\u00ea": 0x1ec7, "\u00f4": 0x1ed9,
      "\u0102": 0x1eb6, "\u0103": 0x1eb7, "\u01a0": 0x1ee2, "\u01a1": 0x1ee3, "\u01af": 0x1ef0, "\u01b0": 0x1ef1,
    },
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
      : recipe.placement === "aboveGlyph"
        ? baseBounds.maxY + gap - markBounds.minY
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
