import type { Glyph, GlyphCategory, GlyphMap } from "@/types/glyph";
import { emptyOutline } from "@/types/geometry";

/**
 * Feature Builder can create glyphs (ligatures, alternates, swashes) that
 * have no natural Unicode character of their own — e.g. the "re" ligature
 * or "a.alt1". The rest of the app (GlyphNav navigation, export glyph
 * de-duplication in utils/fontIO.ts) is Unicode-keyed, so rather than
 * teaching every one of those places about "unencoded" glyphs, each
 * Feature-Builder-created glyph is given its own private-use-area (PUA)
 * code point. This makes it behave exactly like any other drawable glyph
 * everywhere else in the app — editor, undo/redo, Generate From Regular,
 * export — with zero changes to that existing code. The PUA mapping is
 * never meant to be typed directly; it only exists so the glyph has a
 * valid, unique `unicode` value. Only Feature Builder rules ever reference
 * the glyph, by its GlyphMap key (`char`), not by this code point.
 */
const FEATURE_GLYPH_PUA_START = 0xf100;
const FEATURE_GLYPH_PUA_END = 0xf8ff;

/** True when a code point falls inside the private-use range this file
 * hands out to Feature-Builder-created glyphs. Used to tell a Feature
 * Builder glyph (safe to auto-delete when its last rule reference is
 * removed) apart from an ordinary letter/symbol a user drew or imported. */
export function isFeatureGlyphUnicode(unicode: number | undefined): boolean {
  return typeof unicode === "number" && unicode >= FEATURE_GLYPH_PUA_START && unicode <= FEATURE_GLYPH_PUA_END;
}

function usedUnicodes(glyphsByStyle: Record<string, GlyphMap>): Set<number> {
  const used = new Set<number>();
  for (const map of Object.values(glyphsByStyle)) {
    for (const glyph of Object.values(map)) {
      used.add(glyph.unicode);
      for (const cp of glyph.unicodes ?? []) used.add(cp);
    }
  }
  return used;
}

/** Finds the next unused PUA code point across every existing family style
 * so newly created feature glyphs never collide with each other or with
 * anything already imported/drawn. */
export function nextFeatureGlyphUnicode(glyphsByStyle: Record<string, GlyphMap>): number {
  const used = usedUnicodes(glyphsByStyle);
  for (let cp = FEATURE_GLYPH_PUA_START; cp <= FEATURE_GLYPH_PUA_END; cp++) {
    if (!used.has(cp)) return cp;
  }
  // Astronomically unlikely (6400 slots), but never throw from a UI action.
  return FEATURE_GLYPH_PUA_START;
}

export interface CreateFeatureGlyphOptions {
  key: string;
  category?: GlyphCategory;
  /** Advance width to start from, typically borrowed from the glyph that
   * inspired this one (e.g. the base letter of an alternate/swash). */
  advanceWidth?: number;
  unicode: number;
}

export function buildFeatureGlyph(options: CreateFeatureGlyphOptions): Glyph {
  return {
    char: options.key,
    unicode: options.unicode,
    unicodes: [options.unicode],
    name: options.key,
    category: options.category ?? "feature",
    advanceWidth: Math.max(1, Math.round(options.advanceWidth ?? 600)),
    lsb: 60,
    rsb: 60,
    outline: emptyOutline(),
    components: [],
  };
}
