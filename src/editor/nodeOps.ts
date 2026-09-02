import type { Contour, GlyphOutline, NodeType, PathNode, Point, VectorObject } from "@/types/geometry";
import { reflect, reflectDirection, length, subtract, add, scale } from "@/utils/geometry";
import { shortId } from "@/utils/id";
import { splitCubic } from "./bezier";

export function cloneContour(c: Contour): Contour {
  return {
    ...c,
    nodes: c.nodes.map((n) => ({
      ...n,
      point: { ...n.point },
      handleIn: n.handleIn ? { ...n.handleIn } : null,
      handleOut: n.handleOut ? { ...n.handleOut } : null,
    })),
  };
}

export function cloneObject(o: VectorObject): VectorObject {
  return {
    ...o,
    contours: o.contours.map(cloneContour),
    samples: o.samples ? o.samples.map((s) => ({ ...s })) : undefined,
  };
}

export function cloneOutline(outline: GlyphOutline): GlyphOutline {
  return { objects: outline.objects.map(cloneObject) };
}

export function findObject(outline: GlyphOutline, objectId: string): VectorObject | null {
  return outline.objects.find((o) => o.id === objectId) ?? null;
}

export function findContour(outline: GlyphOutline, contourId: string): Contour | null {
  for (const o of outline.objects) {
    const c = o.contours.find((c) => c.id === contourId);
    if (c) return c;
  }
  return null;
}

export function findNode(outline: GlyphOutline, contourId: string, nodeId: string): PathNode | null {
  const contour = findContour(outline, contourId);
  return contour?.nodes.find((n) => n.id === nodeId) ?? null;
}

export const NODE_TYPE_ORDER: NodeType[] = ["corner", "smooth", "symmetric"];

/** Comfortable default handle spread (font units) for a node that becomes
 * Symmetric with no existing handles to mirror — long enough to grab and
 * adjust easily, short enough not to overshoot small glyphs. */
const DEFAULT_SYMMETRIC_HANDLE_LENGTH = 60;

/** Tangent direction through `node`, inferred from its contour neighbors,
 * used to give a freshly-symmetric node's handles a sensible starting angle. */
function neighborTangent(contour: Contour, node: PathNode): Point {
  const n = contour.nodes.length;
  const idx = contour.nodes.findIndex((nd) => nd.id === node.id);
  if (idx === -1 || n < 2) return { x: 1, y: 0 };
  const prevIdx = contour.closed ? (idx - 1 + n) % n : Math.max(0, idx - 1);
  const nextIdx = contour.closed ? (idx + 1) % n : Math.min(n - 1, idx + 1);
  const prev = contour.nodes[prevIdx].point;
  const next = contour.nodes[nextIdx].point;
  const dir = subtract(next, prev);
  const len = length(dir);
  return len < 0.001 ? { x: 1, y: 0 } : { x: dir.x / len, y: dir.y / len };
}

/** Gives a handle-less node a comfortable, symmetric pair of handles along
 * its local tangent, so it's immediately easy to grab and adjust. */
function ensureSymmetricHandles(contour: Contour, node: PathNode): void {
  if (node.handleIn || node.handleOut) return;
  const dir = neighborTangent(contour, node);
  const offset = { x: dir.x * DEFAULT_SYMMETRIC_HANDLE_LENGTH, y: dir.y * DEFAULT_SYMMETRIC_HANDLE_LENGTH };
  node.handleOut = add(node.point, offset);
  node.handleIn = subtract(node.point, offset);
}

/** Drops any object whose contours are all gone / too small to render. */
function pruneObjects(outline: GlyphOutline): GlyphOutline {
  for (const obj of outline.objects) {
    obj.contours = obj.contours.filter((c) => c.nodes.length >= 2);
  }
  outline.objects = outline.objects.filter((o) => o.contours.length > 0);
  return outline;
}

