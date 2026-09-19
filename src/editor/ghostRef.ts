import type { FontStyle, Glyph, GlyphMap } from "@/types/glyph";

/**
 * GHOST REFERENCE — SHARED MATH
 * =============================
 * Everything both drawing surfaces need in order to place a ghost glyph
 * IDENTICALLY lives here, and nowhere else.
 *
 * This file exists because of a concrete bug class: the single-glyph
 * canvas used to own these helpers privately, so the multi-glyph canvas
 * could only ever *re-implement* them. Two copies of "where does the
 * ghost sit" drift the moment either side is touched, and the drift shows
 * up as a ghost that is a few units off — exactly the thing that makes a
 * tracing reference useless.
 *
 * With one copy, "the ghost in Multi Mode is in the same place as in
 * Single Mode" is not something that has to be kept true by hand; it is
 * true by construction, because the two canvases call the same function
 * with the same glyph and get the same number back.
 */

const FAMILY_GHOST_ORDER: Record<string, readonly [FontStyle, FontStyle]> = {
  regular: ["bold", "italic"],
  bold: ["regular", "italic"],
  italic: ["regular", "bold"],
};

/** Ghost-reference pair for the current style. Built-in styles use the
 * fixed table above; a custom family (or any id not in that table) falls
 * back to referencing Regular + Bold, since it has no natural counterpart. */
export function familyGhostOrder(style: FontStyle): readonly [FontStyle, FontStyle] {
  return FAMILY_GHOST_ORDER[style] ?? ["regular", "bold"];
}

/** The same character in another family style — matched by name first,
 *  then by any shared code point, then by the character itself. */
export function matchingFamilyGlyph(
  map: GlyphMap | undefined,
  activeGlyph: Glyph,
  activeChar: string
): Glyph | undefined {
  if (!map) return undefined;
  const exact = map[activeChar];
  if (exact) return exact;

  const activeCodes = new Set([activeGlyph.unicode, ...(activeGlyph.unicodes ?? [])]);
  return Object.values(map).find((candidate) => {
    if (activeCodes.has(candidate.unicode)) return true;
    if (candidate.unicodes?.some((code) => activeCodes.has(code))) return true;
    return candidate.char === activeGlyph.char;
  });
}

/**
 * Horizontal anchor for the "sample" and "image" ghost modes: the centre
 * of THIS glyph's own standard advance box (lsb … advance − rsb), not the
 * centre of the em square.
 *
 * This is the single number that decides whether a ghost lines up with
 * the ink you are about to draw. Both canvases read it from here, which
 * is what makes a ghost sit on the same pixel in Single and Multi mode
 * for the same glyph at the same zoom.
 */
export function ghostCenterX(glyph: Glyph | undefined, upm: number): number {
  return glyph ? (glyph.advanceWidth + glyph.lsb - glyph.rsb) / 2 : upm * 0.5;
}
