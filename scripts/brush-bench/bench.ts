// Brush bench — simulates real pen strokes through the live Brush pipeline
// (stabilizer → centerline → outline) and measures what makes a brush feel
// good or bad in the hand:
//
//   drift   how far ink that is ALREADY on screen moves while you keep
//           drawing (Procreate: 0 — laid-down ink never moves)
//   jump    how far the stroke changes shape at pen-up (preview → saved)
//   follow  how far the saved centerline strays from the hand's path
//   frame   preview rebuild cost per frame at the end of a long stroke
//
//   npx tsx --tsconfig tsconfig.app.json scripts/brush-bench/bench.ts [--only round]
import type { Contour, Point, StrokeSample, VectorObject } from "@/types/geometry";
import type { BrushSettings, BrushType } from "@/types/brush";
import { BRUSH_PRESETS, BRUSH_ORDER } from "@/brushes/presets";
import { StrokeStabilizer } from "@/brushes/strokeStabilizer";
import { samplesToCenterline, centerlineToContour, centerlineToOutlineContours, brushOutlineContours, type SpraySpeckCache } from "@/brushes/strokeToOutline";
import { createLiveBrushStroke } from "@/brushes/liveStroke";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const HIT = 1.4; // font units per screen px (a glyph ~700 px tall on screen)

function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Raw { p: StrokeSample; t: number; ideal: Point }

/** A hand-drawn "S" stroke: 240 Hz pen, ~650 px/s, tremor, natural pressure. */
function makeStroke(kind: "S" | "line" | "tick", seed = 7): Raw[] {
  const rnd = mulberry(seed);
  const pts: Raw[] = [];
  const N = kind === "S" ? 300 : kind === "line" ? 120 : 24;
  let tremX = 0, tremY = 0;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    let ideal: Point;
    if (kind === "S") {
      const a = u * Math.PI * 2.2;
      ideal = { x: 300 + 160 * Math.sin(a), y: 700 - 560 * u };
    } else if (kind === "line") {
      ideal = { x: 120 + 520 * u, y: 200 + 380 * u };
    } else {
      ideal = { x: 300 + 50 * u, y: 300 + 30 * u };
    }
    // tremor: smoothed noise ~±0.6 screen px
    tremX = tremX * 0.7 + (rnd() - 0.5) * 0.9 * HIT;
    tremY = tremY * 0.7 + (rnd() - 0.5) * 0.9 * HIT;
    const pressure = Math.min(1, 0.25 + 0.6 * Math.sin(Math.PI * Math.min(1, u * 1.1)) + 0.05);
    pts.push({ p: { x: ideal.x + tremX, y: ideal.y + tremY, pressure: Math.max(0.05, pressure) }, t: i * (1000 / 240), ideal });
  }
  return pts;
}

function flatten(contours: Contour[]): Point[][] {
  return contours.map((c) => {
    const out: Point[] = [];
    const n = c.nodes.length;
    const segs = c.closed ? n : n - 1;
    if (n) out.push(c.nodes[0].point);
    for (let i = 0; i < segs; i++) {
      const a = c.nodes[i], b = c.nodes[(i + 1) % n];
      const c1 = a.handleOut ?? a.point, c2 = b.handleIn ?? b.point;
      const steps = a.handleOut || b.handleIn ? 12 : 1;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, mt = 1 - t;
        out.push({
          x: mt ** 3 * a.point.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * b.point.x,
          y: mt ** 3 * a.point.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * b.point.y,
        });
      }
    }
    return out;
  });
}

class SegIndex {
  cell = 8;
  grid = new Map<number, number[]>();
  segs: [Point, Point][] = [];
  key(gx: number, gy: number) { return (gx + 5000) * 100000 + (gy + 5000); }
  constructor(polys: Point[][]) {
    for (const poly of polys) for (let i = 0; i + 1 < poly.length; i++) {
      const a = poly[i], b = poly[i + 1];
      const id = this.segs.length;
      this.segs.push([a, b]);
      const x0 = Math.floor(Math.min(a.x, b.x) / this.cell), x1 = Math.floor(Math.max(a.x, b.x) / this.cell);
      const y0 = Math.floor(Math.min(a.y, b.y) / this.cell), y1 = Math.floor(Math.max(a.y, b.y) / this.cell);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const k = this.key(gx, gy);
        const arr = this.grid.get(k); if (arr) arr.push(id); else this.grid.set(k, [id]);
      }
    }
  }
  dist(p: Point): number {
    const gx = Math.floor(p.x / this.cell), gy = Math.floor(p.y / this.cell);
    let best = Infinity;
    for (let r = 0; r < 40; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const arr = this.grid.get(this.key(gx + dx, gy + dy));
        if (!arr) continue;
        for (const id of arr) {
          const [a, b] = this.segs[id];
          const vx = b.x - a.x, vy = b.y - a.y; const L2 = vx * vx + vy * vy;
          let t = L2 > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2 : 0; t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t);
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
    const k = Math.max(1, Math.ceil(L / step));
    for (let j = 0; j < k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k });
  }
  return out;
}