export function retypeNode(
  outline: GlyphOutline,
  contourId: string,
  nodeId: string,
  nextType: NodeType
): GlyphOutline {
  const working = cloneOutline(outline);
  const node = findNode(working, contourId, nodeId);
  if (!node) return working;
  node.type = nextType;

  if (nextType !== "corner" && (node.handleIn || node.handleOut)) {
    if (node.handleOut) {
      node.handleIn =
        nextType === "symmetric"
          ? reflect(node.handleOut, node.point)
          : node.handleIn
          ? reflectDirection(node.handleOut, node.point, length(subtract(node.handleIn, node.point)))
          : reflect(node.handleOut, node.point);
    } else if (node.handleIn) {
      node.handleOut = reflect(node.handleIn, node.point);
    }
  } else if (nextType === "symmetric") {
    const contour = findContour(working, contourId);
    if (contour) ensureSymmetricHandles(contour, node);
  }
  return working;
}


/** Retype every selected node in one geometry pass / one undo step. */
export function retypeNodes(
  outline: GlyphOutline,
  refs: { contourId: string; nodeId: string }[],
  nextType: NodeType
): GlyphOutline {
  const working = cloneOutline(outline);
  for (const ref of refs) {
    const node = findNode(working, ref.contourId, ref.nodeId);
    if (!node) continue;
    node.type = nextType;

    if (nextType !== "corner" && (node.handleIn || node.handleOut)) {
      if (node.handleOut) {
        node.handleIn =
          nextType === "symmetric"
            ? reflect(node.handleOut, node.point)
            : node.handleIn
            ? reflectDirection(node.handleOut, node.point, length(subtract(node.handleIn, node.point)))
            : reflect(node.handleOut, node.point);
      } else if (node.handleIn) {
        node.handleOut = reflect(node.handleIn, node.point);
      }
    } else if (nextType === "symmetric") {
      const contour = findContour(working, ref.contourId);
      if (contour) ensureSymmetricHandles(contour, node);
    }
  }
  return working;
}

/** Removes several nodes (possibly across multiple contours/objects) in one pass. */
export function deleteNodes(outline: GlyphOutline, refs: { contourId: string; nodeId: string }[]): GlyphOutline {
  const working = cloneOutline(outline);
  const byContour = new Map<string, Set<string>>();
  for (const r of refs) {
    if (!byContour.has(r.contourId)) byContour.set(r.contourId, new Set());
    byContour.get(r.contourId)!.add(r.nodeId);
  }
  for (const [contourId, nodeIds] of byContour) {
    const contour = findContour(working, contourId);
    if (!contour) continue;
    contour.nodes = contour.nodes.filter((n) => !nodeIds.has(n.id));
  }
  return pruneObjects(working);
}

/** Rigidly translates a set of selected nodes (point + both handles) by `delta`. */
export function moveNodesBy(
  outline: GlyphOutline,
  refs: { contourId: string; nodeId: string }[],
  delta: Point
): GlyphOutline {
  const working = cloneOutline(outline);
  const wanted = new Set(refs.map((r) => `${r.contourId}:${r.nodeId}`));
  for (const obj of working.objects) {
    for (const contour of obj.contours) {
      for (const node of contour.nodes) {
        if (!wanted.has(`${contour.id}:${node.id}`)) continue;
        node.point = add(node.point, delta);
        if (node.handleIn) node.handleIn = add(node.handleIn, delta);
        if (node.handleOut) node.handleOut = add(node.handleOut, delta);
      }
    }
  }
  return working;
}

/**
 * Sets one handle to an exact absolute point — the numeric-input counterpart
 * to dragging the handle dot on canvas (see useGlyphEditor's "move-handle"
 * drag). Applies the same mirroring the drag path uses for a non-broken
 * drag: symmetric nodes keep both handles at equal length/opposite angle,
 * smooth nodes keep both handles on the same line (independent length),
 * corner nodes leave the other handle untouched. Lets a curve's tangent be
 * dialed in to an exact length/angle instead of only ever eyeballed.
 */
export function setHandlePoint(
  outline: GlyphOutline,
  contourId: string,
  nodeId: string,
  part: "handleIn" | "handleOut",
  point: Point,
  nodeType: NodeType
): GlyphOutline {
  const working = cloneOutline(outline);
  const node = findNode(working, contourId, nodeId);
  if (!node) return working;
  if (part === "handleOut") {
    node.handleOut = point;
    if (nodeType === "symmetric") node.handleIn = reflect(point, node.point);
    else if (nodeType === "smooth" && node.handleIn) node.handleIn = reflectDirection(point, node.point, length(subtract(node.handleIn, node.point)));
  } else {
    node.handleIn = point;
    if (nodeType === "symmetric") node.handleOut = reflect(point, node.point);
    else if (nodeType === "smooth" && node.handleOut) node.handleOut = reflectDirection(point, node.point, length(subtract(node.handleOut, node.point)));
  }
  return working;
}

