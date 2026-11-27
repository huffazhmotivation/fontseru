import type { Point, VectorObject } from "@/types/geometry";
import { shortId } from "@/utils/id";

/**
 * Letter grouping for traced images — decides which traced ink islands
 * belong to the same character.
 *
 * The previous grouping compared bounding boxes only, with one global pair
 * of thresholds. That glued an accent or a dot to the wrong letter as soon
 * as two lines of text were close, split "%" into three letters, and broke
 * ":" / "=" / "÷" apart. This version reads the image like a page:
 *
 *  1. Nested parts first: a piece sitting inside another letter's outline
 *     (the inner letter of ©/®, a dot inside a ring) belongs to it.
 *  2. Text lines: full-size pieces ("bodies") that share a vertical band
 *     form a line; the line's height is the yardstick for everything else.
 *  3. Marks (dots, accents, the dot of ? and !) join the body they sit
 *     directly above or below, never one from another line.
 *  4. Stacked marks with no body (":", "=", "÷") join each other.
 *  5. Parts of one glyph that overlap a lot in both directions — the
 *     circles of "%", the halves of a broken hairline — join.
 *
 * Output is in reading order: lines top to bottom, letters left to right.
 */

export interface LetterGroup {
  id: string;
  objects: VectorObject[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

interface Piece {
  obj: VectorObject;
  minX: number; minY: number; maxX: number; maxY: number;
  w: number; h: number; cx: number; cy: number;
  area: number;
  outer: Point[];
}

function piecesOf(objects: VectorObject[]): Piece[] {
  return objects.map((obj) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let area = 0;
    let outer: Point[] = [];
    obj.contours.forEach((c, ci) => {
      const pts = c.nodes.map((n) => n.point);
      for (const n of c.nodes) {
        for (const p of [n.point, n.handleIn, n.handleOut]) {
          if (!p) continue;
          if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
        }
      }
      let a = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
      area += ci === 0 ? Math.abs(a / 2) : -Math.abs(a / 2);
      if (ci === 0) outer = pts;
    });
    const w = Math.max(1e-6, maxX - minX);
    const h = Math.max(1e-6, maxY - minY);
    return { obj, minX, minY, maxX, maxY, w, h, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, area: Math.max(area, 1e-6), outer };
  });
}

function pointInPoly(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) inside = !inside;
  }
  return inside;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const gap = (a0: number, a1: number, b0: number, b1: number) => (a1 < b0 ? b0 - a1 : b1 < a0 ? a0 - b1 : 0);

