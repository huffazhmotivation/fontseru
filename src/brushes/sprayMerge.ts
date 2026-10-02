import type { Contour, PathNode, Point } from "@/types/geometry";
import { flattenContour } from "@/editor/objectOps";
import { shortId } from "@/utils/id";

/**
 * Fast "union" of a Spray Brush stroke's pieces (solid core + thousands of
 * paint dots) into a few merged, compact outlines.
 *
 * A stroke like an "H" is ~11,000 separate little contours (78,000 nodes, a
 * 2.4 MB path string) — heavy to store, build into a path, paint and export.
 * Merging them with an exact polygon clipper takes seconds per glyph, because
 * the clipper's cost grows with every dot edge it has to sweep.
 *
 * This does the same merge in time that depends on the stroke's AREA, not on
 * how many dots it has:
 *   1. Rasterize every piece onto a coverage grid (nonzero winding, so
 *      overlapping dots and the core simply add up, and the core's counters
 *      stay open), with 4× vertical / exact horizontal partial coverage.
 *   2. Trace the boundary of the covered region at 50% coverage with
 *      marching squares, interpolating along each grid edge — so the
 *      outline sits between samples, accurate to a small fraction of a cell
 *      rather than snapped to a staircase.
 *   3. Thin each traced loop with a tight Douglas–Peucker tolerance.
 * The result is the union outline: overlapping dots are one shape, exterior
 * rings and holes wound opposite, ready for nonzero fill or a font.
 */