export interface SegmentRef {
  contourId: string;
  /** Index of the segment's starting node; runs to the next node (wrapping if closed). */
  fromIndex: number;
}

/**
 * Inserts a new on-curve node into a segment at parameter `t` (0..1), using
 * De Casteljau subdivision on curves so the visible shape is preserved.
 */
export function insertNodeOnSegment(outline: GlyphOutline, ref: SegmentRef, t: number): GlyphOutline {
  const working = cloneOutline(outline);
  const contour = findContour(working, ref.contourId);
  if (!contour) return working;
  const n = contour.nodes.length;
  const toIndex = (ref.fromIndex + 1) % n;
  if (!contour.closed && ref.fromIndex === n - 1) return working;

  const from = contour.nodes[ref.fromIndex];
  const to = contour.nodes[toIndex];
  const isCurve = Boolean(from.handleOut || to.handleIn);

  let newNode: PathNode;
  if (isCurve) {
    const c1 = from.handleOut ?? from.point;
    const c2 = to.handleIn ?? to.point;
    const { left, right } = splitCubic(from.point, c1, c2, to.point, t);
    from.handleOut = left[1];
    to.handleIn = right[2];
    newNode = { id: shortId("node"), point: left[3], handleIn: left[2], handleOut: right[1], type: "smooth" };
  } else {
    const point = {
      x: from.point.x + (to.point.x - from.point.x) * t,
      y: from.point.y + (to.point.y - from.point.y) * t,
    };
    newNode = { id: shortId("node"), point, handleIn: null, handleOut: null, type: "corner" };
  }

  contour.nodes.splice(ref.fromIndex + 1, 0, newNode);
  return working;
}

/**
 * Bends a segment into a Bézier curve (Cmd/Ctrl + drag). `target` is where
 * the user is dragging the segment toward; we solve for control handles so
 * the curve at t=0.5 passes near `target`, giving an intuitive "pull the
 * segment" feel. Endpoints keep their positions; their node type upgrades
 * to smooth so the curvature is retained on further editing.
 */
export function bendSegment(outline: GlyphOutline, ref: SegmentRef, t: number, target: Point): GlyphOutline {
  const working = cloneOutline(outline);
  const contour = findContour(working, ref.contourId);
  if (!contour) return working;
  const n = contour.nodes.length;
  const toIndex = (ref.fromIndex + 1) % n;
  if (!contour.closed && ref.fromIndex === n - 1) return working;

  const from = contour.nodes[ref.fromIndex];
  const to = contour.nodes[toIndex];
  const p0 = from.point;
  const p3 = to.point;
  const tt = Math.min(0.85, Math.max(0.15, t));

  // For a cubic B(t) with symmetric control offsets d from the chord, the
  // curve at t is chord(t) + factor*d. Solve d so B(tt) ≈ target.
  const chord = { x: p0.x + (p3.x - p0.x) * tt, y: p0.y + (p3.y - p0.y) * tt };
  const need = { x: target.x - chord.x, y: target.y - chord.y };
  const b1 = 3 * (1 - tt) * (1 - tt) * tt;
  const b2 = 3 * (1 - tt) * tt * tt;
  const factor = b1 + b2 || 1;
  const d = { x: need.x / factor, y: need.y / factor };

  from.handleOut = { x: p0.x + (p3.x - p0.x) / 3 + d.x, y: p0.y + (p3.y - p0.y) / 3 + d.y };
  to.handleIn = { x: p3.x - (p3.x - p0.x) / 3 + d.x, y: p3.y - (p3.y - p0.y) / 3 + d.y };
  if (from.type === "corner") from.type = "smooth";
  if (to.type === "corner") to.type = "smooth";
  return working;
}

/** Bezier control-point ratio for approximating a quarter-circle arc —
 * reused here to fillet an arbitrary corner (see roundCorner below). */
const CORNER_KAPPA = 0.5522847498;