function median(v: number[]): number {
  if (!v.length) return 1;
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function groupLettersSmart(objects: VectorObject[]): LetterGroup[] {
  if (!objects.length) return [];
  const P = piecesOf(objects);
  const n = P.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  // 1. nested parts
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j || P[j].area <= P[i].area) continue;
      const a = P[i], b = P[j];
      if (a.minX < b.minX || a.maxX > b.maxX || a.minY < b.minY || a.maxY > b.maxY) continue;
      if (pointInPoly({ x: a.cx, y: a.cy }, b.outer)) union(i, j);
    }
  }

  // 2. bodies and text lines
  const tallest = Math.max(...P.map((p) => p.h));
  const bigAreas = P.map((p) => p.area).filter((a) => a > 0);
  const refArea = median(bigAreas.filter((a) => a >= median(bigAreas) * 0.5));
  const isBody = P.map((p) => p.h >= tallest * 0.28 && p.area >= refArea * 0.12);
  // If nothing qualifies (e.g. only dots), treat everything as a body.
  if (!isBody.some(Boolean)) isBody.fill(true);
  const bodyIdx = P.map((_, i) => i).filter((i) => isBody[i]).sort((a, b) => P[a].cy - P[b].cy);
  const lineOf = new Int32Array(n).fill(-1);
  const lines: { minY: number; maxY: number }[] = [];
  for (const i of bodyIdx) {
    const p = P[i];
    let best = -1;
    let bestOv = 0;
    lines.forEach((ln, li) => {
      const ov = overlap(p.minY, p.maxY, ln.minY, ln.maxY) / Math.min(p.h, ln.maxY - ln.minY);
      if (ov > bestOv) { bestOv = ov; best = li; }
    });
    if (best >= 0 && bestOv >= 0.45) {
      lineOf[i] = best;
      lines[best].minY = Math.min(lines[best].minY, p.minY);
      lines[best].maxY = Math.max(lines[best].maxY, p.maxY);
    } else {
      lineOf[i] = lines.length;
      lines.push({ minY: p.minY, maxY: p.maxY });
    }
  }
  const lineHeight = (li: number) => Math.max(1, lines[li].maxY - lines[li].minY);
  const typicalLine = median(lines.map((_, li) => lineHeight(li)));

  // 3. marks → the body directly above/below them
  for (let i = 0; i < n; i++) {
    if (isBody[i]) continue;
    const m = P[i];
    let best = -1;
    let bestScore = Infinity;
    for (const j of bodyIdx) {
      const b = P[j];
      const ovX = overlap(m.minX, m.maxX, b.minX, b.maxX);
      const centreInside = m.cx >= b.minX - b.w * 0.15 && m.cx <= b.maxX + b.w * 0.15;
      if (ovX < Math.min(m.w, b.w) * 0.3 && !centreInside) continue;
      const lh = lineHeight(lineOf[j]);
      const dy = gap(m.minY, m.maxY, b.minY, b.maxY);
      if (dy > lh * 0.75) continue;
      // prefer the closest body, and one whose centre lines up
      const score = dy + Math.abs(m.cx - b.cx) * 0.35;
      if (score < bestScore) { bestScore = score; best = j; }
    }
    if (best >= 0) {
      // A mark sitting on the baseline beside a body (a period, comma) is its
      // own glyph, not part of the letter: it only overlaps vertically.
      const b = P[best];
      const besideOnly = overlap(m.minY, m.maxY, b.minY, b.maxY) >= m.h * 0.6 && overlap(m.minX, m.maxX, b.minX, b.maxX) < m.w * 0.5;
      if (!besideOnly) union(i, best);
    }
  }

  // 4. stacked marks with no body (":", "=", "÷")
  for (let i = 0; i < n; i++) {
    if (isBody[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (isBody[j]) continue;
      if (find(i) !== i && find(j) !== j && find(i) !== find(j)) continue;
      const a = P[i], b = P[j];
      const ovX = overlap(a.minX, a.maxX, b.minX, b.maxX);
      if (ovX < Math.min(a.w, b.w) * 0.5) continue;
      if (gap(a.minY, a.maxY, b.minY, b.maxY) > typicalLine * 0.45) continue;
      // only when neither already belongs to a body
      const ra = find(i), rb = find(j);
      const aAlone = !P.some((_, k) => isBody[k] && find(k) === ra);
      const bAlone = !P.some((_, k) => isBody[k] && find(k) === rb);
      if (aAlone && bAlone) union(i, j);
    }
  }

  // 5. heavily overlapping parts of one glyph ("%"), and pieces whose
  // outlines all but touch (a hairline lost in the scan). "Touch" is
  // measured between the real outlines, not bounding boxes — two letters
  // whose boxes overlap (kerned pairs, swashes) must stay apart.
  const touchDist = Math.max(1, typicalLine * 0.006);
  const samples = P.map((p) => sampleOutline(p.obj));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = P[i], b = P[j];
      const small = a.w * a.h <= b.w * b.h ? a : b;
      const big = small === a ? b : a;
      const ov = overlap(a.minX, a.maxX, b.minX, b.maxX) * overlap(a.minY, a.maxY, b.minY, b.maxY);
      if (ov >= small.w * small.h * 0.45 && small.h <= big.h * 0.75 && !(isBody[i] && isBody[j] && small.h > big.h * 0.5)) {
        union(i, j);
        continue;
      }
      if (gap(a.minX, a.maxX, b.minX, b.maxX) > touchDist || gap(a.minY, a.maxY, b.minY, b.maxY) > touchDist) continue;
      if (minDistance(samples[i], samples[j], touchDist) <= touchDist) union(i, j);
    }
  }

  // collect
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = clusters.get(r) ?? [];
    arr.push(i);
    clusters.set(r, arr);
  }
  const groups = Array.from(clusters.values()).map((idx) => {
    const bounds = {
      minX: Math.min(...idx.map((i) => P[i].minX)),
      minY: Math.min(...idx.map((i) => P[i].minY)),
      maxX: Math.max(...idx.map((i) => P[i].maxX)),
      maxY: Math.max(...idx.map((i) => P[i].maxY)),
    };
    const lines = idx.map((i) => lineOf[i]).filter((l) => l >= 0);
    return { id: shortId("trace_letter"), objects: idx.map((i) => P[i].obj), bounds, line: lines.length ? Math.min(...lines) : -1 };
  });
  // Reading order: line by line (orphans placed by their vertical centre), left → right.
  const lineCentre = (g: (typeof groups)[number]) => {
    if (g.line >= 0) return (lines[g.line].minY + lines[g.line].maxY) / 2;
    return (g.bounds.minY + g.bounds.maxY) / 2;
  };
  const sortedLines = lines.map((ln, li) => ({ li, c: (ln.minY + ln.maxY) / 2 })).sort((a, b) => a.c - b.c);
  const rank = new Map(sortedLines.map((l, k) => [l.li, k]));
  groups.sort((a, b) => {
    const ra = a.line >= 0 ? rank.get(a.line)! : nearestRank(lineCentre(a));
    const rb = b.line >= 0 ? rank.get(b.line)! : nearestRank(lineCentre(b));
    return ra - rb || a.bounds.minX - b.bounds.minX;
  });
  function nearestRank(y: number): number {
    let best = 0, bd = Infinity;
    sortedLines.forEach((l, k) => { const d = Math.abs(l.c - y); if (d < bd) { bd = d; best = k; } });
    return best;
  }
  return groups.map(({ id, objects, bounds }) => ({ id, objects, bounds }));
}

