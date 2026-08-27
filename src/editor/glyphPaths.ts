import type { Glyph } from "@/types/glyph";
import { objectFillPath, objectStrokePath, contourToPath } from "./pathBuilder";
import { brushOutlineContours } from "@/brushes/strokeToOutline";

/**
 * Rendering a glyph's outline (fill paths, brush stroke-to-outline
 * envelopes, stroke centerlines) is comparatively expensive — brush
 * envelopes in particular run a Minkowski-sum sweep per contour. None of
 * that geometry depends on WHERE the glyph is drawn, only on the glyph's
 * own outline data. This cache keys the computed path data by the glyph
 * object's own identity, nested by `ascender` (rounded) since glyph
 * rendering is Y-flipped around it. Shared by every text-run renderer in
 * the app (GlyphRun, Feature Builder's sentence preview, ...) so they all
 * benefit from — and stay consistent with — the same cached geometry.
 */
export type GlyphPathEntry =
  | { kind: "fill"; id: string; d: string }
  | { kind: "brushFill"; id: string; d: string }
  | { kind: "stroke"; id: string; d: string; strokeWidth: number; cap: string; join: string };

const glyphPathCache = new WeakMap<Glyph, Map<number, GlyphPathEntry[]>>();

export function getGlyphPaths(glyph: Glyph, ascender: number): GlyphPathEntry[] {
  let byAscender = glyphPathCache.get(glyph);
  const cached = byAscender?.get(ascender);
  if (cached) return cached;

  const entries: GlyphPathEntry[] = glyph.outline.objects.map((obj) => {
    if (obj.kind === "shape" || obj.kind === "expanded") {
      return { kind: "fill", id: obj.id, d: objectFillPath(obj, ascender) };
    }
    if (obj.kind === "brush" && obj.brushType !== "monoline") {
      return {
        kind: "brushFill",
        id: obj.id,
        d: brushOutlineContours(obj).map((c) => contourToPath(c, ascender)).join(" "),
      };
    }
    return {
      kind: "stroke",
      id: obj.id,
      d: objectStrokePath(obj, ascender),
      strokeWidth: obj.strokeWidth ?? 20,
      cap: obj.cap ?? "round",
      join: obj.join ?? "round",
    };
  });

  if (!byAscender) {
    byAscender = new Map();
    glyphPathCache.set(glyph, byAscender);
  }
  byAscender.set(ascender, entries);
  return entries;
}
