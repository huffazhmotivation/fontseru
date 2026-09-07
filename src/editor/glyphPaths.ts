import type { Glyph } from "@/types/glyph";
import type { Contour, VectorObject } from "@/types/geometry";
import { objectFillPath, objectStrokePath, contourToPath } from "./pathBuilder";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { applyBooleanOp } from "./booleanOps";

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

/**
 * Outline Brush is a hollow ring: two independent strokes crossing each
 * still render as their OWN separate SVG path (see VectorObject's doc
 * comment in types/geometry.ts — objects deliberately never subtract from
 * each other, so overlapping ink never punches an accidental hole). For a
 * solid/filled brush that's invisible; for a hollow ring it means the far
 * border shows straight through the crossing stroke, reading as a stray
 * tangle of extra lines right where two strokes touch.
 *
 * This is purely a visual concern, not a data one: unioning every Outline
 * Brush stroke's rendered silhouette — with the SAME boolean-union engine
 * the Union toolbar button already uses (see editor/booleanOps.ts) — makes
 * touching/crossing strokes read as one clean merged outline, while
 * `glyph.outline.objects` itself is never touched. Every stroke stays its
 * own independently selectable/editable object (settings, nodes, etc.)
 * exactly as before; only the derived path used to draw it changes.
 *
 * Safe to run unconditionally over every Outline Brush stroke in the
 * glyph, not just ones known to overlap: unioning shapes that don't
 * actually touch just hands back their contours untouched as separate
 * disjoint rings (see applyBooleanOp's polygon-clipping union), so an "i"'s
 * two unrelated dots merge into a no-op and still render as two dots.
 */
function mergeOutlineBrushStrokes(objects: VectorObject[]): { contours: Contour[]; consumedIds: Set<string> } | null {
  const outlineObjs = objects.filter((o) => o.kind === "brush" && o.brushType === "outline");
  if (outlineObjs.length < 2) return null;

  const wrapped: VectorObject[] = [];
  for (const o of outlineObjs) {
    const contours = brushOutlineContours(o);
    if (contours.length) wrapped.push({ id: o.id, kind: "expanded", contours });
  }
  if (wrapped.length < 2) return null;

  const merged = applyBooleanOp(wrapped, "union");
  if (!merged || merged.contours.length === 0) return null;

  const consumedIds = new Set(outlineObjs.map((o) => o.id));
  return { contours: merged.contours, consumedIds };
}

export function getGlyphPaths(glyph: Glyph, ascender: number): GlyphPathEntry[] {
  let byAscender = glyphPathCache.get(glyph);
  const cached = byAscender?.get(ascender);
  if (cached) return cached;

  const outlineMerge = mergeOutlineBrushStrokes(glyph.outline.objects);
  const firstConsumedId = outlineMerge ? [...outlineMerge.consumedIds][0] : null;

  const entries: GlyphPathEntry[] = [];
  for (const obj of glyph.outline.objects) {
    if (outlineMerge?.consumedIds.has(obj.id)) {
      // Only the FIRST consumed stroke emits the merged entry, at its own
      // z-order slot — the rest are skipped so the merge isn't duplicated.
      if (firstConsumedId === obj.id) {
        entries.push({
          kind: "brushFill",
          id: `outline-merge-${obj.id}`,
          d: outlineMerge.contours.map((c) => contourToPath(c, ascender)).join(" "),
        });
      }
      continue;
    }
    if (obj.kind === "shape" || obj.kind === "expanded") {
      entries.push({ kind: "fill", id: obj.id, d: objectFillPath(obj, ascender) });
      continue;
    }
    if (obj.kind === "brush" && obj.brushType !== "monoline") {
      entries.push({
        kind: "brushFill",
        id: obj.id,
        d: brushOutlineContours(obj).map((c) => contourToPath(c, ascender)).join(" "),
      });
      continue;
    }
    entries.push({
      kind: "stroke",
      id: obj.id,
      d: objectStrokePath(obj, ascender),
      strokeWidth: obj.strokeWidth ?? 20,
      cap: obj.cap ?? "round",
      join: obj.join ?? "round",
    });
  }

  if (!byAscender) {
    byAscender = new Map();
    glyphPathCache.set(glyph, byAscender);
  }
  byAscender.set(ascender, entries);
  return entries;
}