/** Points along every contour of an object (cubic segments sampled). */
function sampleOutline(obj: VectorObject): Point[] {
  const out: Point[] = [];
  for (const c of obj.contours) {
    const nodes = c.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const b = nodes[(i + 1) % nodes.length];
      const c1 = a.handleOut ?? a.point;
      const c2 = b.handleIn ?? b.point;
      const steps = a.handleOut || b.handleIn ? 10 : 4;
      for (let k = 0; k < steps; k++) {
        const t = k / steps, mt = 1 - t;
        out.push({
          x: mt ** 3 * a.point.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * b.point.x,
          y: mt ** 3 * a.point.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * b.point.y,
        });
      }
    }
  }
  return out;
}

function minDistance(a: Point[], b: Point[], stopBelow: number): number {
  let best = Infinity;
  const s2 = stopBelow * stopBelow;
  for (const p of a) {
    for (const q of b) {
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d < best) { best = d; if (best <= s2) return Math.sqrt(best); }
    }
  }
  return Math.sqrt(best);
}

/**
 * Uses the user's own hint — how many characters the image shows — to fix
 * the grouping: while there are more shapes than characters, the two
 * NEIGHBOURING shapes (in reading order) that belong together most clearly
 * are merged. "Belong together" = how much their boxes overlap (the circles
 * of "%" sit inside the slash's box) plus how close they are, relative to
 * their size. Returns, for each character, the ids of the shapes it gets.
 */
export function regroupToCount(groups: LetterGroup[], count: number): string[][] {
  const clusters = groups.map((g) => ({ ids: [g.id], b: { ...g.bounds } }));
  if (count <= 0) return clusters.map((c) => c.ids);
  const affinity = (a: (typeof clusters)[number]["b"], b: (typeof clusters)[number]["b"]) => {
    const ow = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
    const oh = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
    const areaA = Math.max(1e-6, (a.maxX - a.minX) * (a.maxY - a.minY));
    const areaB = Math.max(1e-6, (b.maxX - b.minX) * (b.maxY - b.minY));
    const overlapFrac = (ow * oh) / Math.min(areaA, areaB);
    const gx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
    const gy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY));
    const size = Math.max(1e-6, Math.min(Math.max(a.maxX - a.minX, a.maxY - a.minY), Math.max(b.maxX - b.minX, b.maxY - b.minY)));
    return overlapFrac - Math.hypot(gx, gy) / size;
  };
  while (clusters.length > count) {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i + 1 < clusters.length; i++) {
      const sc = affinity(clusters[i].b, clusters[i + 1].b);
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    const a = clusters[best], b = clusters[best + 1];
    clusters.splice(best, 2, {
      ids: [...a.ids, ...b.ids],
      b: { minX: Math.min(a.b.minX, b.b.minX), minY: Math.min(a.b.minY, b.b.minY), maxX: Math.max(a.b.maxX, b.b.maxX), maxY: Math.max(a.b.maxY, b.b.maxY) },
    });
  }
  return clusters.map((c) => c.ids);
}
