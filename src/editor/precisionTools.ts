/**
 * Precision node editing — the geometry behind the Node tool's pro features:
 *
 *  - Segment hover: the segment under the pointer, its length, and the stem
 *    thickness measured straight across the shape at that spot.
 *  - Segment reshape: drag a curve itself; its handles keep their angles and
 *    only change length (so smooth joins and horizontal/vertical extremes stay
 *    exactly as drawn), the way type designers expect.
 *  - Tunni line: the line between a curve's two handle tips. Dragging its
 *    midpoint scales both handles together (curve "tension"); tension is shown
 *    as handle length ÷ distance to where the two handle lines meet.
 *  - Transform box around 2+ selected nodes: scale from any edge/corner, or
 *    rotate with the knob above it.
 *  - Smart guides: alignment targets for a dragged node (other nodes and the
 *    font's vertical metrics / side bearings).
 *
 * Everything is pure; outlines are never mutated (contours that change are
 * cloned with cloneOutlineTouching, the rest stay shared).
 */
import type { Contour, GlyphOutline, PathNode, Point, VectorObject } from "@/types/geometry";
import { cubicPoint, cubicTangent } from "./bezier";
import { cloneOutlineTouching, findContour } from "./nodeOps";

export interface SegmentRef { contourId: string; fromIndex: number }
export interface Segment {
  p0: Point;
  c1: Point;
  c2: Point;
  p3: Point;
  isCurve: boolean;
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const addP = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const len = (a: Point) => Math.hypot(a.x, a.y);
const dotP = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const roundP = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** Set a segment-side handle; a symmetric node mirrors it on its other side
 *  so the node keeps its type (smooth nodes already stay collinear because
 *  these tools only change handle lengths, never angles). */
function setSegmentHandle(node: PathNode, side: "in" | "out", h: Point): void {
  const p = roundP(h);
  if (side === "out") node.handleOut = p; else node.handleIn = p;
  if (node.type !== "symmetric") return;
  const mirror = { x: 2 * node.point.x - p.x, y: 2 * node.point.y - p.y };
  if (side === "out") { if (node.handleIn) node.handleIn = mirror; }
  else if (node.handleOut) node.handleOut = mirror;
}

export function segmentOf(contour: Contour, fromIndex: number): Segment | null {
  const n = contour.nodes.length;
  if (n < 2) return null;
  if (!contour.closed && fromIndex >= n - 1) return null;
  const a = contour.nodes[fromIndex];
  const b = contour.nodes[(fromIndex + 1) % n];
  if (!a || !b) return null;
  const isCurve = Boolean(a.handleOut || b.handleIn);
  return { p0: a.point, c1: a.handleOut ?? a.point, c2: b.handleIn ?? b.point, p3: b.point, isCurve };
}

export function findSegment(outline: GlyphOutline, ref: SegmentRef): Segment | null {
  const contour = findContour(outline, ref.contourId);
  return contour ? segmentOf(contour, ref.fromIndex) : null;
}

export function segmentPoint(s: Segment, t: number): Point {
  return s.isCurve ? cubicPoint(s.p0, s.c1, s.c2, s.p3, t) : addP(s.p0, mul(sub(s.p3, s.p0), t));
}

/** Unit normal at t (left of the direction of travel). */
export function segmentNormal(s: Segment, t: number): Point {
  let d = s.isCurve ? cubicTangent(s.p0, s.c1, s.c2, s.p3, t) : sub(s.p3, s.p0);
  if (len(d) < 1e-9) d = sub(s.p3, s.p0);
  const l = len(d) || 1;
  return { x: -d.y / l, y: d.x / l };
}

export function segmentLength(s: Segment): number {
  if (!s.isCurve) return len(sub(s.p3, s.p0));
  let total = 0;
  let prev = s.p0;
  const steps = 48;
  for (let i = 1; i <= steps; i++) {
    const p = cubicPoint(s.p0, s.c1, s.c2, s.p3, i / steps);
    total += len(sub(p, prev));
    prev = p;
  }
  return total;
}

/** SVG path data for one segment, in SVG space (y flipped at `ascender`). */
export function segmentPathD(s: Segment, ascender: number): string {
  const f = (p: Point) => `${p.x},${ascender - p.y}`;
  return s.isCurve ? `M${f(s.p0)}C${f(s.c1)} ${f(s.c2)} ${f(s.p3)}` : `M${f(s.p0)}L${f(s.p3)}`;
}

// --------------------------------------------------------------- thickness

/** A flattened contour plus the bounding box of every run of CHUNK edges, so
 *  ray casts can skip most of a big outline without touching its edges. */
interface FlatPoly { pts: Point[]; boxes: number[] }
const CHUNK = 16;
const flatCache = new WeakMap<VectorObject, FlatPoly[]>();

function flattenObject(obj: VectorObject): FlatPoly[] {
  const cached = flatCache.get(obj);
  if (cached) return cached;
  const polys: FlatPoly[] = [];
  for (const contour of obj.contours) {
    const n = contour.nodes.length;
    if (n < 2) continue;
    const pts: Point[] = [contour.nodes[0].point];
    const count = contour.closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const s = segmentOf(contour, i);
      if (!s) continue;
      if (s.isCurve) for (let k = 1; k <= 16; k++) pts.push(cubicPoint(s.p0, s.c1, s.c2, s.p3, k / 16));
      else pts.push(s.p3);
    }
    // Edge i runs from pts[i-1] (pts[last] for i = 0) to pts[i].
    const boxes: number[] = [];
    for (let c = 0; c < pts.length; c += CHUNK) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const end = Math.min(pts.length, c + CHUNK);
      for (let i = c === 0 ? -1 : c - 1; i < end; i++) {
        const q = pts[i < 0 ? pts.length - 1 : i];
        if (q.x < minX) minX = q.x;
        if (q.x > maxX) maxX = q.x;
        if (q.y < minY) minY = q.y;
        if (q.y > maxY) maxY = q.y;
      }
      boxes.push(minX, minY, maxX, maxY);
    }
    polys.push({ pts, boxes });
  }
  flatCache.set(obj, polys);
  return polys;
}

