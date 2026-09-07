import type { Glyph } from "@/types/glyph";
import type { Contour, VectorObject } from "@/types/geometry";
import { objectFillPath, objectStrokePath, contourToPath } from "./pathBuilder";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { applyBooleanOp, normalizeSelfIntersectingContours } from "./booleanOps";

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

/** Shoelace signed area, used only to classify a resolved contour as
 * "outer/ink" vs. "hole" by comparing its winding sign against the
 * stroke's original outer boundary — see mergeOutlineBrushStrokes. */
function signedArea(points: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return a / 2;
}

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
/** Unions 0..N single-purpose shapes without needless boolean calls for the
 * trivial case of nothing to union. A lone shape still gets run through
 * `normalizeSelfIntersectingContours` (not just handed back untouched) —
 * see that function's doc comment for why a SINGLE stroke can itself be
 * self-crossing and needs the same cleanup 2+ strokes get from the union
 * call below. */
function unionShapes(contoursList: Contour[][]): Contour[] {
  const nonEmpty = contoursList.filter((c) => c.length > 0);
  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length === 1) return normalizeSelfIntersectingContours(nonEmpty[0]);
  const wrapped: VectorObject[] = nonEmpty.map((contours) => ({ id: `tmp-${Math.random()}`, kind: "expanded", contours }));
  const merged = applyBooleanOp(wrapped, "union");
  return merged?.contours ?? [];
}

export function mergeOutlineBrushStrokes(objects: VectorObject[]): { contours: Contour[]; consumedIds: Set<string> } | null {
  const outlineObjs = objects.filter((o) => o.kind === "brush" && o.brushType === "outline");
  // BUG FIX: used to require 2+ Outline Brush strokes before doing anything
  // ("< 2"), on the assumption that self-intersection cleanup only mattered
  // when merging separate crossing strokes. But a SINGLE stroke whose own
  // centerline loops back over itself (one continuous pen gesture around a
  // bowl+leg letterform, e.g. drawing an "R"/"a"/"e" in one motion) is just
  // as self-intersecting, and with only 1 outline object in the glyph this
  // function bailed out entirely, leaving that raw tangled ring to render
  // unfixed. Now runs for 1+ so a lone stroke still gets normalized (see
  // unionShapes above), while everything about how 2+ strokes merge stays
  // exactly as before.
  if (outlineObjs.length < 1) return null;

  // outlineBrushOutlineContours() returns [outerBody] when the stroke is too
  // thin for a hole, or [outerBody, innerHole] otherwise. Rather than
  // unioning each stroke's own outer+hole pair together (a plain donut
  // union), collect ALL outer bodies and ALL inner holes across every
  // stroke separately, union each group on its own, then subtract the
  // combined hole from the combined body. This makes a hole always show
  // through, even where a *different* stroke's solid ink crosses over it —
  // matching how real hollow/outline letterforms read where strokes meet —
  // instead of the later stroke's ink silently plugging the earlier
  // stroke's hole (what a plain donut-vs-donut union does, since union just
  // ORs ink together with no concept of "hole wins").
  const outerContours: Contour[][] = [];
  const innerContours: Contour[][] = [];
  for (const o of outlineObjs) {
    const contours = brushOutlineContours(o);
    if (contours.length === 0) continue;
    // Every End Style — "square", "round", and "open" alike — now returns
    // the same [outerBody, innerHole] shape from outlineBrushOutlineContours
    // (or just [outerBody] when the stroke's too thin for a hole), so they
    // all bucket the same way: outer goes in the outer-union pool, the hole
    // (if any) goes in the hole-union pool. "open" no longer builds a
    // separate pair of independent rail strips — see
    // centerlineToOutline's capMode doc comment for why that stopped
    // touching/crossing strokes from merging cleanly, and
    // outlineBrushOutlineContours' doc comment for how the ring approach
    // fixes it while still reading as a genuinely open, uncapped tip.
    if (contours.length === 1) {
      outerContours.push(contours);
      continue;
    }

    // BUG FIX (one continuous self-crossing stroke erasing its own inner
    // border): a single touch whose CENTERLINE loops back over its own
    // earlier path — e.g. a bowl+leg letterform like "R"/"a" drawn in one
    // motion — makes BOTH this stroke's outer boundary and its inner hole
    // self-intersect, not just the outer one. Bucketing the raw outer and
    // raw hole separately (as before) and only normalizing each one's
    // self-crossing later, independently, inside `unionShapes` is wrong for
    // the hole: a plain self-union ADDS a self-crossing ring's overlapping
    // loops together into one bigger solid hole blob instead of resolving
    // them with the even-odd/counter fill rule the rest of the app uses for
    // one object's own overlapping contours (e.g. an "O"'s counter). Where
    // the tube crosses itself, that swallows the thin ink bridge that
    // should stay solid there, and the subtract step below then cuts it
    // away entirely — the "inner line kehapus semua" bug. Resolving this
    // stroke's OWN outer+hole pair together, first, through the same
    // even-odd normalizer (`normalizeSelfIntersectingContours`) fixes that
    // stroke's self-crossing correctly before it ever reaches the
    // cross-stroke union/subtract below — which still needs outer and hole
    // kept in separate pools, so the resolved contours are re-sorted back
    // into outer vs. hole by comparing each one's winding sign against the
    // original outer boundary's sign.
    const resolved = normalizeSelfIntersectingContours(contours);
    const outerSign = Math.sign(signedArea(contours[0].nodes.map((n) => n.point))) || 1;
    for (const c of resolved) {
      const sign = Math.sign(signedArea(c.nodes.map((n) => n.point))) || outerSign;
      (sign === outerSign ? outerContours : innerContours).push([c]);
    }
  }
  if (outerContours.length < 1) return null;

  const outerUnion = unionShapes(outerContours);
  if (outerUnion.length === 0) return null;

  const innerUnion = innerContours.length > 0 ? unionShapes(innerContours) : [];

  let finalContours = outerUnion;
  if (innerUnion.length > 0) {
    const cut = applyBooleanOp(
      [
        { id: "tmp-outer", kind: "expanded", contours: outerUnion },
        { id: "tmp-inner", kind: "expanded", contours: innerUnion },
      ],
      "subtract"
    );
    if (cut && cut.contours.length > 0) finalContours = cut.contours;
  }

  const consumedIds = new Set(outlineObjs.map((o) => o.id));
  return { contours: finalContours, consumedIds };
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
