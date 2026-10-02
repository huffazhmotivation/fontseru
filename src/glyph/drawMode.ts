import type { Glyph, GlyphMap } from "@/types/glyph";
import type { GlyphOutline } from "@/types/geometry";
import { emptyOutline } from "@/types/geometry";

/**
 * Drawing Mode scratch glyph.
 *
 * Drawing Mode is a free canvas, not a glyph: you sketch a shape first and
 * decide afterwards which glyph it becomes. To reuse every existing tool
 * (brush, pen, shapes, node editing, undo) unchanged, the sketch lives in
 * the active style's glyph map under this reserved key for as long as the
 * mode is open. It is removed again when the mode closes, and stripped by
 * `withoutDrawGlyph` anywhere project/font data leaves the editor (autosave,
 * .fs save, export), so it can never end up in a saved or exported font.
 */
export const DRAW_CHAR = "";
export const DRAW_UNICODE = 0xf8fe;

export function makeDrawGlyph(outline: GlyphOutline, upm: number): Glyph {
  return {
    char: DRAW_CHAR,
    unicode: DRAW_UNICODE,
    category: "symbols",
    advanceWidth: upm,
    lsb: 0,
    rsb: 0,
    outline,
    components: [],
  };
}

export function emptyDrawGlyph(upm: number): Glyph {
  return makeDrawGlyph(emptyOutline(), upm);
}

/** Same map when the scratch key is absent (the common case — no copy). */
export function withoutDrawGlyph(map: GlyphMap): GlyphMap {
  if (!(DRAW_CHAR in map)) return map;
  const { [DRAW_CHAR]: _scratch, ...rest } = map;
  return rest;
}

export function familyWithoutDrawGlyph<T extends Record<string, GlyphMap>>(family: T): T {
  let out: Record<string, GlyphMap> | null = null;
  for (const style of Object.keys(family)) {
    const clean = withoutDrawGlyph(family[style]);
    if (clean !== family[style]) {
      if (!out) out = { ...family };
      out[style] = clean;
    }
  }
  return (out ?? family) as T;
}