function windingAt(polys: FlatPoly[], p: Point): number {
  let w = 0;
  for (const { pts: poly, boxes } of polys) {
    for (let c = 0, b = 0; c < poly.length; c += CHUNK, b += 4) {
      // Only edges straddling y = p.y to the right of p can count.
      if (p.y < boxes[b + 1] || p.y > boxes[b + 3] || p.x > boxes[b + 2]) continue;
      const end = Math.min(poly.length, c + CHUNK);
      for (let i = c; i < end; i++) {
        const a = poly[i === 0 ? poly.length - 1 : i - 1], bb = poly[i];
        if (a.y <= p.y) {
          if (bb.y > p.y && (bb.x - a.x) * (p.y - a.y) - (p.x - a.x) * (bb.y - a.y) > 0) w++;
        } else if (bb.y <= p.y && (bb.x - a.x) * (p.y - a.y) - (p.x - a.x) * (bb.y - a.y) < 0) w--;
      }
    }
  }
  return w;
}

/** Does the ray o + t·d, t in [t0, t1], pass through the box? (slab test) */
function rayHitsBox(o: Point, d: Point, t0: number, t1: number, minX: number, minY: number, maxX: number, maxY: number): boolean {
  let lo = t0, hi = t1;
  if (Math.abs(d.x) < 1e-12) { if (o.x < minX || o.x > maxX) return false; }
  else {
    let a = (minX - o.x) / d.x, b = (maxX - o.x) / d.x;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > lo) lo = a;
    if (b < hi) hi = b;
    if (lo > hi) return false;
  }
  if (Math.abs(d.y) < 1e-12) { if (o.y < minY || o.y > maxY) return false; }
  else {
    let a = (minY - o.y) / d.y, b = (maxY - o.y) / d.y;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > lo) lo = a;
    if (b < hi) hi = b;
    if (lo > hi) return false;
  }
  return true;
}

function rayHit(polys: FlatPoly[], o: Point, d: Point, minT: number, maxT: number): number {
  let best = maxT;
  let found = false;
  for (const { pts: poly, boxes } of polys) {
    for (let c = 0, bi = 0; c < poly.length; c += CHUNK, bi += 4) {
      if (!rayHitsBox(o, d, minT, best, boxes[bi], boxes[bi + 1], boxes[bi + 2], boxes[bi + 3])) continue;
      const end = Math.min(poly.length, c + CHUNK);
      for (let i = c; i < end; i++) {
        const a = poly[i === 0 ? poly.length - 1 : i - 1], b = poly[i];
        const ex = b.x - a.x, ey = b.y - a.y;
        const den = d.x * ey - d.y * ex;
        if (Math.abs(den) < 1e-12) continue;
        const aox = a.x - o.x, aoy = a.y - o.y;
        const t = (aox * ey - aoy * ex) / den;
        const u = (aox * d.y - aoy * d.x) / den;
        if (t > minT && u >= 0 && u <= 1 && t < best) { best = t; found = true; }
      }
    }
  }
  return found ? best : Infinity;
}

