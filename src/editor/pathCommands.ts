import type { Contour, GlyphOutline, PathNode, Point, VectorObject } from "@/types/geometry";
import { shortId } from "@/utils/id";
import { cloneContour } from "./nodeOps";
import { flattenContour } from "./objectOps";
import { splitCubic } from "./bezier";

/** Signed area of a polygon in a Y-up system: > 0 means counter-clockwise. */
function signedArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return a / 2;
}

function pointInPoly(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Reverses a contour's direction. Handles swap sides so the shape is identical. */
export function reverseContour(contour: Contour): Contour {
  const src = cloneContour(contour);
  const nodes: PathNode[] = [...src.nodes].reverse().map((n) => ({ ...n, handleIn: n.handleOut, handleOut: n.handleIn }));
  // A closed contour keeps its first node in front so node numbering stays stable.
  if (src.closed && nodes.length > 1) nodes.unshift(nodes.pop() as PathNode);
  return { ...src, nodes };
}

/** True when every selected object is a stroke-free filled object. */
function isFilled(o: VectorObject): boolean {
  return o.kind === "shape" || o.kind === "expanded";
}

/** Reverses every contour of the given objects (all kinds — open paths included). */
export function reverseObjects(outline: GlyphOutline, objectIds: string[]): GlyphOutline {
  const ids = new Set(objectIds);
  return {
    ...outline,
    objects: outline.objects.map((o) => (ids.has(o.id) ? { ...o, contours: o.contours.map(reverseContour) } : o)),
  };
}

/**
 * Correct Path Direction: for each filled object, the outermost contour runs
 * counter-clockwise (font-editor convention in Y-up space) and every contour
 * nested an odd number of levels deep runs the opposite way, so counters
 * always cut holes. Open strokes are untouched. Shape never changes.
 */
export function correctDirections(outline: GlyphOutline, objectIds?: string[]): GlyphOutline {
  const ids = objectIds ? new Set(objectIds) : null;
  return {
    ...outline,
    objects: outline.objects.map((o) => {
      if (!isFilled(o) || (ids && !ids.has(o.id)) || o.contours.length === 0) return o;
      const polys = o.contours.map((c) => flattenContour(c, 12));
      const contours = o.contours.map((c, i) => {
        if (!c.closed || polys[i].length < 3) return c;
        const probe = polys[i][0];
        let depth = 0;
        for (let j = 0; j < polys.length; j++) {
          if (j === i || polys[j].length < 3) continue;
          if (Math.abs(signedArea(polys[j])) > Math.abs(signedArea(polys[i])) && pointInPoly(probe, polys[j])) depth++;
        }
        const wantCcw = depth % 2 === 0;
        const isCcw = signedArea(polys[i]) > 0;
        return wantCcw === isCcw ? c : reverseContour(c);
      });
      return { ...o, contours };
    }),
  };
}

/** True if any filled contour in the given objects is wound the "wrong" way. */
export function hasWrongDirection(outline: GlyphOutline, objectIds?: string[]): boolean {
  const fixed = correctDirections(outline, objectIds);
  return fixed.objects.some((o, i) => o !== outline.objects[i]);
}

function quadRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) < 1e-9) return [];
    return [-c / b];
  }
  const d = b * b - 4 * a * c;
  if (d < 0) return [];
  const s = Math.sqrt(d);
  return [(-b + s) / (2 * a), (-b - s) / (2 * a)];
}

/** t values (0..1 exclusive) where a cubic has a horizontal/vertical tangent. */
function extremeTs(p0: Point, p1: Point, p2: Point, p3: Point): number[] {
  const ts: number[] = [];
  for (const axis of ["x", "y"] as const) {
    const a = -p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis];
    const b = 2 * (p0[axis] - 2 * p1[axis] + p2[axis]);
    const c = p1[axis] - p0[axis];
    for (const t of quadRoots(3 * a, 3 * b, 3 * c)) if (t > 0.02 && t < 0.98) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  // merge near-duplicates (x and y extrema at the same place)
  return ts.filter((t, i) => i === 0 || t - ts[i - 1] > 0.02);
}

/**
 * Add Extremes: inserts an on-curve node at every horizontal/vertical
 * extreme of every curve segment (De Casteljau, shape preserved exactly).
 * Fonts want points at extremes — it's required for clean hinting and is
 * what TrueType/CFF tools check. Returns the number of nodes added.
 */
export function addExtremes(outline: GlyphOutline, objectIds?: string[]): { outline: GlyphOutline; added: number } {
  const ids = objectIds ? new Set(objectIds) : null;
  let added = 0;
  const objects = outline.objects.map((o) => {
    if (ids && !ids.has(o.id)) return o;
    let touched = false;
    const contours = o.contours.map((c) => {
      const src = cloneContour(c);
      const out: PathNode[] = [];
      const n = src.nodes.length;
      const segCount = src.closed ? n : n - 1;
      // Work on a growing copy: each segment is split into 1..3 pieces.
      const nodes = src.nodes;
      for (let i = 0; i < n; i++) {
        out.push(nodes[i]);
        if (i >= segCount) continue;
        const from = nodes[i];
        const to = nodes[(i + 1) % n];
        if (!from.handleOut && !to.handleIn) continue;
        const c1 = from.handleOut ?? from.point;
        const c2 = to.handleIn ?? to.point;
        const ts = extremeTs(from.point, c1, c2, to.point);
        if (!ts.length) continue;
        let curP0 = from.point;
        let curC1 = c1;
        let curC2 = c2;
        const curP3 = to.point;
        let tPrev = 0;
        let prevNode = from;
        for (const t of ts) {
          const local = (t - tPrev) / (1 - tPrev);
          const { left, right } = splitCubic(curP0, curC1, curC2, curP3, local);
          prevNode.handleOut = left[1];
          const mid: PathNode = { id: shortId("node"), point: left[3], handleIn: left[2], handleOut: right[1], type: "smooth" };
          out.push(mid);
          added++;
          touched = true;
          prevNode = mid;
          curP0 = right[0];
          curC1 = right[1];
          curC2 = right[2];
          tPrev = t;
        }
        // last piece arrives at `to`
        to.handleIn = curC2;
        prevNode.handleOut = curC1;
      }
      return { ...src, nodes: out };
    });
    return touched ? { ...o, contours } : o;
  });
  return { outline: added ? { ...outline, objects } : outline, added };
}
