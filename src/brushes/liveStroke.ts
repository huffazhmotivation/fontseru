import type { Contour, Point, StrokeSample, VectorObject } from "@/types/geometry";
import type { BrushSettings } from "@/types/brush";
import { shortId } from "@/utils/id";
import { simplifyPolyline } from "@/utils/simplify";
import { fitOpenCurve } from "@/trace/precisionTrace";
import {
  samplesToCenterline,
  centerlineToContour,
  centerlineToOutlineContours,
  type SpraySpeckCache,
} from "./strokeToOutline";

export interface LiveBrushPreview {
  outline: Contour[];
  centerline: Contour | null;
  /** Spray Brush: finalized halo dots, an append-only list (same array
   * every frame while the stroke lasts) drawn incrementally by the preview. */
  frozen?: Contour[];
}

export interface LiveBrushStroke {
  /** Live preview: `stable` = stabilizer samples so far, `tail` = the
   * catch-up from the stabilized tip to where the pen is right now (shown,
   * never baked into the stable part). */
  preview(stable: StrokeSample[], tail?: StrokeSample[], sprayCache?: SpraySpeckCache): LiveBrushPreview;
  /** Saved brush object for the finished stroke (stabilized samples incl. pen-up catch-up). */
  commit(samples: StrokeSample[]): VectorObject | null;
}

/**
 * Brush pipeline that behaves like Procreate:
 *
 *  • Ink that is on screen stays put. The centerline is a fixed-window
 *    moving average over the (StreamLine-stabilised) pen samples, computed
 *    incrementally: once a point has R newer neighbours it is final and is
 *    never recomputed. Tapers are fixed lengths (taperMode "length") and
 *    textures are keyed to absolute distance, so nothing upstream of the
 *    pen reshapes as the stroke grows. (The old pipeline re-ran smoothing +
 *    RDP over the whole stroke every frame and measured taper as a % of the
 *    stroke, so laid-down ink wobbled by up to ~9 px while drawing.)
 *  • The ink reaches the pen. The StreamLine catch-up from the trailing tip
 *    to the pen is drawn live, so there is no gap between pen and ink.
 *  • What you see is what you get. Pen-up fits the SAME smoothed centerline
 *    with the fewest Bézier nodes that stay within ½ screen pixel of it,
 *    and the end taper is applied over its fixed length — the only change
 *    at pen-up, exactly as Procreate tapers on lift. (The old commit re-fit
 *    a different curve, so strokes visibly jumped by up to ~15 px.)
 */
