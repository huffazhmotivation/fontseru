import type { GlyphFamily, GlyphMap } from "@/types/glyph";

/**
 * Clone every glyph and every nested vector object/node so family styles
 * never share editable geometry or metric objects by reference.
 */
export function cloneGlyphMap(source: GlyphMap): GlyphMap {
  if (typeof structuredClone === "function") return structuredClone(source);
  return JSON.parse(JSON.stringify(source)) as GlyphMap;
}

/**
 * Keep the same character inventory before generation, but start with no
 * outlines. This lets Bold/Italic tabs remain navigable until the user
 * explicitly clones Regular.
 */
export function emptyStyleGlyphsFrom(source: GlyphMap): GlyphMap {
  const next = cloneGlyphMap(source);
  for (const glyph of Object.values(next)) glyph.outline = { objects: [] };
  return next;
}

export function familyFromRegular(regular: GlyphMap): GlyphFamily {
  return {
    regular,
    bold: emptyStyleGlyphsFrom(regular),
    italic: emptyStyleGlyphsFrom(regular),
  };
}

/**
 * Starting glyph set for a brand-new custom family tab: same character
 * inventory as Regular, no outlines yet — identical treatment to how
 * Bold/Italic start out, so the new tab is immediately navigable and ready
 * for either manual drawing or Generate.
 */
export function newCustomFamilyGlyphs(regular: GlyphMap): GlyphMap {
  return emptyStyleGlyphsFrom(regular);
}
