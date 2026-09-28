import { useCallback, useRef, useState } from "react";
import type { Contour, Point, StrokeSample, VectorObject } from "@/types/geometry";
import { useAppStore } from "@/glyph/store";
import { samplesToCenterline, centerlineToContour, centerlineToOutlineContours, type SpraySpeckCache } from "@/brushes/strokeToOutline";
import { StrokeStabilizer } from "@/brushes/strokeStabilizer";
import { shortId } from "@/utils/id";
import { detectQuickShape, quickShapePolyline, QUICK_SHAPE_HOLD_MS, type QuickShapeResult } from "./quickShape";

interface PointerLike { pressure?: number; pointerType?: string; timeStamp?: number; }

/**
 * True only for an actual pen/stylus pointer (Apple Pencil and other
 * pressure-sensitive styluses report `pointerType: "pen"`). Mouse and
 * touch are deliberately excluded here, even though some touchscreens
 * report a nonzero `pressure` value for a finger — Brush width should
 * never react to that, only to a real stylus.
 */
function isStylusPointer(e: PointerLike): boolean {
  return e.pointerType === "pen";
}

/** Real stylus pressure when present; otherwise -1 to signal "no real pressure". */
function stylusPressure(e: PointerLike): number {
  if (isStylusPointer(e) && typeof e.pressure === "number" && e.pressure > 0) return e.pressure;
  return -1;
}

export function snapToGridCell(p: Point, size: number): Point {
  return {
    x: (Math.floor(p.x / size) + 0.5) * size,
    y: (Math.floor(p.y / size) + 0.5) * size,
  };
}

/**
 * Pixel Brush diagonal-friendliness. A diagonal drag almost never passes
 * exactly through cell corners: the pointer clips the edge of one of the two
 * orthogonal "elbow" cells (the one above/beside the intended diagonal cell)
 * for a single event before landing in the diagonal one, so a clean
 * diagonal used to come out as an L-shaped staircase that was very hard to
 * avoid by hand. A cell only counts as a deliberate stop if the pointer
 * actually reached its CORE — the central (2 * PIXEL_CORE_HALF) square,
 * measured as a fraction of the cell — at some point while inside it.
 * See `isPixelCellCore` and its use in pointerMove.
 */
const PIXEL_CORE_HALF = 0.25; // core = central 50% of the cell on each axis

function isPixelCellCore(p: Point, size: number): boolean {
  const fx = p.x / size - Math.floor(p.x / size);
  const fy = p.y / size - Math.floor(p.y / size);
  return (
    Math.abs(fx - 0.5) <= PIXEL_CORE_HALF &&
    Math.abs(fy - 0.5) <= PIXEL_CORE_HALF
  );
}

/**
 * Brush Stabilizer is a Procreate-style streaming engine (motion filter +
 * StreamLine, see `brushes/strokeStabilizer.ts`) that runs on every raw
 * pointer sample. Its output is used for BOTH the live preview and the
 * committed stroke — previously the committed stroke was rebuilt from the
 * raw samples with only Smoothing applied, so Stabilizer shaped what you saw
 * but not what was saved, and strokes changed shape on pen-up. Smoothing
 * still runs once on top (live and on commit alike) as the final cleanup.
 * `hitScale` (font units per screen px) keeps the feel zoom-independent.
 */
