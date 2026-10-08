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

/** Lookup index over one family map, built once per map identity. Each key
 * remembers the FIRST position (in `Object.values` order) where it occurs,
 * so picking the smallest position across a glyph's keys reproduces exactly
 * what the old linear `Object.values(map).find(...)` scan returned — just
 * in O(codes) instead of O(map size). Multi Mode calls this per visible
 * cell per render; with thousands of glyphs the scan was the hot spot. */
interface FamilyIndex {
  values: Glyph[];
  byCode: Map<number, number>;
  byChar: Map<string, number>;
}

const familyIndexCache = new WeakMap<GlyphMap, FamilyIndex>();

function familyIndex(map: GlyphMap): FamilyIndex {
  const cached = familyIndexCache.get(map);
  if (cached) return cached;
  const values = Object.values(map);
  const byCode = new Map<number, number>();
  const byChar = new Map<string, number>();
  for (let i = 0; i < values.length; i++) {
    const g = values[i];
    if (!byCode.has(g.unicode)) byCode.set(g.unicode, i);
    if (g.unicodes) for (const code of g.unicodes) if (!byCode.has(code)) byCode.set(code, i);
    if (!byChar.has(g.char)) byChar.set(g.char, i);
  }
  const index = { values, byCode, byChar };
  familyIndexCache.set(map, index);
  return index;
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

  const { values, byCode, byChar } = familyIndex(map);
  let best = byChar.get(activeGlyph.char) ?? Infinity;
  const first = byCode.get(activeGlyph.unicode);
  if (first !== undefined && first < best) best = first;
  if (activeGlyph.unicodes) {
    for (const code of activeGlyph.unicodes) {
      const at = byCode.get(code);
      if (at !== undefined && at < best) best = at;
    }
  }
  return best === Infinity ? undefined : values[best];
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
