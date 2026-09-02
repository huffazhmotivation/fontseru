import type { GlyphOutline } from "./geometry";
import { totalNodeCount } from "./geometry";

export type GlyphCategory = "spacing" | "upper" | "lower" | "digits" | "punct" | "symbols" | "multilingual" | "feature";

/**
 * One glyph in the working (master/Regular) font. `components` is left as
 * an architectural placeholder for composite glyphs added in a later phase.
 */
export interface Glyph {
  char: string;
  unicode: number;
  /** All Unicode code points mapped to this glyph; `unicode` is the primary mapping. */
  unicodes?: number[];
  /** Original glyph name when imported from an OpenType font. */
  name?: string;
  category: GlyphCategory;
  advanceWidth: number;
  lsb: number;
  rsb: number;
  outline: GlyphOutline;
  components: string[];
}

export type GlyphMap = Record<string, Glyph>;

/**
 * A family "style" is identified by a string id. The three built-in styles
 * ("regular" | "bold" | "italic") always exist; any other id refers to a
 * user-created custom family (see `CustomFamily` below). Kept as a plain
 * `string` — rather than a closed union — specifically so custom family ids
 * type-check everywhere a `FontStyle` is expected (glyphsByStyle, kerning
 * overrides, persisted project files, etc.) without touching every call site.
 */
export type FontStyle = string;
export type BuiltInFontStyle = "regular" | "bold" | "italic";
export type GlyphFamily = Record<FontStyle, GlyphMap>;

/** A user-created font family beyond Regular/Bold/Italic. Only the id +
 * display name are tracked here; its glyphs live in `glyphsByStyle[id]`
 * exactly like any built-in style. */
export interface CustomFamily {
  id: FontStyle;
  name: string;
}

/** Regular, Bold, Italic + at most this many user-created families. */
export const MAX_CUSTOM_FAMILIES = 3;
/** Total Glyph tabs allowed at once (3 built-in + MAX_CUSTOM_FAMILIES). */
export const MAX_GLYPH_TABS = 3 + MAX_CUSTOM_FAMILIES;

export const FONT_STYLES: ReadonlyArray<{ id: BuiltInFontStyle; label: "Regular" | "Bold" | "Italic" }> = [
  { id: "regular", label: "Regular" },
  { id: "bold", label: "Bold" },
  { id: "italic", label: "Italic" },
];

export function fontStyleLabel(style: FontStyle, customFamilies?: ReadonlyArray<CustomFamily>): string {
  const builtIn = FONT_STYLES.find((item) => item.id === style)?.label;
  if (builtIn) return builtIn;
  const custom = customFamilies?.find((f) => f.id === style)?.name;
  return custom ?? "Regular";
}

export interface GlyphGroup {
  id: GlyphCategory;
  label: string;
  chars: string[];
}

export function hasOutline(glyph: Glyph): boolean {
  return totalNodeCount(glyph.outline) > 0;
}