/**
 * Stem thickness straight across the filled shape at `point` (on a contour),
 * along `normal`. Returns the measured span, or null if the point isn't on the
 * edge of a filled area (e.g. an open line).
 */
export function measureThickness(outline: GlyphOutline, point: Point, normal: Point, maxLength: number): { from: Point; to: Point; distance: number } | null {
  const polys = outline.objects.flatMap((o) => flattenObject(o));
  if (!polys.length) return null;
  const eps = 0.5;
  let best: { from: Point; to: Point; distance: number } | null = null;
  for (const dir of [normal, mul(normal, -1)]) {
    const t = rayHit(polys, point, dir, eps, maxLength);
    if (!Number.isFinite(t)) continue;
    const mid = addP(point, mul(dir, t / 2));
    if (windingAt(polys, mid) === 0) continue;
    if (!best || t < best.distance) best = { from: point, to: addP(point, mul(dir, t)), distance: t };
  }
  return best;
}

// --------------------------------------------------------------- reshape

function handleDirection(node: PathNode, side: "in" | "out", fallbackTo: Point): { dir: Point; len: number } {
  const handle = side === "out" ? node.handleOut : node.handleIn;
  if (handle) {
    const v = sub(handle, node.point);
    const l = len(v);
    if (l >= 1e-6) return { dir: mul(v, 1 / l), len: l };
  }
  // A retracted handle on a smooth node still has a tangent: the mirror of
  // its partner. Keeps the join smooth when the segment is pulled out again.
  const partner = side === "out" ? node.handleIn : node.handleOut;
  if (partner && node.type !== "corner") {
    const v = sub(node.point, partner);
    const l = len(v);
    if (l >= 1e-6) return { dir: mul(v, 1 / l), len: 0 };
  }
  const f = sub(fallbackTo, node.point);
  const fl = len(f) || 1;
  return { dir: mul(f, 1 / fl), len: 0 };
}

/**
 * Drag a curve segment so that its point at parameter `t` follows `target`,
 * keeping both handles on their current angles (only their lengths change).
 * Smooth joins and axis-aligned extremes therefore survive the edit. Handles
 * never flip through their node; coordinates land on whole font units.
 */
export function reshapeSegment(outline: GlyphOutline, ref: SegmentRef, t: number, target: Point): GlyphOutline {
  const working = cloneOutlineTouching(outline, [ref.contourId]);
  const contour = findContour(working, ref.contourId);
  if (!contour) return working;
  const n = contour.nodes.length;
  const a = contour.nodes[ref.fromIndex];
  const b = contour.nodes[(ref.fromIndex + 1) % n];
  if (!a || !b) return working;
  const P0 = a.point, P3 = b.point;
  const chord = len(sub(P3, P0)) || 1;
  const hu = handleDirection(a, "out", b.handleIn ?? P3);
  const hv = handleDirection(b, "in", a.handleOut ?? P0);
  const tt = Math.min(0.92, Math.max(0.08, t));
  const mt = 1 - tt;
  const b0 = mt * mt * mt, b1 = 3 * mt * mt * tt, b2 = 3 * mt * tt * tt, b3 = tt * tt * tt;
  const r = sub(target, addP(mul(P0, b0 + b1), mul(P3, b2 + b3)));
  // Columns of M: b1·u and b2·v. Solve (MᵀM + μI) x = Mᵀr + μ·x0 so the
  // answer is exact when the handle directions are independent and stays
  // stable (close to the current lengths) when they are nearly parallel.
  const m1 = mul(hu.dir, b1), m2 = mul(hv.dir, b2);
  const mu = 1e-4 * (b1 * b1 + b2 * b2);
  const A11 = dotP(m1, m1) + mu, A12 = dotP(m1, m2), A22 = dotP(m2, m2) + mu;
  const R1 = dotP(m1, r) + mu * hu.len, R2 = dotP(m2, r) + mu * hv.len;
  const det = A11 * A22 - A12 * A12;
  if (Math.abs(det) < 1e-12) return working;
  let la = (R1 * A22 - R2 * A12) / det;
  let lb = (A11 * R2 - A12 * R1) / det;
  // Never let the drag push a handle past the point where the two handle
  // lines meet (100% Tunni tension): beyond it the handles cross and the
  // curve loops. A handle that already reaches further keeps its length.
  let cap1 = chord * 3, cap2 = chord * 3;
  const den = hu.dir.x * hv.dir.y - hu.dir.y * hv.dir.x;
  if (Math.abs(den) > 1e-6) {
    const w = sub(P3, P0);
    const d1 = (w.x * hv.dir.y - w.y * hv.dir.x) / den;
    const d2 = (w.x * hu.dir.y - w.y * hu.dir.x) / den;
    if (d1 > 0 && d2 > 0) {
      cap1 = Math.min(cap1, Math.max(d1, hu.len));
      cap2 = Math.min(cap2, Math.max(d2, hv.len));
    }
  }
  la = Math.max(0, Math.min(cap1, la));
  lb = Math.max(0, Math.min(cap2, lb));
  setSegmentHandle(a, "out", addP(P0, mul(hu.dir, la)));
  setSegmentHandle(b, "in", addP(P3, mul(hv.dir, lb)));
  return working;
}