function createProcreate(settings: BrushSettings, hitScale: number): LiveBrushStroke {
  const base: BrushSettings = { ...settings, taperMode: "length", liveTip: undefined, gridSnap: undefined, cellShape: undefined };
  const liveSettings: BrushSettings = { ...base, liveTip: true };
  const minStep = 1.0 * hitScale;
  // "Stabilization": Gaussian smoothing along the stroke (samples are ~1
  // screen px apart, so σ is in screen px). It removes hand tremor finer
  // than ~2πσ — the wiggles that would otherwise fold a wide nib's edge into
  // little loops — while long, deliberate curves pass through untouched.
  const sigma = 0.6 + 4 * Math.max(0, Math.min(1, settings.smoothing ?? 0));
  const R = Math.ceil(sigma * 2.5);
  const weights = Array.from({ length: R + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sigma * sigma)));

  // Decimated stable samples (greedy from the start → a fixed prefix never changes).
  const kept: StrokeSample[] = [];
  let consumed = 0;
  // Smoothed points that are final (have R newer neighbours in `kept`).
  const final: StrokeSample[] = [];

  const consume = (stable: StrokeSample[], includeLast: boolean) => {
    const upto = includeLast ? stable.length : Math.max(0, stable.length - 1);
    for (; consumed < upto; consumed++) {
      const p = stable[consumed];
      const last = kept[kept.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minStep) kept.push({ x: p.x, y: p.y, pressure: p.pressure });
      else last.pressure = p.pressure;
    }
  };

  // Symmetric window of radius r (shrinks at the two ends so the first and
  // last points stay where the pen actually was).
  const avg = (arr: StrokeSample[], i: number, r: number): StrokeSample => {
    let x = 0, y = 0, pr = 0, wsum = 0;
    for (let k = -r; k <= r; k++) {
      const w = weights[Math.abs(k)];
      const q = arr[i + k];
      x += q.x * w; y += q.y * w; pr += q.pressure * w; wsum += w;
    }
    return { x: x / wsum, y: y / wsum, pressure: pr / wsum };
  };

  /** Smoothed centerline of kept + extra (volatile) points. */
  const smoothed = (extra: StrokeSample[]): StrokeSample[] => {
    // extend the final prefix
    const finalUpto = kept.length - R; // indices < finalUpto have full windows inside `kept`
    for (let i = final.length; i < finalUpto; i++) final.push(avg(kept, i, Math.min(R, i)));
    const all = extra.length ? kept.concat(extra) : kept;
    const out = final.slice();
    for (let i = final.length; i < all.length; i++) out.push(avg(all, i, Math.min(R, i, all.length - 1 - i)));
    return out;
  };

  // Streaming simplification of the FINAL smoothed points. The outline
  // builders sweep/union one primitive per input segment, so they want a
  // sparse polyline, not a point every pixel (a dense one made Rough brush
  // take hundreds of ms per frame). A greedy run is extended while every
  // point in it stays within `eps` of the chord (and its pressure within
  // 0.03 of the chord's), so the result for a given prefix never changes —
  // ink already on screen stays exactly where it is.
  const eps = Math.max(0.3 * hitScale, settings.size * 0.02);
  const anchors: StrokeSample[] = [];
  let runStart = 0;
  let simplified = 0;
  const runFits = (from: number, to: number): boolean => {
    const a = final[from], b = final[to];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    for (let k = from + 1; k < to; k++) {
      const q = final[k];
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / L2)) : 0;
      if (Math.hypot(q.x - a.x - dx * t, q.y - a.y - dy * t) > eps) return false;
      if (Math.abs(q.pressure - (a.pressure + (b.pressure - a.pressure) * t)) > 0.03) return false;
    }
    return true;
  };
  const advanceAnchors = () => {
    if (!final.length) return;
    if (!anchors.length) { anchors.push(final[0]); runStart = 0; simplified = 1; }
    for (; simplified < final.length; simplified++) {
      const j = simplified;
      if (j - runStart > 24 || !runFits(runStart, j)) {
        anchors.push(final[j - 1]);
        runStart = j - 1;
      }
    }
  };
  /** Sparse stable prefix + the open run's end + the volatile (still changing) points. */
  const outlineInput = (cl: StrokeSample[]): StrokeSample[] => {
    advanceAnchors();
    const out = anchors.slice();
    if (final.length && runStart < final.length - 1) out.push(final[final.length - 1]);
    for (let i = final.length; i < cl.length; i++) out.push(cl[i]);
    return out;
  };

  const tailPoints = (tail: StrokeSample[] | undefined, lastStable: StrokeSample | undefined): StrokeSample[] => {
    const out: StrokeSample[] = [];
    if (lastStable && (!kept.length || lastStable !== kept[kept.length - 1])) {
      const k = kept[kept.length - 1];
      if (!k || Math.hypot(lastStable.x - k.x, lastStable.y - k.y) > 1e-6) out.push(lastStable);
    }
    if (tail) {
      for (const p of tail) {
        const prev = out[out.length - 1] ?? kept[kept.length - 1];
        if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) >= minStep * 0.5) out.push(p);
      }
    }
    return out;
  };

  return {
    preview(stable, tail, sprayCache) {
      consume(stable, false);
      const cl = smoothed(tailPoints(tail, stable[stable.length - 1]));
      if (cl.length < 2) return { outline: [], centerline: null };
      const input = outlineInput(cl);
      // Monoline previews as an SVG stroke along the polyline itself: the
      // input is already within a fraction of a pixel of the smooth path, and
      // auto-handles would bow long runs as the next point moves.
      if (settings.type === "monoline") return { outline: [], centerline: centerlineToContour(input, false) };
      if (sprayCache) {
        sprayCache.separate = true;
        const outline = centerlineToOutlineContours(input, liveSettings, { fast: true, spraySpeckCache: sprayCache });
        return { centerline: null, outline, frozen: sprayCache.specks };
      }
      return { centerline: null, outline: centerlineToOutlineContours(input, liveSettings, { fast: true }) };
    },
    commit(samples) {
      consume(samples, true);
      const cl = smoothed([]);
      if (cl.length < 2) return null;
      const nodes = fitOpenCurve(cl, 0.5 * hitScale, 70, 4 * hitScale);
      if (nodes.length < 2) return null;
      return {
        id: shortId("obj"),
        kind: "brush",
        contours: [{ id: shortId("contour"), closed: false, nodes }],
        strokeWidth: settings.size,
        cap: "round",
        join: "round",
        brushType: settings.type,
        brushSettings: base,
        samples: pressureSamples(cl, hitScale, settings.pressureEnabled),
      };
    },
  };
}