function settingsFor(type: BrushType): BrushSettings {
  const s = { type, ...BRUSH_PRESETS[type].settings } as BrushSettings;
  if (type === "pixel") return { ...s, gridSnap: false };
  return s;
}

const kinds: ("S" | "line" | "tick")[] = ["S", "line", "tick"];
const types = (["round", ...BRUSH_ORDER, "pressureTaper"] as BrushType[]).filter((t, i, a) => a.indexOf(t) === i && t !== "pixel");
console.log("brush          stroke  drift(px) mean/max   jump(px) mean/max   follow(px) mean/max   frame(ms) end   nodes");
for (const type of types) {
  if (only && type !== only) continue;
  const settings = settingsFor(type);
  for (const kind of kinds) {
    const raw = makeStroke(kind);
    const stab = new StrokeStabilizer(settings.stabilizer ?? 0, HIT, raw[0].p, raw[0].t);
    const live = createLiveBrushStroke(settings, HIT, args.includes("--legacy") ? "legacy" : "procreate");
    const frames: { outline: Point[][]; tip: Point }[] = [];
    const cache: SpraySpeckCache = { processedDist: 0, specks: [] };
    let lastFrameMs = 0;
    for (let i = 1; i < raw.length; i++) {
      stab.push(raw[i].p, raw[i].t);
      if (i % 4 === 0 || i === raw.length - 1) {
        const t0 = performance.now();
        const outline = live.preview(stab.samples, stab.finish(), type === "sprayBrush" ? cache : undefined);
        if (args.includes("--dump") && kind === "line" && frames.length === Number(args[args.indexOf("--dump") + 1]) && outline.centerline) {
          console.log(JSON.stringify(outline.centerline.nodes.map((n) => [Math.round(n.point.x * 10) / 10, Math.round(n.point.y * 10) / 10])));
        }
        if (type === "monoline" && outline.centerline) outline.outline = centerlineToOutlineContours(flatten([outline.centerline])[0].map((p) => ({ ...p, pressure: 1 })), { ...settings, taperMode: "length", liveTip: true });
        lastFrameMs = performance.now() - t0;
        const shown = outline.frozen ? [...outline.outline, ...outline.frozen] : outline.outline;
        frames.push({ outline: flatten(shown.length ? shown : outline.centerline ? [outline.centerline] : []), tip: raw[i].p });
      }
    }
    // pen-up
    const obj = live.commit([...stab.samples, ...stab.finish()]);
    const committed = flatten(obj ? brushOutlineContours(obj) : []);
    const final = frames[frames.length - 1].outline;
    const finalIdx = new SegIndex(final);
    const committedIdx = new SegIndex(committed);
    // drift: points of earlier frames that are far from the pen tip, vs the final preview
    const keep = settings.size * 2.5 + 40 * HIT;
    const drifts: number[] = [];
    for (let f = 0; f < frames.length - 1; f += type === "sprayBrush" ? 12 : 3) {
      for (const p of densify(frames[f].outline, 4)) {
        if (Math.hypot(p.x - frames[f].tip.x, p.y - frames[f].tip.y) < keep) continue;
        const dd = finalIdx.dist(p);
        drifts.push(dd);
        if (args.includes("--where") && dd > 2 * HIT) console.log("  drift", (dd / HIT).toFixed(2), "frame", f, "at", p.x.toFixed(1), p.y.toFixed(1), "tip", frames[f].tip.x.toFixed(1), frames[f].tip.y.toFixed(1));
      }
    }
    const jumpA = densify(final, 3).map((p) => committedIdx.dist(p));
    const jumpB = densify(committed, 3).map((p) => finalIdx.dist(p));
    const jumps = [...jumpA, ...jumpB];
    const cl = obj ? flatten([obj.contours[0]]) : [];
    const ideal = raw.map((r) => r.ideal);
    const idealIdx = new SegIndex([ideal]);
    const follow = densify(cl, 2).map((p) => idealIdx.dist(p));
    const st = (v: number[]) => v.length ? `${(v.reduce((a, b) => a + b, 0) / v.length / HIT).toFixed(2)}/${(v.reduce((a, b) => Math.max(a, b), 0) / HIT).toFixed(2)}` : "-";
    const nodes = obj ? obj.contours[0].nodes.length : 0;
    console.log(`${type.padEnd(14)} ${kind.padEnd(6)}  ${st(drifts).padEnd(19)}  ${st(jumps).padEnd(18)}  ${st(follow).padEnd(20)}  ${lastFrameMs.toFixed(1).padStart(6)}        ${nodes}`);
  }
}

export type { VectorObject };
void centerlineToContour; void samplesToCenterline; void centerlineToOutlineContours;
