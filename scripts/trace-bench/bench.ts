// Trace bench — scores the tracer against ground-truth font outlines.
//
//   node scripts/trace-bench/makeImages.mjs <dir>
//   npx tsx --tsconfig tsconfig.app.json scripts/trace-bench/bench.ts <dir> [--old] [--detail high] [--overlay]
//
// For every test image it reports, in SOURCE pixels:
//   dev  — mean / 95th-percentile / max distance between traced outline and
//          the true outline (both directions, so missing and extra ink count)
//   nodes — traced node count vs. the font's own node count
//   shapes/contours — how many separate objects/outlines came out
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Point, VectorObject } from "@/types/geometry";
import { marchingSquares, otsuThreshold, precisionOptionsFor, traceRGBA, type PrecisionDetail } from "@/trace/precisionTrace";
import { groupLettersSmart } from "@/trace/letterGroups";

const dir = process.argv[2];
const args = process.argv.slice(3);
const useOld = args.includes("--old");
const overlay = args.includes("--overlay");
const detail = (args[args.indexOf("--detail") + 1] && args.includes("--detail") ? args[args.indexOf("--detail") + 1] : "high") as PrecisionDetail;
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

interface Item { id: string; file: string; width: number; height: number; d: string; gtNodes: number; gtContours: number; text: string; variant: string }
const manifest: Item[] = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

// ---------- geometry helpers ----------
function parseD(d: string): Point[][] {
  const toks = d.match(/[MLQCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const polys: Point[][] = [];
  let cur: Point[] = [];
  let p: Point = { x: 0, y: 0 };
  let i = 0;
  const num = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    const c = toks[i++];
    if (c === "M") { if (cur.length) polys.push(cur); p = { x: num(), y: num() }; cur = [p]; }
    else if (c === "L") { p = { x: num(), y: num() }; cur.push(p); }
    else if (c === "Q") {
      const q1 = { x: num(), y: num() }; const e = { x: num(), y: num() };
      for (let k = 1; k <= 24; k++) { const t = k / 24, mt = 1 - t; cur.push({ x: mt * mt * p.x + 2 * mt * t * q1.x + t * t * e.x, y: mt * mt * p.y + 2 * mt * t * q1.y + t * t * e.y }); }
      p = e;
    } else if (c === "C") {
      const c1 = { x: num(), y: num() }; const c2 = { x: num(), y: num() }; const e = { x: num(), y: num() };
      for (let k = 1; k <= 32; k++) { const t = k / 32, mt = 1 - t; cur.push({ x: mt ** 3 * p.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * e.x, y: mt ** 3 * p.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * e.y }); }
      p = e;
    } else if (c === "Z") { if (cur.length) { cur.push(cur[0]); polys.push(cur); } cur = []; }
  }
  if (cur.length) polys.push(cur);
  return polys;
}

function flattenObjects(objects: VectorObject[], k: number): Point[][] {
  const out: Point[][] = [];
  for (const o of objects) for (const c of o.contours) {
    const nodes = c.nodes;
    if (!nodes.length) continue;
    const poly: Point[] = [{ x: nodes[0].point.x * k, y: nodes[0].point.y * k }];
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i], b = nodes[(i + 1) % nodes.length];
      const c1 = a.handleOut ?? a.point, c2 = b.handleIn ?? b.point;
      const steps = a.handleOut || b.handleIn ? 40 : 1;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, mt = 1 - t;
        poly.push({
          x: (mt ** 3 * a.point.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * b.point.x) * k,
          y: (mt ** 3 * a.point.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * b.point.y) * k,
        });
      }
    }
    out.push(poly);
  }
  return out;
}

