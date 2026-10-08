import { hasOutline, type Glyph, type GlyphMap } from "@/types/glyph";

/**
 * `hasOutline` walks every contour of a glyph to count its nodes. Cheap for
 * one glyph, but the glyph list, the view bar's "n jadi" readout and every
 * visible Multi Mode cell all ask it again on every store commit — with a
 * few thousand glyphs that is a lot of repeated walking over outlines that
 * did not change. Outlines are immutable (an edit always produces a new
 * outline object), so the answer can be cached by outline identity.
 */
const hasOutlineCache = new WeakMap<object, boolean>();

export function hasOutlineCached(glyph: Glyph): boolean {
  const outline = glyph.outline as object | undefined;
  if (!outline) return hasOutline(glyph);
  let v = hasOutlineCache.get(outline);
  if (v === undefined) {
    v = hasOutline(glyph);
    hasOutlineCache.set(outline, v);
  }
  return v;
}

/** Drawn-glyph count for one glyph map, cached per map identity. Each
 *  glyph's own answer comes from the per-outline cache above, so after an
 *  edit only the changed glyph is actually re-walked. */
const drawnCountCache = new WeakMap<GlyphMap, number>();

export function countDrawnGlyphsCached(glyphs: GlyphMap): number {
  const cached = drawnCountCache.get(glyphs);
  if (cached !== undefined) return cached;
  let n = 0;
  for (const ch in glyphs) {
    const g = glyphs[ch];
    if (g && hasOutlineCached(g)) n++;
  }
  drawnCountCache.set(glyphs, n);
  return n;
}
