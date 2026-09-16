import type { Glyph, GlyphMap } from "@/types/glyph";
import { hasOutline } from "@/types/glyph";
import { getOrderedChars } from "@/glyph/defaultGlyphs";
import type { GlyphFilterId } from "@/types/glyphView";

/**
 * Filter system for the Multi Glyph Canvas.
 *
 * Membership is decided by the glyph's OWN `category` first — the same
 * field GLYPH_GROUPS / GlyphNav already group by, so a filter can never
 * disagree with the glyph list — and then widened by a Unicode-property
 * fallback so glyphs that arrived through import or "+ Multilingual
 * Glyphs" (category "multilingual", e.g. "Á", "ß") still land in the
 * Uppercase/Lowercase/Numbers bucket a designer would expect them in,
 * instead of only ever showing under "All Glyphs".
 *
 * Purely a read-side view helper: nothing here mutates or copies glyph
 * data — every function takes the store's live `glyphs` map and returns
 * an array of CHARACTER KEYS into that same map.
 */

function isUpperChar(ch: string): boolean {
  // Single code point, is a letter, and uppercasing it changes nothing
  // while lowercasing does — the standard "is this an uppercase letter"
  // test that works for the whole Latin/Greek/Cyrillic range, not just
  // A–Z.
  if (Array.from(ch).length !== 1) return false;
  if (!/\p{L}/u.test(ch)) return false;
  return ch === ch.toUpperCase() && ch !== ch.toLowerCase();
}

function isLowerChar(ch: string): boolean {
  if (Array.from(ch).length !== 1) return false;
  if (!/\p{L}/u.test(ch)) return false;
  return ch === ch.toLowerCase() && ch !== ch.toUpperCase();
}

function isDigitChar(ch: string): boolean {
  return Array.from(ch).length === 1 && /\p{Nd}/u.test(ch);
}

function isPunctChar(ch: string): boolean {
  return Array.from(ch).length === 1 && /\p{P}/u.test(ch);
}

function isSymbolChar(ch: string): boolean {
  return Array.from(ch).length === 1 && /\p{S}/u.test(ch);
}

/** Does one glyph belong to one filter bucket? */
export function glyphMatchesFilter(
  glyph: Glyph,
  filter: GlyphFilterId,
  selected: ReadonlySet<string>
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "custom":
      return selected.has(glyph.char);
    case "drawn":
      return hasOutline(glyph);
    case "upper":
      return glyph.category === "upper" || isUpperChar(glyph.char);
    case "lower":
      return glyph.category === "lower" || isLowerChar(glyph.char);
    case "digits":
      return glyph.category === "digits" || isDigitChar(glyph.char);
    case "punct":
      return glyph.category === "punct" || isPunctChar(glyph.char);
    case "symbols":
      // Feature glyphs (ligatures/alternates/swashes) have no sensible
      // Unicode class of their own, so they ride along with Symbols —
      // same place the Feature Builder's output is easiest to eyeball
      // as a group.
      return (
        glyph.category === "symbols" ||
        glyph.category === "feature" ||
        isSymbolChar(glyph.char)
      );
    default:
      return true;
  }
}

/**
 * The character keys the overview should render, in the app's single
 * canonical glyph order (getOrderedChars — the same order GlyphNav,
 * GlyphStepper and Prev/Next glyph navigation use), narrowed by `filter`
 * and, when `query` is non-empty, by a simple char/name/unicode search.
 */
export function filterGlyphChars(
  glyphs: GlyphMap,
  filter: GlyphFilterId,
  selectedGlyphChars: ReadonlyArray<string>,
  query = ""
): string[] {
  const selected = new Set(selectedGlyphChars);
  const ordered = getOrderedChars(glyphs);
  const q = query.trim().toLowerCase();

  const out: string[] = [];
  for (const ch of ordered) {
    const glyph = glyphs[ch];
    if (!glyph) continue;
    if (!glyphMatchesFilter(glyph, filter, selected)) continue;
    if (q) {
      const hex = glyph.unicode.toString(16).padStart(4, "0");
      const name = (glyph.name ?? "").toLowerCase();
      const matches =
        ch.toLowerCase().includes(q) ||
        name.includes(q) ||
        hex.includes(q) ||
        `u+${hex}`.includes(q);
      if (!matches) continue;
    }
    out.push(ch);
  }
  return out;
}

/** Count of drawn glyphs in a map — powers the "n jadi" readout in the
 *  overview toolbar. Cheap enough to run per render on a few thousand
 *  glyphs, and it never allocates a second glyph collection. */
export function countDrawnGlyphs(glyphs: GlyphMap): number {
  let n = 0;
  for (const ch in glyphs) {
    const g = glyphs[ch];
    if (g && hasOutline(g)) n++;
  }
  return n;
}
