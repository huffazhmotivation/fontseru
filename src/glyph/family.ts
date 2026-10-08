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
  // Clone only the small non-outline fields: deep-cloning every outline just
  // to throw it away cost hundreds of ms on large (thousands-of-glyph) fonts.
  const next: GlyphMap = {};
  for (const key in source) {
    const { outline: _outline, ...rest } = source[key];
    const meta = typeof structuredClone === "function" ? structuredClone(rest) : JSON.parse(JSON.stringify(rest));
    next[key] = { ...meta, outline: { objects: [] } };
  }
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