export function useBrushTool(hitScale: number) {
  const brush = useAppStore((s) => s.brush);
  const brushCap = useAppStore((s) => s.brushCap);
  const gridSize = useAppStore((s) => s.gridSize);
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const commitOutline = useAppStore((s) => s.commitOutline);

  // Raw captured pointer stream (font units). Only QuickShape reads it now;
  // the stroke itself comes from the stabilizer (see stabilizerRef).
  const rawSamplesRef = useRef<StrokeSample[]>([]);
  // The stroke being drawn: the stabilizer's output stream (or a QuickShape
  // snap while one is held). The live preview renders it, and pointerUp
  // commits the same stream plus the stabilizer's end catch-up.
  const samplesRef = useRef<StrokeSample[]>([]);
  const stabilizerRef = useRef<StrokeStabilizer | null>(null);
  // Pixel Brush only, parallel to samplesRef/rawSamplesRef: whether the
  // pointer ever reached the core of that sample's cell (see isPixelCellCore).
  const pixelCoreRef = useRef<boolean[]>([]);
  // Spray Brush only: accumulates the current gesture's edge-grain +
  // overspray specks across pointer-move frames (see SpraySpeckCache's doc
  // comment in strokeToOutline.ts). Reset to null at the start/end of every
  // stroke (pointerDown/pointerUp/cancel below) so a new gesture always
  // starts its dust field from scratch; buildPreview lazily creates it the
  // first time a frame actually needs one.
  const sprayCacheRef = useRef<SpraySpeckCache | null>(null);
  // Pixel Brush's live preview is many square contours (one per grid cell),
  // not one nib-shaped contour, so this is always an array — empty for "no
  // preview" rather than null, which keeps the pixel and non-pixel paths
  // uniform for the renderer (see GlyphCanvas.tsx).
  const [previewOutline, setPreviewOutline] = useState<Contour[]>([]);
  const [previewCenterline, setPreviewCenterline] = useState<Contour | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const pixelSnap = brush.type === "pixel" && brush.gridSnap === true;

  // QuickShape (Procreate-style "hold at the end to snap") state — see
  // quickShape.ts. Skipped entirely for Pixel Brush: a blocky grid-snapped
  // stroke has no "wobbly line/circle" to straighten. Brush allows line
  // recognition (unlike Pencil) since its committed geometry is an open
  // centerline stroke, where a straight line is a meaningful result.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickShapeRef = useRef<QuickShapeResult | null>(null);

  const clearQuickShapeHold = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    quickShapeRef.current = null;
  }, []);

  // Real stylus pressure drives width when present. Mouse, trackpad, and
  // touch never get a simulated substitute — they always report a
  // constant "full pressure" sample here, so stroke width comes purely
  // from Size (and taper), never from how fast the pointer moved.
  const pressureFor = useCallback((_p: Point, e: PointerLike): number => {
    const real = stylusPressure(e);
    return real >= 0 ? real : 1;
  }, []);

  const buildPreview = useCallback(() => {
    const cl = samplesToCenterline(samplesRef.current, brush, hitScale);
    if (brush.type === "monoline") {
      return { centerline: centerlineToContour(cl, true), outline: [] as Contour[] };
    }
    // Pixel Brush's grid cell size is baked from the CURRENT canvas grid
    // setting for the live preview too, so what you see while drawing
    // matches exactly what gets committed.
    const settings = pixelSnap ? { ...brush, cellSize: gridSize } : brush;
    // `fast: true` only matters for Spray Brush (every other brush type
    // ignores it) — see sprayBrushOutlineContours' doc comment. Paired with
    // `spraySpeckCache` (this stroke's accumulating dust field, owned by
    // sprayCacheRef below and reset on pointerDown/pointerUp/cancel), each
    // frame only generates specks for the newly-drawn tail and appends them
    // to the same cached array, instead of rebuilding the whole speck field
    // from scratch on every pointer move — that whole-field rebuild was
    // what caused Spray Brush to lag/stutter on longer strokes. Because the
    // cost is now bounded by how much NEW length was just drawn rather than
    // the stroke's total length so far, the live preview can afford to use
    // the exact same full-density texture as the committed build, so what
    // you see while actively drawing already matches the final detail — no
    // separate lower-fidelity "preview" look. The final committed stroke is
    // unaffected either way: it's rendered via
    // brushOutlineContours()/getGlyphPaths() elsewhere, which never passes
    // `fast` and always uses the full build.
    if (brush.type === "sprayBrush") {
      if (!sprayCacheRef.current) sprayCacheRef.current = { processedDist: 0, specks: [] };
      return {
        centerline: null as Contour | null,
        outline: centerlineToOutlineContours(cl, settings, { fast: true, spraySpeckCache: sprayCacheRef.current }),
      };
    }
    return { centerline: null as Contour | null, outline: centerlineToOutlineContours(cl, settings, { fast: true }) };
  }, [brush, gridSize, pixelSnap, hitScale]);

  // PERFORMANCE FIX (lag/patah-patah while drawing, worst on Spray Brush):
  // pointermove can fire far faster than the screen can actually redraw
  // (100-240Hz on some mice/tablets vs. a 60Hz display), and every prior
  // call rebuilt the full brush preview + triggered a React re-render
  // synchronously on EACH event. Several of those rebuilds per displayed
  // frame is pure wasted, blocking work — the browser throws away all but
  // the last one anyway. Coalescing with requestAnimationFrame caps the
  // (expensive) preview rebuild + setState pair to once per actual frame,
  // regardless of how many pointer events arrive in between, while the
  // raw sample buffer (rawSamplesRef, used to build the final committed
  // geometry on pointerUp) is still updated synchronously on every move so
  // committed accuracy is unaffected — only the live visual update is
  // throttled.
  const rafIdRef = useRef<number | null>(null);
  const flushPreview = useCallback(() => {
    rafIdRef.current = null;
    const preview = buildPreview();
    setPreviewCenterline(preview.centerline);
    setPreviewOutline(preview.outline);
  }, [buildPreview]);
  const schedulePreviewUpdate = useCallback(() => {
    if (rafIdRef.current != null) return;
    rafIdRef.current = requestAnimationFrame(flushPreview);
  }, [flushPreview]);
  const cancelScheduledPreview = useCallback(() => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const pointerDown = useCallback((p: Point, e: PointerLike) => {
    // Pixel brush: snap captured points to the centers of canvas grid cells as you draw, for
    // a genuine blocky/pixel-font-friendly stroke rather than a smoothed curve.
    const snapped = pixelSnap ? snapToGridCell(p, gridSize) : p;
    const sample: StrokeSample = { x: snapped.x, y: snapped.y, pressure: pressureFor(snapped, e) };
    rawSamplesRef.current = [sample];
    stabilizerRef.current = pixelSnap ? null : new StrokeStabilizer(brush.stabilizer ?? 0, hitScale, sample, e.timeStamp ?? performance.now());
    samplesRef.current = stabilizerRef.current ? stabilizerRef.current.samples : [sample];
    pixelCoreRef.current = pixelSnap ? [isPixelCellCore(p, gridSize)] : [];
    // Fresh gesture: start this stroke's spray dust field over from empty
    // rather than carrying over the previous stroke's accumulated specks.
    sprayCacheRef.current = null;
    setIsDrawing(true);
    setPreviewOutline([]);
    setPreviewCenterline(null);
    clearQuickShapeHold();
    cancelScheduledPreview();
  }, [pressureFor, pixelSnap, gridSize, clearQuickShapeHold, cancelScheduledPreview, brush.stabilizer, hitScale]);

  const pointerMove = useCallback(
    (p: Point, e: PointerLike) => {
      if (!isDrawing) return;
      const snapped = pixelSnap ? snapToGridCell(p, gridSize) : p;
      if (pixelSnap) {
        // Pixel Brush stays on its own grid-snapped path, unaffected by
        // Stabilizer — a blocky brush has nothing to stabilize.
        const samples = samplesRef.current;
        const cores = pixelCoreRef.current;
        const last = samples[samples.length - 1];
        const minMove = gridSize * 0.5;
        if (Math.hypot(snapped.x - last.x, snapped.y - last.y) < minMove) {
          // Still inside the same cell: just remember if the pointer got to
          // its core, so an intentional corner cell isn't mistaken for a
          // clipped elbow below.
          if (isPixelCellCore(p, gridSize)) cores[cores.length - 1] = true;
          return;
        }
        // Diagonal fix: if the cell we're leaving (`last`) was only clipped
        // (pointer never reached its core) and going prev -> last -> new is
        // two orthogonal steps that together make a single diagonal step
        // prev -> new, drop `last` so the stroke steps diagonally instead of
        // detouring through the cell above/beside the diagonal one. A real
        // L-shaped corner is unaffected: drawing one puts the pointer
        // squarely inside the corner cell, which marks it as core.
        if (samples.length >= 2 && !cores[cores.length - 1]) {
          const prev = samples[samples.length - 2];
          const lcx = Math.round(last.x / gridSize - 0.5);
          const lcy = Math.round(last.y / gridSize - 0.5);
          const pcx = Math.round(prev.x / gridSize - 0.5);
          const pcy = Math.round(prev.y / gridSize - 0.5);
          const ncx = Math.round(snapped.x / gridSize - 0.5);
          const ncy = Math.round(snapped.y / gridSize - 0.5);
          const orthoIn = Math.abs(lcx - pcx) + Math.abs(lcy - pcy) === 1;
          const orthoOut = Math.abs(ncx - lcx) + Math.abs(ncy - lcy) === 1;
          const diagonal = Math.abs(ncx - pcx) === 1 && Math.abs(ncy - pcy) === 1;
          if (orthoIn && orthoOut && diagonal) {
            samples.pop();
            rawSamplesRef.current.pop();
            cores.pop();
          }
        }
        const sample: StrokeSample = { x: snapped.x, y: snapped.y, pressure: pressureFor(snapped, e) };
        rawSamplesRef.current.push(sample);
        samples.push(sample);
        cores.push(isPixelCellCore(p, gridSize));
        schedulePreviewUpdate();
        return;
      }
      const raw = rawSamplesRef.current;
      const lastRaw = raw[raw.length - 1];
      // Every coalesced sample now reaches here, so keep this threshold
      // small — dropping samples is what made fast strokes faceted.
      const minRawMove = 0.35 * hitScale;
      if (Math.hypot(snapped.x - lastRaw.x, snapped.y - lastRaw.y) < minRawMove) return;
      const rawSample = { x: snapped.x, y: snapped.y, pressure: pressureFor(snapped, e) };
      raw.push(rawSample);
      stabilizerRef.current?.push(rawSample, e.timeStamp ?? performance.now());
      // Real movement happened: any shape recognized while previously
      // holding still no longer applies, and the wait for the next hold
      // starts over from here.
      if (quickShapeRef.current) {
        // Re-derive the live preview stream from the real raw buffer
        // (instead of leaving it pointed at the just-cancelled snapped
        // shape's points) so the preview resumes smoothly, not from a
        // discontinuous jump.
        samplesRef.current = stabilizerRef.current?.samples ?? samplesToCenterline(raw, brush, hitScale);
      }
      quickShapeRef.current = null;
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      holdTimerRef.current = setTimeout(() => {
        const shape = detectQuickShape(
          rawSamplesRef.current.map((s) => ({ x: s.x, y: s.y })),
          hitScale,
          true
        );
        if (!shape) return;
        quickShapeRef.current = shape;
        let sumP = 0;
        for (const s of rawSamplesRef.current) sumP += s.pressure;
        const avgPressure = rawSamplesRef.current.length ? sumP / rawSamplesRef.current.length : 1;
        samplesRef.current = quickShapePolyline(shape).map((p) => ({ ...p, pressure: avgPressure }));
        schedulePreviewUpdate();
      }, QUICK_SHAPE_HOLD_MS);
      if (!quickShapeRef.current && stabilizerRef.current) samplesRef.current = stabilizerRef.current.samples;
      schedulePreviewUpdate();
    },
    [isDrawing, brush, schedulePreviewUpdate, pressureFor, gridSize, pixelSnap, hitScale]
  );

  const pointerUp = useCallback(() => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const heldShape = quickShapeRef.current;
    // Held still at the end and it read as a clean line/circle — use that
    // exact geometry as the centerline instead of the raw wobbly one, no
    // further smoothing needed since it's already perfect.
    // Otherwise commit exactly the stabilized stream the preview showed,
    // plus the tip's catch-up to where the pen lifted.
    const stab = stabilizerRef.current;
    const stabilized = stab ? [...stab.samples, ...stab.finish()] : rawSamplesRef.current;
    const centerlineSamples = heldShape
      ? quickShapePolyline(heldShape).map((p) => ({ ...p, pressure: 1 }))
      : samplesToCenterline(stabilized, brush, hitScale);
    // Preserve the tool's normal default (open centerline, closeSmoothly
    // false) unless a held circle/ellipse QuickShape calls for a closed
    // loop; a held line stays open, same as any other Brush stroke.
    //
    // REVERTED: this used to also auto-close a freehand gesture whose end
    // came back near its own start (isFreehandLoopClosed), to fix bowls
    // that were technically saved as open strokes. That guess is not safe
    // for every letterform — some letters (e.g. "C") are intentionally
    // open with a narrow aperture that a geometry-only test cannot tell
    // apart from an accidentally-unclosed bowl, and it ended up welding
    // "C" shut into an "O". Do not reintroduce shape-based closing here;
    // `closed` must come from an explicit signal (QuickShape, or the
    // Pencil tool) instead.
    const closeSmoothly = heldShape ? heldShape.kind !== "line" : false;
    const centerline = centerlineToContour(centerlineSamples, !pixelSnap, closeSmoothly);
    const rawSamples = centerlineSamples.map((s) => ({ ...s }));
    rawSamplesRef.current = [];
    samplesRef.current = [];
    stabilizerRef.current = null;
    pixelCoreRef.current = [];
    sprayCacheRef.current = null;
    setPreviewOutline([]);
    setPreviewCenterline(null);
    clearQuickShapeHold();
    cancelScheduledPreview();
    if (!centerline || !glyph) return;
    const obj: VectorObject = {
      id: shortId("obj"),
      kind: "brush",
      contours: [centerline],
      strokeWidth: brush.size,
      cap: brush.type === "monoline" ? brushCap : "round",
      join: "round",
      brushType: brush.type,
      // Bake the grid cell size in at draw time (Pixel Brush only) so this
      // stroke's blocks stay exactly as drawn even if the canvas grid size
      // is changed later.
      brushSettings: pixelSnap ? { ...brush, gridSnap: true, cellSize: gridSize } : { ...brush, gridSnap: undefined },
      samples: rawSamples,
    };
    commitOutline(activeChar, { objects: [...glyph.outline.objects, obj] });
  }, [isDrawing, brush, brushCap, glyph, activeChar, commitOutline, gridSize, pixelSnap, hitScale, clearQuickShapeHold]);

  const cancel = useCallback(() => {
    rawSamplesRef.current = [];
    samplesRef.current = [];
    stabilizerRef.current = null;
    pixelCoreRef.current = [];
    sprayCacheRef.current = null;
    setIsDrawing(false);
    setPreviewOutline([]);
    setPreviewCenterline(null);
    clearQuickShapeHold();
  }, [clearQuickShapeHold]);

  return { pointerDown, pointerMove, pointerUp, cancel, previewOutline, previewCenterline, isDrawing };
}