// --------------------------------------------------------------- Tunni

export interface TunniInfo {
  ref: SegmentRef;
  /** Handle tips (the Tunni line runs between them). */
  h1: Point;
  h2: Point;
  /** Draggable midpoint of the Tunni line. */
  mid: Point;
  /** Handle length ÷ distance to where the handle lines meet, 0–1+ (null when the lines don't meet ahead of the nodes). */
  tension1: number | null;
  tension2: number | null;
}

function lineIntersection(p: Point, d: Point, q: Point, e: Point): Point | null {
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) < 1e-9) return null;
  const s = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / den;
  return addP(p, mul(d, s));
}

export function tunniOf(outline: GlyphOutline, ref: SegmentRef): TunniInfo | null {
  const contour = findContour(outline, ref.contourId);
  if (!contour) return null;
  const n = contour.nodes.length;
  const a = contour.nodes[ref.fromIndex];
  const b = contour.nodes[(ref.fromIndex + 1) % n];
  if (!a?.handleOut || !b?.handleIn) return null;
  const d1 = sub(a.handleOut, a.point), d2 = sub(b.handleIn, b.point);
  if (len(d1) < 1e-6 || len(d2) < 1e-6) return null;
  const meet = lineIntersection(a.point, d1, b.point, d2);
  let tension1: number | null = null, tension2: number | null = null;
  if (meet) {
    const m1 = sub(meet, a.point), m2 = sub(meet, b.point);
    if (dotP(m1, d1) > 0 && dotP(m2, d2) > 0) {
      tension1 = len(d1) / (len(m1) || 1);
      tension2 = len(d2) / (len(m2) || 1);
    }
  }
  return { ref, h1: a.handleOut, h2: b.handleIn, mid: mul(addP(a.handleOut, b.handleIn), 0.5), tension1, tension2 };
}

/** Curve segments whose two nodes are both selected — the ones that get a
 *  Tunni point. Empty when there are more than `limit` (a whole selected
 *  contour would just be clutter; select one or a few curves to tune them). */
export function selectedCurveSegments(outline: GlyphOutline, selected: ReadonlySet<string>, limit = 8): SegmentRef[] {
  const out: SegmentRef[] = [];
  for (const obj of outline.objects) {
    for (const contour of obj.contours) {
      const n = contour.nodes.length;
      const count = contour.closed ? n : n - 1;
      for (let i = 0; i < count; i++) {
        const a = contour.nodes[i], b = contour.nodes[(i + 1) % n];
        if (!a.handleOut || !b.handleIn) continue;
        if (selected.has(`${contour.id}:${a.id}`) && selected.has(`${contour.id}:${b.id}`)) {
          out.push({ contourId: contour.id, fromIndex: i });
          if (out.length > limit) return [];
        }
      }
    }
  }
  return out;
}

