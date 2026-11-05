import type { Glyph, GlyphAnchor, GlyphMap } from "@/types/glyph";
import { hasOutline } from "@/types/glyph";
import type { FontMetrics } from "@/types/font";
import { outlineBounds } from "@/editor/objectOps";

/** Anchor names the editor offers. "_x" = where a mark attaches to a base's "x". */
export const ANCHOR_NAMES = ["top", "bottom", "ogonek", "_top", "_bottom", "_ogonek"] as const;

/** Combining diacritics block — these are real "mark" glyphs for GDEF. */
export function isCombiningMark(unicode: number): boolean {
  return unicode >= 0x0300 && unicode <= 0x036f;
}

/** A mark glyph either is a combining character or carries an attach ("_name") anchor. */
export function isMarkGlyph(glyph: Glyph): boolean {
  return isCombiningMark(glyph.unicode) || (glyph.anchors?.some((a) => a.name.startsWith("_")) ?? false);
}

export function normalizeAnchorName(name: string): string {
  return name.trim().replace(/\s+/g, "").slice(0, 32);
}

/**
 * Suggests anchors from the glyph's ink. Marks get an attach anchor just
 * below/above their ink (with a small gap) plus a stack anchor; letters get
 * "top" (above the ink) and "bottom". Existing anchors with the same name
 * are never replaced, so hand-placed anchors survive a re-run.
 */
export function suggestAnchors(glyph: Glyph, metrics: FontMetrics): GlyphAnchor[] {
  if (!hasOutline(glyph)) return glyph.anchors ?? [];
  const b = outlineBounds(glyph.outline);
  if (!b) return glyph.anchors ?? [];
  const gap = Math.round(metrics.unitsPerEm * 0.02);
  const cx = Math.round((b.minX + b.maxX) / 2);
  const mark = isCombiningMark(glyph.unicode);
  const want: GlyphAnchor[] = mark
    ? [
        { name: "_top", x: cx, y: Math.round(b.minY - gap) },
        { name: "top", x: cx, y: Math.round(b.maxY) },
        { name: "_bottom", x: cx, y: Math.round(b.maxY + gap) },
        { name: "bottom", x: cx, y: Math.round(b.minY) },
      ]
    : [
        { name: "top", x: cx, y: Math.round(b.maxY) },
        { name: "bottom", x: cx, y: Math.round(Math.min(b.minY, metrics.baseline)) },
      ];
  // A combining mark is either an upper or a lower mark, not both: keep the
  // pair that matches where its ink sits relative to the baseline.
  const filtered = mark
    ? want.filter((a) => (b.minY >= metrics.baseline ? a.name === "_top" || a.name === "top" : a.name === "_bottom" || a.name === "bottom"))
    : want;
  const existing = glyph.anchors ?? [];
  const names = new Set(existing.map((a) => a.name));
  return [...existing, ...filtered.filter((a) => !names.has(a.name))];
}

/** Anchors for every drawn letter/mark in the map; returns only glyphs that changed. */
export function suggestAnchorsForMap(glyphs: GlyphMap, metrics: FontMetrics): GlyphMap {
  const out: GlyphMap = { ...glyphs };
  for (const [k, g] of Object.entries(glyphs)) {
    // Only letters and combining marks take anchors; punctuation/digits don't need them.
    const isLetter = /\p{L}/u.test(g.char) || isCombiningMark(g.unicode);
    if (!isLetter || !hasOutline(g)) continue;
    const next = suggestAnchors(g, metrics);
    if (next.length !== (g.anchors?.length ?? 0)) out[k] = { ...g, anchors: next };
  }
  return out;
}
