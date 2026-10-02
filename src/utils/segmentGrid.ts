import type { Point } from "@/types/geometry";

/**
 * Uniform-grid pruning for "does this polygon cross itself / another
 * polygon" tests. The naive test compares every segment against every
 * other (O(n²)); a hand-drawn or brush outline has hundreds to thousands of
 * segments, but any given segment can only cross the few that share its
 * neighbourhood. Bucketing segments by the grid cells their bounding box
 * touches turns the test into roughly O(n) while returning EXACTLY the same
 * answer — a pair is skipped only when their bounding boxes cannot overlap,
 * and two segments whose boxes don't overlap can't cross.
 */

/** Below this many segments the naive loop is faster than building a grid. */
export const GRID_MIN_SEGMENTS = 48;

interface Grid {
  cell: number;
  cells: Map<number, number[]>;
  minX: number;
  minY: number;
}

function buildGrid(ring: Point[], closed: boolean): Grid {
  const n = ring.length;
  const segCount = closed ? n : n - 1;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    const q = ring[(i + 1) % n];
    total += Math.hypot(q.x - p.x, q.y - p.y);
  }
  // Cell ≈ 2× the average segment length: most segments touch 1–4 cells.
  const cell = Math.max(1e-6, (total / Math.max(1, segCount)) * 2, (Math.max(maxX - minX, maxY - minY)) / 512);
  const grid: Grid = { cell, cells: new Map(), minX, minY };
  for (let i = 0; i < segCount; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    forCells(grid, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), (key) => {
      const list = grid.cells.get(key);
      if (list) list.push(i);
      else grid.cells.set(key, [i]);
    });
  }
  return grid;
}

function forCells(grid: Grid, x0: number, y0: number, x1: number, y1: number, fn: (key: number) => void): void {
  const pad = 1e-7;
  const cx0 = Math.floor((x0 - pad - grid.minX) / grid.cell);
  const cx1 = Math.floor((x1 + pad - grid.minX) / grid.cell);
  const cy0 = Math.floor((y0 - pad - grid.minY) / grid.cell);
  const cy1 = Math.floor((y1 + pad - grid.minY) / grid.cell);
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) fn(cx * 73856093 + cy * 19349663);
}

/**
 * True if any two NON-ADJACENT segments of the closed `ring` satisfy
 * `crosses` — the same pairs, in effect, as the naive double loop
 * (i, j ≥ i+2, excluding the first/last pair that meet at the wrap-around).
 */
export function closedRingHasCrossing(
  ring: Point[],
  crosses: (a0: Point, a1: Point, b0: Point, b1: Point) => boolean,
): boolean {
  const n = ring.length;
  if (n < 4) return false;
  if (n < GRID_MIN_SEGMENTS) {
    for (let i = 0; i < n; i++) {
      const a0 = ring[i], a1 = ring[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        if (crosses(a0, a1, ring[j], ring[(j + 1) % n])) return true;
      }
    }
    return false;
  }
  const grid = buildGrid(ring, true);
  const stamp = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const a0 = ring[i], a1 = ring[(i + 1) % n];
    let hit = false;
    forCells(grid, Math.min(a0.x, a1.x), Math.min(a0.y, a1.y), Math.max(a0.x, a1.x), Math.max(a0.y, a1.y), (key) => {
      if (hit) return;
      const list = grid.cells.get(key);
      if (!list) return;
      for (const j of list) {
        if (j < i + 2 || stamp[j] === i) continue;
        if (i === 0 && j === n - 1) continue;
        stamp[j] = i;
        if (crosses(a0, a1, ring[j], ring[(j + 1) % n])) {
          hit = true;
          return;
        }
      }
    });
    if (hit) return true;
  }
  return false;
}

// Grids are cached per ring array: one big ring (a letter body) is tested
// against thousands of small ones (paint dots), and rebuilding its grid for
// every pair was O(bigRingPoints) each time.
const gridCache = new WeakMap<Point[], { grid: Grid; stamp: Int32Array; tick: number }>();

/** True if any segment of closed ring `a` satisfies `crosses` with any segment of closed ring `b`. */
export function closedRingsHaveCrossing(
  a: Point[],
  b: Point[],
  crosses: (a0: Point, a1: Point, b0: Point, b1: Point) => boolean,
): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length * b.length < GRID_MIN_SEGMENTS * GRID_MIN_SEGMENTS) {
    for (let i = 0; i < a.length; i++) {
      const a0 = a[i], a1 = a[(i + 1) % a.length];
      for (let j = 0; j < b.length; j++) if (crosses(a0, a1, b[j], b[(j + 1) % b.length])) return true;
    }
    return false;
  }
  // Grid the LARGER ring (cached), walk the smaller one over it. `crosses`
  // is symmetric in which ring is which, so swapping doesn't change the answer.
  const swap = b.length < a.length;
  const walker = swap ? b : a;
  const gridded = swap ? a : b;
  let entry = gridCache.get(gridded);
  if (!entry) {
    entry = { grid: buildGrid(gridded, true), stamp: new Int32Array(gridded.length).fill(-1), tick: 0 };
    gridCache.set(gridded, entry);
  }
  const { grid, stamp } = entry;
  const ng = gridded.length;
  const nw = walker.length;
  for (let i = 0; i < nw; i++) {
    const w0 = walker[i], w1 = walker[(i + 1) % nw];
    const mark = ++entry.tick;
    let hit = false;
    forCells(grid, Math.min(w0.x, w1.x), Math.min(w0.y, w1.y), Math.max(w0.x, w1.x), Math.max(w0.y, w1.y), (key) => {
      if (hit) return;
      const list = grid.cells.get(key);
      if (!list) return;
      for (const j of list) {
        if (stamp[j] === mark) continue;
        stamp[j] = mark;
        const g0 = gridded[j], g1 = gridded[(j + 1) % ng];
        if (swap ? crosses(g0, g1, w0, w1) : crosses(w0, w1, g0, g1)) {
          hit = true;
          return;
        }
      }
    });
    if (hit) return true;
  }
  return false;
}