/** Scale both handles of a curve segment by `s` (from their own nodes), as a Tunni-line drag does. */
export function scaleSegmentTension(outline: GlyphOutline, ref: SegmentRef, s: number): GlyphOutline {
  const working = cloneOutlineTouching(outline, [ref.contourId]);
  const contour = findContour(working, ref.contourId);
  if (!contour) return working;
  const n = contour.nodes.length;
  const a = contour.nodes[ref.fromIndex];
  const b = contour.nodes[(ref.fromIndex + 1) % n];
  if (!a?.handleOut || !b?.handleIn) return working;
  const k = Math.max(0.02, Math.min(4, s));
  setSegmentHandle(a, "out", addP(a.point, mul(sub(a.handleOut, a.point), k)));
  setSegmentHandle(b, "in", addP(b.point, mul(sub(b.handleIn, b.point), k)));
  return working;
}

/** Tunni-drag factor: how far the Tunni midpoint has been pulled along its own direction. */
export function tunniScaleFor(base: TunniInfo, segP0: Point, segP3: Point, pointer: Point): number {
  const chordMid = mul(addP(segP0, segP3), 0.5);
  const w = sub(base.mid, chordMid);
  const ww = dotP(w, w);
  if (ww < 1e-9) return 1;
  // M(s) = chordMid + s·w  (both handles scale by s from their nodes).
  return dotP(sub(pointer, chordMid), w) / ww;
}

/** Equalize the two tensions of a curve (double-click on its Tunni point). */
export function balanceSegment(outline: GlyphOutline, ref: SegmentRef): GlyphOutline {
  const info = tunniOf(outline, ref);
  if (!info || info.tension1 == null || info.tension2 == null) return outline;
  const target = (info.tension1 + info.tension2) / 2;
  const working = cloneOutlineTouching(outline, [ref.contourId]);
  const contour = findContour(working, ref.contourId);
  if (!contour) return outline;
  const n = contour.nodes.length;
  const a = contour.nodes[ref.fromIndex];
  const b = contour.nodes[(ref.fromIndex + 1) % n];
  if (!a.handleOut || !b.handleIn) return outline;
  setSegmentHandle(a, "out", addP(a.point, mul(sub(a.handleOut, a.point), target / info.tension1)));
  setSegmentHandle(b, "in", addP(b.point, mul(sub(b.handleIn, b.point), target / info.tension2)));
  return working;
}

// --------------------------------------------------------------- transform box

export interface NodeRefLite { contourId: string; nodeId: string }
/** Transform box geometry, in screen pixels (multiply by font-units-per-px). */
export const BOX_PAD_PX = 14;
export const BOX_ROTATE_GAP_PX = 24;
export const BOX_HANDLE_HIT_PX = 8;
export interface Box { minX: number; minY: number; maxX: number; maxY: number }
export type BoxHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate";

export function selectionBox(outline: GlyphOutline, refs: readonly NodeRefLite[]): Box | null {
  if (refs.length < 2) return null;
  const want = new Set(refs.map((r) => `${r.contourId}:${r.nodeId}`));
  let box: Box | null = null;
  for (const obj of outline.objects) for (const c of obj.contours) for (const node of c.nodes) {
    if (!want.has(`${c.id}:${node.id}`)) continue;
    const p = node.point;
    if (!box) box = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
    else {
      box.minX = Math.min(box.minX, p.x); box.minY = Math.min(box.minY, p.y);
      box.maxX = Math.max(box.maxX, p.x); box.maxY = Math.max(box.maxY, p.y);
    }
  }
  return box;
}

/** Handle positions (font units) for a selection box padded by `pad` units. Degenerate axes get no handles on that axis. */
export function boxHandles(box: Box, pad: number, rotateGap: number): Array<{ id: BoxHandle; p: Point }> {
  const wide = box.maxX - box.minX > 0.5;
  const tall = box.maxY - box.minY > 0.5;
  const x0 = box.minX - pad, x1 = box.maxX + pad, y0 = box.minY - pad, y1 = box.maxY + pad;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const out: Array<{ id: BoxHandle; p: Point }> = [];
  if (wide && tall) {
    out.push({ id: "nw", p: { x: x0, y: y1 } }, { id: "ne", p: { x: x1, y: y1 } }, { id: "se", p: { x: x1, y: y0 } }, { id: "sw", p: { x: x0, y: y0 } });
  }
  if (tall) out.push({ id: "n", p: { x: cx, y: y1 } }, { id: "s", p: { x: cx, y: y0 } });
  if (wide) out.push({ id: "e", p: { x: x1, y: cy } }, { id: "w", p: { x: x0, y: cy } });
  out.push({ id: "rotate", p: { x: cx, y: y1 + rotateGap } });
  return out;
}