/**
 * Node tool, Cmd/Ctrl+drag a corner node: replaces a sharp corner with a
 * rounded one. `radius` (font units) is how far the fillet eats into each
 * adjoining edge; it's clamped so the two new points never cross the
 * corner's neighbors (or each other, on very short edges). Works on any
 * corner — the Shape tool's rectangles/polygons as well as a corner made
 * by hand with the Pen — as long as it has a node on each side.
 *
 * The single corner node is replaced by two new on-curve nodes sitting
 * `radius` back along each edge, joined by a cubic curve whose handles
 * point back at the original corner (scaled by CORNER_KAPPA) — the same
 * construction used for the Shape tool's own circle/ellipse curves, so a
 * fully-rounded square corner reproduces a true quarter-circle.
 */
export function roundCorner(outline: GlyphOutline, ref: { contourId: string; nodeId: string }, radius: number): GlyphOutline {
  const working = cloneOutline(outline);
  const contour = findContour(working, ref.contourId);
  if (!contour) return working;
  const n = contour.nodes.length;
  const idx = contour.nodes.findIndex((node) => node.id === ref.nodeId);
  if (idx === -1 || n < 3) return working;

  const prevIdx = contour.closed ? (idx - 1 + n) % n : idx - 1;
  const nextIdx = contour.closed ? (idx + 1) % n : idx + 1;
  if (prevIdx < 0 || nextIdx >= n || prevIdx === idx || nextIdx === idx) return working; // open-path endpoint: no corner to fillet

  const corner = contour.nodes[idx];
  const prev = contour.nodes[prevIdx];
  const next = contour.nodes[nextIdx];

  const toPrev = subtract(prev.point, corner.point);
  const toNext = subtract(next.point, corner.point);
  const distPrev = length(toPrev);
  const distNext = length(toNext);
  if (distPrev < 0.001 || distNext < 0.001) return working;

  // Leave room so a chain of rounded corners on a small shape never overlaps.
  const maxRadius = Math.min(distPrev, distNext) * 0.98;
  const r = Math.max(0, Math.min(radius, maxRadius));
  if (r < 0.5) return working; // negligible drag — keep the corner sharp

  const unitPrev = scale(toPrev, 1 / distPrev);
  const unitNext = scale(toNext, 1 / distNext);
  const a = add(corner.point, scale(unitPrev, r));
  const b = add(corner.point, scale(unitNext, r));
  const c1 = { x: a.x + (corner.point.x - a.x) * CORNER_KAPPA, y: a.y + (corner.point.y - a.y) * CORNER_KAPPA };
  const c2 = { x: b.x + (corner.point.x - b.x) * CORNER_KAPPA, y: b.y + (corner.point.y - b.y) * CORNER_KAPPA };

  const nodeA: PathNode = { id: shortId("node"), point: a, handleIn: null, handleOut: c1, type: "smooth" };
  const nodeB: PathNode = { id: shortId("node"), point: b, handleIn: c2, handleOut: null, type: "smooth" };

  contour.nodes.splice(idx, 1, nodeA, nodeB);
  return working;
}

/**
 * Identifies whether `ref` points at one half of a rounded-corner fillet —
 * the two-node, single-handle-each pair `roundCorner` produces (an on-curve
 * node with a handle facing the corner but none facing its own neighbor,
 * next to a partner with the mirror-image handle setup). Returns both
 * nodes in contour order plus their outer neighbors (the points the
 * fillet's straight edges run to), which is everything needed to
 * reconstruct the corner they came from.
 */
export interface FilletPair {
  contourId: string;
  aId: string;
  bId: string;
  a: Point;
  b: Point;
  prevOfA: Point;
  nextOfB: Point;
}

function isFilletStart(n: PathNode): boolean {
  return !!n.handleOut && !n.handleIn;
}
function isFilletEnd(n: PathNode): boolean {
  return !!n.handleIn && !n.handleOut;
}