class SegIndex {
  cell = 4;
  grid = new Map<string, number[]>();
  segs: [Point, Point][] = [];
  constructor(polys: Point[][]) {
    for (const poly of polys) for (let i = 0; i + 1 < poly.length; i++) {
      const a = poly[i], b = poly[i + 1];
      const id = this.segs.length;
      this.segs.push([a, b]);
      const x0 = Math.floor(Math.min(a.x, b.x) / this.cell), x1 = Math.floor(Math.max(a.x, b.x) / this.cell);
      const y0 = Math.floor(Math.min(a.y, b.y) / this.cell), y1 = Math.floor(Math.max(a.y, b.y) / this.cell);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const key = gx + "," + gy;
        const arr = this.grid.get(key); if (arr) arr.push(id); else this.grid.set(key, [id]);
      }
    }
  }
  nearest(p: Point): Point | null {
    let best = Infinity; let bp: Point | null = null;
    const gx = Math.floor(p.x / this.cell), gy = Math.floor(p.y / this.cell);
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      const arr = this.grid.get(gx + dx + "," + (gy + dy)); if (!arr) continue;
      for (const id of arr) {
        const [a, b] = this.segs[id]; const vx = b.x - a.x, vy = b.y - a.y; const L2 = vx * vx + vy * vy;
        let t = L2 > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2 : 0; t = Math.max(0, Math.min(1, t));
        const q = { x: a.x + vx * t, y: a.y + vy * t }; const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < best) { best = d; bp = q; }
      }
    }
    return bp;
  }
  dist(p: Point): number {
    const gx = Math.floor(p.x / this.cell), gy = Math.floor(p.y / this.cell);
    let best = Infinity;
    for (let r = 0; r < 64; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const arr = this.grid.get(gx + dx + "," + (gy + dy));
        if (!arr) continue;
        for (const id of arr) {
          const [a, b] = this.segs[id];
          const vx = b.x - a.x, vy = b.y - a.y;
          const L2 = vx * vx + vy * vy;
          let t = L2 > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2 : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
          if (d < best) best = d;
        }
      }
      if (best <= (r - 1) * this.cell) break;
    }
    return best;
  }
}

