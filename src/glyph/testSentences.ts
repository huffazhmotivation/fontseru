// Shared "one sentence, not A-Z order" preset text for Test Lab AND the
// Production Preview bar (BottomBar's "Preview" toggle). Kept in its own
// module — separate from Test Lab's SpecimenPanel.tsx, which is lazy-loaded
// only when the Test Lab overlay opens — so the always-mounted preview bar
// doesn't have to pull in the rest of the (much heavier) Test Lab bundle
// just to read these strings.

// Straight A-Z / a-z ordering never puts two letters next to each other the
// way real words do, so it can't reveal spacing or kerning problems. This
// is a from-scratch pangram (not the usual "lazy dog" / "liquor jugs" ones
// every font tool reuses) that still covers every letter at least once and
// deliberately strings together WA / AV / TO / LY — the tightest pairs a
// designer usually needs to eyeball.
export const UPPER_TEST = "THE WAVY FOX QUICKLY JAZZED MY BRAVE ZEBRA INTO SIX PROUD KINGDOMS.";
export const LOWER_TEST = "the wavy fox quickly jazzed my brave zebra into six proud kingdoms.";

// Same idea for digits: a raw "0123456789" run never shows how digits sit
// next to each other in real use. This reads like an actual date/price/
// invoice line while still covering every digit at least once.
export const NUMBERS_TEST = "08:47 \u2014 27/11/2026 \u2014 $1,250.75 \u2014 #9163 \u2014 (60%)";

// Punctuation and symbols can't form a literal sentence, so instead of a
// flat space-joined dump of the character set, each mark appears once
// inside ordinary-looking usage so it's easier to judge in context. Every
// character in PUNCT / SYMBOLS (see glyph/defaultGlyphs.ts) appears here at
// least once — update both together if that character set ever changes.
export const PUNCTUATION_TEST =
  '"Wait\u2014really?" she asked, laughing: "Yes! Of course; that\'s #1."\n' +
  "Save 50% (limited-time) [Terms apply] {no returns} \u2014 see pages 10\u201312 & item A/B @desk_1 *bonus* \u2014 don't forget: C:\\Data.";
export const SYMBOL_TEST =
  "5 + 3 = 8, and 5 < 10 but 20 > 15 \u2014 x^2 rises ~10\u00b0 warmer than usual.\n" +
  "Priced at $99 / \u20ac89 / \u00a379 / \u00a512,000, \u00a9 2026 Studio\u2122 \u00ae all rights | \u00a7 terms apply.";

/**
 * Picks the most relevant one-line preset for whatever glyph category is
 * currently focused in the editor — used by the Production Preview bar so
 * switching between drawing an uppercase letter and a digit automatically
 * shows the sentence that actually contains it. Falls back to the
 * uppercase pangram (a safe default that reads fine either way) for
 * categories with no natural single-sentence form (spacing, multilingual,
 * feature glyphs).
 */
export function sentenceForCategory(category: string | undefined): string {
  switch (category) {
    case "upper": return UPPER_TEST;
    case "lower": return LOWER_TEST;
    case "digits": return NUMBERS_TEST;
    case "punct": return PUNCTUATION_TEST;
    case "symbols": return SYMBOL_TEST;
    default: return UPPER_TEST;
  }
}
