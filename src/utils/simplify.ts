import type { Point } from "@/types/geometry";

/**
 * Ramer–Douglas–Peucker simplification. Keeps the polyline's overall shape
 * while dropping points that don't deviate from the line between their
 * neighbors by more than `epsilon` (font units).
 *
 * Iterative and index-based: the recursive version copied a slice of the
 * array at every split (O(n log n) allocations, O(n²) worst case), which
 * dominated stroke/outline building on dense point sets. The kept points and
 * their order are identical.
 */
export function simplifyPolyline<T extends Point>(points: T[], epsilon: number): T[] {
  const n = points.length;
  if (n < 3 || epsilon <= 0) return points;

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const hi = stack.pop()!;
    const lo = stack.pop()!;
    if (hi - lo < 2) continue;

    const a = points[lo];
    const b = points[hi];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let maxDist = 0;
    let maxIndex = lo;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i];
      let d: number;
      if (lenSq === 0) {
        d = Math.hypot(p.x - a.x, p.y - a.y);
      } else {
        const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
        d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      }
      if (d > maxDist) {
        maxDist = d;
        maxIndex = i;
      }
    }
    if (maxDist > epsilon) {
      keep[maxIndex] = 1;
      stack.push(lo, maxIndex, maxIndex, hi);
    }
  }

  const out: T[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}