/** Apply an affine map to the selected nodes (points and their handles). */
export function transformNodes(outline: GlyphOutline, refs: readonly NodeRefLite[], map: (p: Point) => Point): GlyphOutline {
  const contourIds = new Set(refs.map((r) => r.contourId));
  const want = new Set(refs.map((r) => `${r.contourId}:${r.nodeId}`));
  const working = cloneOutlineTouching(outline, contourIds);
  for (const obj of working.objects) for (const c of obj.contours) {
    if (!contourIds.has(c.id)) continue;
    for (const node of c.nodes) {
      if (!want.has(`${c.id}:${node.id}`)) continue;
      node.point = roundP(map(node.point));
      if (node.handleIn) node.handleIn = roundP(map(node.handleIn));
      if (node.handleOut) node.handleOut = roundP(map(node.handleOut));
    }
  }
  return working;
}

/** Scale/rotate mapping for a transform-box drag. */
export function boxTransform(
  box: Box,
  handle: BoxHandle,
  start: Point,
  pointer: Point,
  opts: { uniform: boolean; fromCenter: boolean; snapAngle: boolean },
): { map: (p: Point) => Point; label: string; identity: boolean } {
  const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
  if (handle === "rotate") {
    const a0 = Math.atan2(start.y - cy, start.x - cx);
    const a1 = Math.atan2(pointer.y - cy, pointer.x - cx);
    let deg = ((a1 - a0) * 180) / Math.PI;
    if (opts.snapAngle) deg = Math.round(deg / 15) * 15;
    const r = (deg * Math.PI) / 180;
    const cos = Math.cos(r), sin = Math.sin(r);
    return {
      map: (p) => ({ x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos }),
      label: `${Math.round(deg * 10) / 10}°`,
      identity: Math.abs(deg) < 0.05,
    };
  }
  const usesX = handle.includes("e") || handle.includes("w");
  const usesY = handle.includes("n") || handle.includes("s");
  const ax = opts.fromCenter ? cx : handle.includes("e") ? box.minX : box.maxX;
  const ay = opts.fromCenter ? cy : handle.includes("n") ? box.minY : box.maxY;
  const sx0 = start.x - ax, sy0 = start.y - ay;
  let sx = usesX && Math.abs(sx0) > 1e-6 ? (pointer.x - ax) / sx0 : 1;
  let sy = usesY && Math.abs(sy0) > 1e-6 ? (pointer.y - ay) / sy0 : 1;
  if (opts.uniform) {
    const s = usesX && usesY ? (Math.abs(sx) > Math.abs(sy) ? sx : sy) : usesX ? sx : sy;
    sx = s;
    sy = s;
  }
  return {
    map: (p) => ({ x: ax + (p.x - ax) * sx, y: ay + (p.y - ay) * sy }),
    label: `${Math.round(sx * 100)}% × ${Math.round(sy * 100)}%`,
    identity: Math.abs(sx - 1) < 5e-4 && Math.abs(sy - 1) < 5e-4,
  };
}

// --------------------------------------------------------------- smart guides

export interface GuideTargets { xs: number[]; ys: number[] }

/** Alignment targets for a node drag: every unselected node, plus metrics and side bearings. */
export function nodeGuideTargets(outline: GlyphOutline, excluded: ReadonlySet<string>, metricYs: number[], metricXs: number[]): GuideTargets {
  const xs = [...metricXs];
  const ys = [...metricYs];
  for (const obj of outline.objects) for (const c of obj.contours) for (const node of c.nodes) {
    if (excluded.has(`${c.id}:${node.id}`)) continue;
    xs.push(node.point.x);
    ys.push(node.point.y);
  }
  return { xs, ys };
}

/** Nearest target on each axis within `tolerance`; null on an axis with nothing close. */
export function nearestGuide(p: Point, targets: GuideTargets, tolerance: number): { x: number | null; y: number | null } {
  let x: number | null = null, y: number | null = null;
  let bx = tolerance, by = tolerance;
  for (const t of targets.xs) { const d = Math.abs(t - p.x); if (d <= bx) { bx = d; x = t; } }
  for (const t of targets.ys) { const d = Math.abs(t - p.y); if (d <= by) { by = d; y = t; } }
  return { x, y };
}