function densify(polys: Point[][], step: number): Point[] {
  const out: Point[] = [];
  for (const poly of polys) for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

function stats(v: number[]) {
  const s = v.slice().sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  return { mean, p95: s[Math.floor(s.length * 0.95)] ?? 0, max: s[s.length - 1] ?? 0 };
}

// Ground truth = the boundary of the UNION of the font's contours (script
// fonts overlap their own contours; those inner lines are not visible ink).
// Rendered at 6x and contoured at 50% coverage → accurate to ~0.05 px.
async function gtUnionBoundary(item: Item): Promise<Point[][]> {
  const S = 6;
  const W = item.width * S, H = item.height * S;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${item.width} ${item.height}"><rect width="100%" height="100%" fill="#fff"/><path d="${item.d}" fill="#000"/></svg>`;
  const { data } = await sharp(Buffer.from(svg), { limitInputPixels: false }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const f = new Float32Array(W * H);
  for (let i = 0; i < f.length; i++) f[i] = 127.5 - data[i];
  return marchingSquares(f, W, H).map((poly) => {
    const pts = poly.map((p) => ({ x: p.x / S, y: p.y / S }));
    pts.push(pts[0]);
    return pts;
  });
}

// ---------- old pipeline (imagetracerjs), for comparison ----------
async function traceOld(rgba: Uint8Array, w: number, h: number) {
  const mod = await import("@/trace/imageTrace");
  await mod.loadTracer();
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const ink = a > 32 && lum < 150;
    const v = ink ? 0 : 255;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  const imgd = { width: w, height: h, data } as unknown as ImageData;
  mod.despeckleBinary(imgd, 5);
  return mod.traceBinaryImage(imgd, "high");
}

// Pixel-centre-aligned resampling (what canvas drawImage does): Catmull-Rom
// bicubic when enlarging, box/area average when shrinking. sharp's own
// resize shifts content by a fraction of a pixel when enlarging, which would
// show up as fake tracing error.
function resample(src: Uint8Array, w: number, h: number, W: number, H: number): Uint8Array {
  if (W === w && H === h) return src;
  const out = new Uint8Array(W * H * 4);
  const sx = w / W, sy = h / H;
  if (sx < 1 && sy < 1) {
    const cub = (t: number) => { const a = Math.abs(t); return a < 1 ? 1.5 * a ** 3 - 2.5 * a * a + 1 : a < 2 ? -0.5 * a ** 3 + 2.5 * a * a - 4 * a + 2 : 0; };
    for (let Y = 0; Y < H; Y++) {
      const fy = (Y + 0.5) * sy - 0.5; const iy = Math.floor(fy);
      for (let X = 0; X < W; X++) {
        const fx = (X + 0.5) * sx - 0.5; const ix = Math.floor(fx);
        const acc = [0, 0, 0, 0]; let wsum = 0;
        for (let m = -1; m <= 2; m++) for (let n = -1; n <= 2; n++) {
          const xx = Math.min(w - 1, Math.max(0, ix + n)), yy = Math.min(h - 1, Math.max(0, iy + m));
          const wt = cub(fx - (ix + n)) * cub(fy - (iy + m)); wsum += wt;
          for (let c = 0; c < 4; c++) acc[c] += src[(yy * w + xx) * 4 + c] * wt;
        }
        for (let c = 0; c < 4; c++) out[(Y * W + X) * 4 + c] = Math.max(0, Math.min(255, Math.round(acc[c] / wsum)));
      }
    }
    return out;
  }
  for (let Y = 0; Y < H; Y++) {
    const y0 = Y * sy, y1 = (Y + 1) * sy;
    for (let X = 0; X < W; X++) {
      const x0 = X * sx, x1 = (X + 1) * sx;
      const acc = [0, 0, 0, 0]; let area = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          const wt = wx * wy; area += wt;
          for (let c = 0; c < 4; c++) acc[c] += src[(Math.min(h - 1, yy) * w + Math.min(w - 1, xx)) * 4 + c] * wt;
        }
      }
      for (let c = 0; c < 4; c++) out[(Y * W + X) * 4 + c] = Math.round(acc[c] / area);
    }
  }
  return out;
}

// Working resolution, same rule the app uses (see imageTrace.ts imageToCanvas).
function workingScale(w: number, h: number, ceiling: number, floor: number, maxUp: number) {
  const m = Math.max(w, h);
  if (m > ceiling) return ceiling / m;
  if (m < floor) return Math.min(floor / m, maxUp);
  return 1;
}