/**
 * The few samples needed to reproduce the stroke's pressure along its
 * length (RDP on arc-length × pressure), instead of hundreds of raw ones —
 * a mouse stroke (constant pressure) keeps just its two ends.
 */
function pressureSamples(cl: StrokeSample[], hitScale: number, pressureEnabled: boolean): StrokeSample[] {
  if (!pressureEnabled || cl.length <= 2) return [cl[0], cl[cl.length - 1]].map((p) => ({ x: p.x, y: p.y, pressure: pressureEnabled ? p.pressure : 1 }));
  const unitLen = 40 * hitScale; // 40 screen px of stroke = 1 unit against pressure 0..1
  let s = 0;
  const pts = cl.map((p, i) => {
    if (i > 0) s += Math.hypot(p.x - cl[i - 1].x, p.y - cl[i - 1].y);
    return { x: s / unitLen, y: p.pressure, i };
  });
  const keptPts = simplifyPolyline(pts, 0.012);
  return keptPts.map((k) => ({ x: cl[k.i].x, y: cl[k.i].y, pressure: cl[k.i].pressure }));
}

/** Legacy pipeline — kept only for the brush bench comparison. */
function createLegacy(settings: BrushSettings, hitScale: number): LiveBrushStroke {
  return {
    preview(stable, _tail, sprayCache) {
      const cl = samplesToCenterline(stable, settings, hitScale);
      if (settings.type === "monoline") return { centerline: centerlineToContour(cl, true), outline: [] };
      return { centerline: null, outline: centerlineToOutlineContours(cl, settings, { fast: true, spraySpeckCache: sprayCache }) };
    },
    commit(samples) {
      const cl = samplesToCenterline(samples, settings, hitScale);
      const centerline = centerlineToContour(cl, true, false);
      if (!centerline) return null;
      return {
        id: shortId("obj"),
        kind: "brush",
        contours: [centerline],
        strokeWidth: settings.size,
        cap: "round",
        join: "round",
        brushType: settings.type,
        brushSettings: { ...settings, gridSnap: undefined, cellShape: undefined },
        samples: cl.map((p) => ({ ...p })),
      };
    },
  };
}

export function createLiveBrushStroke(settings: BrushSettings, hitScale: number, mode: "procreate" | "legacy" = "procreate"): LiveBrushStroke {
  return mode === "legacy" ? createLegacy(settings, hitScale) : createProcreate(settings, hitScale);
}

export type { Point };
