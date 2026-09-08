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

/** Standard ray-casting point-in-polygon test, used to classify a resolved
 * ring as outer vs. hole by actual geometric nesting — see the doc comment
 * on the classification loop in mergeOutlineBrushStrokes below for why this
 * replaced a winding-sign comparison. */
function pointInPolygon(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-9) + a.x) inside = !inside;
  }
  return inside;
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
      // BUG FIX (open-end crossing strokes not merging): this branch used to
      // push the raw contour straight into the outer pool with no
      // self-intersection cleanup, on the assumption that only the
      // two-contour (has-a-hole) case needed it. But a solid, no-hole
      // stroke (e.g. a thick border, or Open end style with little room
      // left for a hole) can just as easily come from a single continuous
      // pen gesture that loops back over its own path — same root cause
      // `normalizeSelfIntersectingContours` exists for below. Skipping it
      // here left that stroke's own self-crossing tangle untouched, and
      // handing a self-intersecting ring straight to `clipUnion` alongside
      // other strokes is exactly the "not a valid simple polygon" case
      // booleanOps.ts warns produces wrong/degenerate output — which reads
      // as crossing strokes failing to fuse into one clean merged shape.
      // Running it through the same normalizer as the two-contour branch
      // fixes that while still being a no-op for a stroke that was already
      // simple.
      outerContours.push(normalizeSelfIntersectingContours(contours));
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
    // kept in separate pools.
    // BUG FIX (crossing not fusing / nearby ink vanishing): this used to
    // classify each resolved ring as outer-vs-hole by comparing its winding
    // SIGN against `contours[0]`'s (the RAW, pre-normalization outer body's)
    // sign. But `normalizeSelfIntersectingContours` rebuilds every ring
    // through `multiPolygonToContours`, which reorients each ring by its
    // OWN nesting depth (even depth vs. odd depth) — a convention that has
    // no reason to line up with whatever arbitrary winding the raw,
    // un-normalized stroke geometry happened to have. When the two
    // conventions disagreed, the comparison silently swapped outer and
    // hole: a piece that was actually solid ink (e.g. right where a
    // self-crossing loop rejoins itself, or wherever this stroke sits near
    // another one) got bucketed as a hole and subtracted away — reading as
    // "the crossing never fuses" or "everything nearby disappeared",
    // depending on which piece got mislabeled.
    //
    // Fix: classify by actual geometric NESTING within this stroke's own
    // resolved set instead of by sign. A ring contained inside an ODD
    // number of the other resolved rings is a hole (it's punched through
    // by whatever directly encloses it); contained in an even number
    // (including zero) it's ink. This only looks at the rings' real shape,
    // so it can't be thrown off by a winding-convention mismatch, and it
    // naturally handles a self-crossing loop resolving into more than just
    // one outer + one hole.
    const resolved = normalizeSelfIntersectingContours(contours).filter((c) => c.nodes.length > 0);
    const ringPoints = resolved.map((c) => c.nodes.map((n) => n.point));
    for (let i = 0; i < resolved.length; i++) {
      let containedCount = 0;
      for (let j = 0; j < resolved.length; j++) {
        if (i === j) continue;
        if (pointInPolygon(ringPoints[i][0], ringPoints[j])) containedCount++;
      }
      const isHole = containedCount % 2 === 1;
      (isHole ? innerContours : outerContours).push([resolved[i]]);
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