const rows: string[] = [];
let sumMean = 0, sumP95 = 0, sumNodes = 0, sumGt = 0, count = 0;
const t0 = Date.now();
for (const item of manifest) {
  if (only && !item.id.includes(only)) continue;
  const scale = useOld ? workingScale(item.width, item.height, 2200, 1200, 3) : workingScale(item.width, item.height, 2000, 1000, 4);
  const W = Math.max(1, Math.round(item.width * scale));
  const H = Math.max(1, Math.round(item.height * scale));
  const src = await sharp(path.join(dir, item.file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = resample(new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.length), src.info.width, src.info.height, W, H);
  const ts = Date.now();
  let objects: VectorObject[];
  if (useOld) objects = await traceOld(rgba, W, H);
  else {
    const thr = otsuThreshold(rgba, W, H);
    const opts = precisionOptionsFor(detail, thr, false, Math.max(W, H), scale);
    objects = traceRGBA(rgba, W, H, opts).objects;
  }
  const ms = Date.now() - ts;
  const k = 1 / scale; // working px → source px
  const traced = flattenObjects(objects, k);
  const gt = await gtUnionBoundary(item);
  const gtIdx = new SegIndex(gt);
  const trIdx = new SegIndex(traced);
  const tracedPts = densify(traced, 0.5);
  const d1 = tracedPts.map((p) => gtIdx.dist(p));
  const gtPts = densify(gt, 0.5);
  let worst: Point = { x: 0, y: 0 }; let worstD = -1;
  d1.forEach((d, i) => { if (d > worstD) { worstD = d; worst = tracedPts[i]; } });
  if (args.includes('--offset')) {
    // mean signed offset: traced point minus nearest GT point
    let sx = 0, sy = 0, c = 0;
    for (const p of densify(traced, 2)) { const q = gtIdx.nearest(p); if (q) { sx += p.x - q.x; sy += p.y - q.y; c++; } }
    console.log(item.id, 'scale', scale.toFixed(3), 'mean offset', (sx / c).toFixed(3), (sy / c).toFixed(3));
  }
  const d2 = gtPts.map((p) => trIdx.dist(p));
  d2.forEach((d, i) => { if (d > worstD) { worstD = d; worst = gtPts[i]; } });
  const st = stats([...d1, ...d2]);
  const s1 = stats(d1), s2 = stats(d2);
  const nodes = objects.reduce((a, o) => a + o.contours.reduce((b, c) => b + c.nodes.length, 0), 0);
  const contours = objects.reduce((a, o) => a + o.contours.length, 0);
  const groups = groupLettersSmart(objects); const letters = groups.length;
  if (args.includes('--groups')) console.log(item.id, groups.map((g) => `[${g.objects.length}@${Math.round(g.bounds.minX)},${Math.round(g.bounds.minY)} ${Math.round(g.bounds.maxX - g.bounds.minX)}x${Math.round(g.bounds.maxY - g.bounds.minY)}]`).join(' '));
  sumMean += st.mean; sumP95 += st.p95; sumNodes += nodes; sumGt += item.gtNodes; count++;
  rows.push(
    `${item.id.padEnd(26)} dev mean ${st.mean.toFixed(3)} p95 ${st.p95.toFixed(2)} max ${st.max.toFixed(2)} | nodes ${String(nodes).padStart(4)} / font ${String(item.gtNodes).padStart(4)} (${(nodes / item.gtNodes).toFixed(2)}x) | contours ${contours}/${item.gtContours} shapes ${objects.length} letters ${letters} (${item.text.length}) | ${ms}ms${args.includes('--split') ? ` [tr→gt ${s1.mean.toFixed(3)}/${s1.p95.toFixed(2)} gt→tr ${s2.mean.toFixed(3)}/${s2.p95.toFixed(2)}]` : ''}`
  );
  if (overlay) {
    const pathD = traced.map((poly) => "M" + poly.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join("L") + "Z").join("");
    const dots = objects.flatMap((o) => o.contours.flatMap((c) => c.nodes.map((n) => `<circle cx="${(n.point.x * k).toFixed(2)}" cy="${(n.point.y * k).toFixed(2)}" r="${Math.max(1.2, item.width / 300)}" fill="${n.type === "corner" ? "#e11" : "#16c"}"/>`))).join("");
    const sw = Math.max(0.6, item.width / 700);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${item.width}" height="${item.height}"><rect width="100%" height="100%" fill="#fff"/><path d="${item.d}" fill="#bbb"/><path d="${pathD}" fill="none" stroke="#e0218a" stroke-width="${sw}"/>${dots}<circle cx="${worst.x}" cy="${worst.y}" r="${item.width / 40}" fill="none" stroke="#f80" stroke-width="${sw * 2}"/></svg>`;
    fs.mkdirSync(path.join(dir, "overlay"), { recursive: true });
    await sharp(Buffer.from(svg)).png().toFile(path.join(dir, "overlay", `${item.id}${useOld ? "--old" : ""}.png`));
  }
}
console.log(rows.join("\n"));
console.log(`\n${useOld ? "OLD imagetracer (high)" : `NEW precision (${detail})`}: avg dev mean ${(sumMean / count).toFixed(3)}px, avg p95 ${(sumP95 / count).toFixed(2)}px, nodes ${sumNodes} vs font ${sumGt} (${(sumNodes / sumGt).toFixed(2)}x), ${((Date.now() - t0) / 1000).toFixed(1)}s`);
