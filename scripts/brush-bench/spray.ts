// Spray Brush cost profile: live frame cost along a long stroke, commit
// (full build) and merge, plus dot counts.
//   npx tsx --tsconfig tsconfig.app.json scripts/brush-bench/spray.ts
import { BRUSH_PRESETS } from "@/brushes/presets";
import { StrokeStabilizer } from "@/brushes/strokeStabilizer";
import { createLiveBrushStroke } from "@/brushes/liveStroke";
import { brushOutlineContoursRaw, brushOutlineContours, type SpraySpeckCache } from "@/brushes/strokeToOutline";
import type { BrushSettings } from "@/types/brush";
const HIT = 1.4;
const settings = { type: "sprayBrush", ...BRUSH_PRESETS.sprayBrush.settings } as BrushSettings;
const N = 480;
const raw = [];
for (let i = 0; i <= N; i++) { const u = i / N; const a = u * Math.PI * 3.2; raw.push({ x: 300 + 180 * Math.sin(a), y: 900 - 900 * u, pressure: 0.6 }); }
const stab = new StrokeStabilizer(settings.stabilizer ?? 0, HIT, raw[0], 0);
const live = createLiveBrushStroke(settings, HIT);
const cache: SpraySpeckCache = { processedDist: 0, specks: [] };
const times: number[] = [];
let last = 0;
for (let i = 1; i <= N; i++) {
  stab.push(raw[i], i * 4.16);
  if (i % 4 === 0) {
    const t0 = performance.now();
    const pv = live.preview(stab.samples, stab.finish(), cache);
    times.push(performance.now() - t0);
    last = pv.outline.length + (pv.frozen?.length ?? 0);
  }
}
const sorted = times.slice().sort((a, b) => a - b);
console.log(`live frames: n=${times.length} p50 ${sorted[Math.floor(sorted.length / 2)].toFixed(1)}ms p90 ${sorted[Math.floor(sorted.length * 0.9)].toFixed(1)}ms max ${sorted[sorted.length - 1].toFixed(1)}ms total ${times.reduce((a, b) => a + b, 0).toFixed(0)}ms; contours at end ${last} (frozen ${cache.specks.length})`);
let t0 = performance.now();
const obj = live.commit([...stab.samples, ...stab.finish()])!;
console.log(`commit fit ${(performance.now() - t0).toFixed(1)}ms`);
t0 = performance.now();
const rawC = brushOutlineContoursRaw(obj);
console.log(`full build ${(performance.now() - t0).toFixed(0)}ms → ${rawC.length} contours, ${rawC.reduce((a, c) => a + c.nodes.length, 0)} nodes`);
t0 = performance.now();
const merged = brushOutlineContours(obj);
console.log(`build+merge ${(performance.now() - t0).toFixed(0)}ms → ${merged.length} contours, ${merged.reduce((a, c) => a + c.nodes.length, 0)} nodes`);