const SUB_ROWS = 4;
const ROW_WEIGHT = 63; // 4 × 63 = 252 max coverage, fits a byte with no wrap
const ISO = 126;
const MAX_CELLS = 4_000_000;
const PAD_CELLS = 3;

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function signedAreaCCW(pts: Point[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return -a / 2; // positive for counter-clockwise (y up)
}

function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Douglas–Peucker over a closed loop, anchored at the two points that are
 * furthest apart so it doesn't depend on where the trace happened to start. */
function simplifyLoop(pts: Point[], eps: number): Point[] {
  const n = pts.length;
  if (n <= 4) return pts;
  let a = 0;
  let b = 0;
  let best = -1;
  // Cheap far-pair estimate: furthest from point 0, then furthest from that.
  for (let pass = 0; pass < 2; pass++) {
    const from = pass === 0 ? 0 : a;
    let far = from;
    let fd = -1;
    for (let i = 0; i < n; i++) {
      const d = (pts[i].x - pts[from].x) ** 2 + (pts[i].y - pts[from].y) ** 2;
      if (d > fd) {
        fd = d;
        far = i;
      }
    }
    if (pass === 0) a = far;
    else {
      b = far;
      best = fd;
    }
  }
  if (best <= 0 || a === b) return pts;
  const keep = new Uint8Array(n);
  keep[a] = 1;
  keep[b] = 1;
  const stack: number[] = [];
  const run = (from: number, to: number) => {
    // indices from→to going forward around the loop (exclusive ends)
    const len = (to - from + n) % n;
    if (len >= 2) stack.push(from, to);
  };
  run(a, b);
  run(b, a);
  while (stack.length > 0) {
    const to = stack.pop()!;
    const from = stack.pop()!;
    const pa = pts[from];
    const pb = pts[to];
    const len = (to - from + n) % n;
    let maxD = 0;
    let maxI = -1;
    for (let k = 1; k < len; k++) {
      const i = (from + k) % n;
      const d = perpDist(pts[i], pa, pb);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxI >= 0 && maxD > eps) {
      keep[maxI] = 1;
      run(from, maxI);
      run(maxI, to);
    }
  }
  const out: Point[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/**
 * Merges same-winding spray pieces (core rings + dots, plus any counters
 * wound the opposite way) into union outlines. `outerSign` is the
 * `signedArea` sign the caller uses for exterior rings; the returned
 * exteriors carry it and holes carry the opposite, so nonzero fill and font
 * export treat them exactly like the input.
 *
 * Returns null when there's nothing to merge or the grid would be absurd,
 * so the caller keeps the unmerged contours.
 */
export function mergeSprayContours(
  contours: Contour[],
  outerSign: number,
  signedAreaFn: (pts: Point[]) => number,
): Contour[] | null {
  if (contours.length < 2) return null;

  // ---- Flatten + bounds --------------------------------------------------
  const rings: Point[][] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of contours) {
    if (c.nodes.length < 3) continue;
    const flat = flattenContour(c, c.nodes.length > 12 ? 4 : 10);
    if (flat.length < 3) continue;
    rings.push(flat);
    for (const p of flat) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (rings.length === 0 || !Number.isFinite(minX)) return null;

  // Cell size: fine enough that a ~1 unit dot spans several cells, coarser
  // for very large strokes so the grid stays bounded.
  const w0 = maxX - minX;
  const h0 = maxY - minY;
  let cell = 0.4;
  if ((w0 / cell + 2 * PAD_CELLS) * (h0 / cell + 2 * PAD_CELLS) > MAX_CELLS) {
    cell = Math.sqrt((w0 * h0) / MAX_CELLS) * 1.02;
  }
  if (cell > 1.2) return null;
  const W = Math.ceil(w0 / cell) + 2 * PAD_CELLS + 1;
  const H = Math.ceil(h0 / cell) + 2 * PAD_CELLS + 1;
  const ox = minX - PAD_CELLS * cell;
  const oy = minY - PAD_CELLS * cell;
  const grid = new Uint8Array(W * H);

  // ---- Rasterize (nonzero winding, sub-rows) ------------------------------
  // Every polygon edge is bucketed (counting sort, CSR layout) by the
  // sub-rows whose centre line it crosses; each sub-row then sorts its
  // crossings natively (x and direction packed into one float) and fills the
  // spans where the winding number is non-zero.
  const subH = H * SUB_ROWS;
  const subCell = cell / SUB_ROWS;
  let edgeTotal = 0;
  for (const ring of rings) edgeTotal += ring.length;
  const ex0 = new Float64Array(edgeTotal);
  const ey0 = new Float64Array(edgeTotal);
  const ex1 = new Float64Array(edgeTotal);
  const ey1 = new Float64Array(edgeTotal);
  const edir = new Int8Array(edgeTotal);
  const erow0 = new Int32Array(edgeTotal);
  const erow1 = new Int32Array(edgeTotal);
  const counts = new Int32Array(subH + 1);
  let ne = 0;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      if (a.y === b.y) continue;
      const up = b.y > a.y;
      const lo = up ? a : b;
      const hi = up ? b : a;
      const r0 = Math.max(0, Math.ceil((lo.y - oy) / subCell - 0.5));
      const r1 = Math.min(subH - 1, Math.ceil((hi.y - oy) / subCell - 0.5) - 1);
      if (r1 < r0) continue;
      ex0[ne] = lo.x; ey0[ne] = lo.y; ex1[ne] = hi.x; ey1[ne] = hi.y;
      edir[ne] = up ? 1 : -1;
      erow0[ne] = r0; erow1[ne] = r1;
      for (let r = r0; r <= r1; r++) counts[r + 1]++;
      ne++;
    }
  }
  for (let r = 0; r < subH; r++) counts[r + 1] += counts[r];
  const fill = counts.slice(0, subH);
  const slots = new Int32Array(counts[subH]);
  for (let e = 0; e < ne; e++) for (let r = erow0[e]; r <= erow1[e]; r++) slots[fill[r]++] = e;

  const KEY_SCALE = 4096;
  let keys = new Float64Array(256);
  for (let r = 0; r < subH; r++) {
    const from = counts[r];
    const to = counts[r + 1];
    const m = to - from;
    if (m < 2) continue;
    if (keys.length < m) keys = new Float64Array(m * 2);
    const yc = oy + (r + 0.5) * subCell;
    for (let k = 0; k < m; k++) {
      const e = slots[from + k];
      const t = (yc - ey0[e]) / (ey1[e] - ey0[e]);
      const x = ex0[e] + (ex1[e] - ex0[e]) * t;
      keys[k] = Math.round((x - ox) * KEY_SCALE) * 2 + (edir[e] > 0 ? 1 : 0);
    }
    const sorted = keys.subarray(0, m).sort();
    const base = ((r / SUB_ROWS) | 0) * W;
    let wind = 0;
    for (let k = 0; k < m - 1; k++) {
      const kv = sorted[k];
      const bit = kv - Math.floor(kv / 2) * 2;
      wind += bit === 1 ? 1 : -1;
      if (wind === 0) continue;
      const xa = (kv - bit) / 2 / KEY_SCALE / cell;
      const kn = sorted[k + 1];
      const xb = (kn - (kn - Math.floor(kn / 2) * 2)) / 2 / KEY_SCALE / cell;
      if (xb <= xa) continue;
      const ia = Math.floor(xa);
      const ib = Math.floor(xb);
      if (ia === ib) {
        const v = grid[base + ia] + Math.round((xb - xa) * ROW_WEIGHT);
        grid[base + ia] = v > 255 ? 255 : v;
      } else {
        let v = grid[base + ia] + Math.round((ia + 1 - xa) * ROW_WEIGHT);
        grid[base + ia] = v > 255 ? 255 : v;
        for (let i = ia + 1; i < ib; i++) {
          v = grid[base + i] + ROW_WEIGHT;
          grid[base + i] = v > 255 ? 255 : v;
        }
        if (ib < W) {
          v = grid[base + ib] + Math.round((xb - ib) * ROW_WEIGHT);
          grid[base + ib] = v > 255 ? 255 : v;
        }
      }
    }
  }

  // ---- Marching squares ---------------------------------------------------
  // Edge ids: horizontal edge between (i,j)-(i+1,j) = 2*(j*W+i); vertical
  // edge between (i,j)-(i,j+1) = 2*(j*W+i)+1. `next[start] = end` for the
  // oriented segment (inside on the left, y up).
  const next = new Int32Array(2 * W * H).fill(-1);
  const val = (i: number, j: number) => grid[j * W + i];
  const eBottom = (i: number, j: number) => 2 * (j * W + i);
  const eTop = (i: number, j: number) => 2 * ((j + 1) * W + i);
  const eLeft = (i: number, j: number) => 2 * (j * W + i) + 1;
  const eRight = (i: number, j: number) => 2 * (j * W + i + 1) + 1;
  const crossing = (key: number): Point => {
    const vertical = key & 1;
    const cellIdx = key >> 1;
    const j = (cellIdx / W) | 0;
    const i = cellIdx - j * W;
    const v0 = grid[cellIdx];
    const v1 = vertical ? grid[cellIdx + W] : grid[cellIdx + 1];
    const t = v1 === v0 ? 0.5 : (ISO - v0) / (v1 - v0);
    // sample (i,j) sits at the centre of its cell
    const cx = i + 0.5 + (vertical ? 0 : t);
    const cy = j + 0.5 + (vertical ? t : 0);
    return { x: ox + cx * cell, y: oy + cy * cell };
  };
  const link = (p: number, q: number, insideCornerX: number, insideCornerY: number, insideOnCornerSide: boolean, i: number, j: number) => {
    // Orient p→q so the inside is on the left. The corner (cornerX,cornerY,
    // in cell-local 0/1 coordinates) lies on the inside side iff insideOnCornerSide.
    const P = edgePointLocal(p, i, j);
    const Q = edgePointLocal(q, i, j);
    const cross = (Q.x - P.x) * (insideCornerY - P.y) - (Q.y - P.y) * (insideCornerX - P.x);
    const leftIsCorner = cross > 0;
    if (leftIsCorner === insideOnCornerSide) next[p] = q;
    else next[q] = p;
  };
  // Approximate local position of an edge midpoint, enough to decide sides.
  const edgePointLocal = (key: number, i: number, j: number) => {
    const vertical = key & 1;
    const cellIdx = key >> 1;
    const jj = (cellIdx / W) | 0;
    const ii = cellIdx - jj * W;
    return { x: ii - i + (vertical ? 0 : 0.5), y: jj - j + (vertical ? 0.5 : 0) };
  };

  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = val(i, j) >= ISO ? 1 : 0; // bottom-left
      const b = val(i + 1, j) >= ISO ? 1 : 0; // bottom-right
      const c = val(i + 1, j + 1) >= ISO ? 1 : 0; // top-right
      const d = val(i, j + 1) >= ISO ? 1 : 0; // top-left
      const mask = a | (b << 1) | (c << 2) | (d << 3);
      if (mask === 0 || mask === 15) continue;
      const bo = eBottom(i, j), ri = eRight(i, j), to = eTop(i, j), le = eLeft(i, j);
      switch (mask) {
        case 1: case 14: link(bo, le, 0, 0, mask === 1, i, j); break; // corner a
        case 2: case 13: link(bo, ri, 1, 0, mask === 2, i, j); break; // corner b
        case 4: case 11: link(ri, to, 1, 1, mask === 4, i, j); break; // corner c
        case 8: case 7: link(to, le, 0, 1, mask === 8, i, j); break; // corner d
        case 3: case 12: link(le, ri, 0, 0, mask === 3, i, j); break; // a,b vs c,d
        case 6: case 9: link(bo, to, 1, 0, mask === 6, i, j); break; // b,c vs a,d
        case 5: case 10: {
          // saddle: decide connectivity by the cell's mean coverage
          const centre = (val(i, j) + val(i + 1, j) + val(i + 1, j + 1) + val(i, j + 1)) / 4 >= ISO;
          if (mask === 5) {
            // a and c inside
            if (centre) { link(bo, ri, 1, 0, false, i, j); link(to, le, 0, 1, false, i, j); }
            else { link(bo, le, 0, 0, true, i, j); link(ri, to, 1, 1, true, i, j); }
          } else {
            // b and d inside
            if (centre) { link(bo, le, 0, 0, false, i, j); link(ri, to, 1, 1, false, i, j); }
            else { link(bo, ri, 1, 0, true, i, j); link(to, le, 0, 1, true, i, j); }
          }
          break;
        }
      }
    }
  }

  // ---- Walk loops ---------------------------------------------------------
  const visited = new Uint8Array(next.length);
  const loops: Point[][] = [];
  for (let start = 0; start < next.length; start++) {
    if (next[start] < 0 || visited[start]) continue;
    const pts: Point[] = [];
    let key = start;
    let guard = 0;
    while (key >= 0 && !visited[key] && guard++ < 5_000_000) {
      visited[key] = 1;
      pts.push(crossing(key));
      key = next[key];
    }
    if (key === start && pts.length >= 3) loops.push(pts);
  }
  if (loops.length === 0) return null;

  // ---- Simplify + emit -----------------------------------------------------
  const out: Contour[] = [];
  for (const loop of loops) {
    const areaCCW = signedAreaCCW(loop);
    const absA = Math.abs(areaCCW);
    if (absA < 0.25) continue; // sub-visible speck
    const eps = Math.min(0.3, Math.max(0.06, 0.028 * Math.sqrt(absA)));
    let pts = simplifyLoop(loop, eps);
    if (pts.length < 3) continue;
    const isOuter = areaCCW > 0;
    const want = isOuter ? outerSign : -outerSign;
    if (Math.sign(signedAreaFn(pts)) !== want) pts = pts.slice().reverse();
    const nodes: PathNode[] = pts.map((p) => ({ id: shortId("node"), point: p, handleIn: null, handleOut: null, type: "corner" }));
    out.push({ id: shortId("contour"), closed: true, nodes });
  }
  return out.length > 0 ? out : null;
}

export type { Edge as SprayMergeEdge };