export function findFilletPair(outline: GlyphOutline, ref: { contourId: string; nodeId: string }): FilletPair | null {
  const contour = findContour(outline, ref.contourId);
  if (!contour) return null;
  const n = contour.nodes.length;
  if (n < 4) return null;
  const idx = contour.nodes.findIndex((node) => node.id === ref.nodeId);
  if (idx === -1) return null;
  const node = contour.nodes[idx];

  let aIdx: number, bIdx: number;
  if (isFilletStart(node)) {
    aIdx = idx;
    bIdx = contour.closed ? (idx + 1) % n : idx + 1;
  } else if (isFilletEnd(node)) {
    bIdx = idx;
    aIdx = contour.closed ? (idx - 1 + n) % n : idx - 1;
  } else {
    return null;
  }
  if (aIdx < 0 || aIdx >= n || bIdx < 0 || bIdx >= n || aIdx === bIdx) return null;

  const a = contour.nodes[aIdx];
  const b = contour.nodes[bIdx];
  if (!isFilletStart(a) || !isFilletEnd(b)) return null;

  const prevIdx = contour.closed ? (aIdx - 1 + n) % n : aIdx - 1;
  const nextIdx = contour.closed ? (bIdx + 1) % n : bIdx + 1;
  if (prevIdx < 0 || prevIdx >= n || nextIdx < 0 || nextIdx >= n || prevIdx === bIdx || nextIdx === aIdx) return null;

  return {
    contourId: ref.contourId,
    aId: a.id,
    bId: b.id,
    a: a.point,
    b: b.point,
    prevOfA: contour.nodes[prevIdx].point,
    nextOfB: contour.nodes[nextIdx].point,
  };
}

function lineIntersection(p1: Point, d1: Point, p2: Point, d2: Point): Point | null {
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-9) return null; // parallel edges — no corner to reconstruct
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / denom;
  return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
}

/**
 * Reconstructs the sharp corner a fillet pair was rounded from: the
 * intersection of the line through (prevOfA, a) and the line through
 * (nextOfB, b). Those two lines are exactly the fillet's straight edges
 * extended back to where they'd meet, which is the original corner point
 * for any pair `roundCorner` produced (and for a hand-built equivalent).
 */
export function reconstructCorner(
  outline: GlyphOutline,
  ref: { contourId: string; nodeId: string }
): { pair: FilletPair; corner: Point } | null {
  const pair = findFilletPair(outline, ref);
  if (!pair) return null;
  const corner = lineIntersection(pair.prevOfA, subtract(pair.a, pair.prevOfA), pair.nextOfB, subtract(pair.b, pair.nextOfB));
  if (!corner) return null;
  return { pair, corner };
}

/**
 * Un-does a fillet: collapses the two-node rounded-corner pair back into a
 * single sharp corner node at the reconstructed corner point. This is the
 * starting point for reversing a Cmd/Ctrl+drag rounding — run this once, then
 * feed the result into `roundCorner` exactly like a fresh corner-round, so
 * dragging back to the reconstructed corner position restores the sharp
 * corner and dragging anywhere else re-fillets at the new radius.
 */
export function unroundCorner(
  outline: GlyphOutline,
  ref: { contourId: string; nodeId: string }
): { outline: GlyphOutline; contourId: string; nodeId: string; cornerPoint: Point } | null {
  const result = reconstructCorner(outline, ref);
  if (!result) return null;
  const { pair, corner } = result;
  const working = cloneOutline(outline);
  const contour = findContour(working, pair.contourId);
  if (!contour) return null;
  const n = contour.nodes.length;
  const aIdx = contour.nodes.findIndex((node) => node.id === pair.aId);
  const bIdx = contour.nodes.findIndex((node) => node.id === pair.bId);
  if (aIdx === -1 || bIdx === -1) return null;

  const cornerNode: PathNode = { id: shortId("node"), point: corner, handleIn: null, handleOut: null, type: "corner" };
  if (bIdx === aIdx + 1) {
    contour.nodes.splice(aIdx, 2, cornerNode);
  } else if (contour.closed && aIdx === n - 1 && bIdx === 0) {
    // Pair wraps around the end of a closed contour: the two nodes aren't
    // contiguous in array order, so remove them individually.
    contour.nodes.splice(aIdx, 1);
    contour.nodes.splice(0, 1, cornerNode);
  } else {
    return null; // shouldn't happen given findFilletPair's construction
  }

  return { outline: working, contourId: pair.contourId, nodeId: cornerNode.id, cornerPoint: corner };
}
