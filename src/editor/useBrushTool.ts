import { useCallback, useRef, useState } from "react";
import type { Contour, Point, StrokeSample, VectorObject } from "@/types/geometry";
import { useAppStore } from "@/glyph/store";
import { samplesToCenterline, centerlineToContour, centerlineToOutlineContours } from "@/brushes/strokeToOutline";
import { appendStabilizedSample } from "@/brushes/strokeSmoothing";
import { shortId } from "@/utils/id";
import { detectQuickShape, quickShapePolyline, QUICK_SHAPE_HOLD_MS, type QuickShapeResult } from "./quickShape";

interface PointerLike { pressure?: number; pointerType?: string; }

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
 * Brush Stabilizer shares the same underlying engine as the Pencil tool's
 * Stabilizer (see `brushes/strokeSmoothing.ts`), but the two moments in a
 * stroke's life use it differently:
 *  - WHILE DRAWING (pointerMove), only a cheap, append-only approximation
 *    runs (`appendStabilizedSample`) — one new point per move, from a
 *    small trailing window, never revisiting earlier points. Running the
 *    full roughness-boosted double moving average + RDP simplify pass over
 *    the ENTIRE raw buffer on every move used to be the actual engine here,
 *    and once Stabilizer was above 0 that caused visible lag on longer
 *    strokes (the pass gets more expensive the longer you draw) and a
 *    broken/discontinuous look (RDP's kept points can reshuffle completely
 *    frame to frame, since its output depends on the whole buffer).
 *  - ON COMMIT (pointerUp), the exact, full engine runs exactly once over
 *    the complete raw buffer, so the saved geometry is fully accurate
 *    regardless of how the live preview approximated it.
 * `hitScale` is passed through so a low Stabilizer value stays crisp at any
 * zoom level, matching Pencil.
 */
export function useBrushTool(hitScale: number) {
  const brush = useAppStore((s) => s.brush);
  const brushCap = useAppStore((s) => s.brushCap);
  const gridSize = useAppStore((s) => s.gridSize);
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const commitOutline = useAppStore((s) => s.commitOutline);

  // Raw captured pointer stream (font units), deduped the same way Pencil
  // dedupes its own raw stream — see usePencilTool.ts pointerMove. This is
  // what the full smoothing engine reprocesses exactly once, on pointerUp,
  // to build the committed geometry.
  const rawSamplesRef = useRef<StrokeSample[]>([]);
  // Cheap, incrementally-grown approximation of the stabilized stream,
  // used ONLY for the live preview while still drawing (see
  // appendStabilizedSample). The committed object's `obj.samples` (for
  // non-destructive Expand) is built separately, from the full engine, in
  // pointerUp — it does not reuse this ref.
  const samplesRef = useRef<StrokeSample[]>([]);
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
    return { centerline: null as Contour | null, outline: centerlineToOutlineContours(cl, settings) };
  }, [brush, gridSize, pixelSnap, hitScale]);

  const pointerDown = useCallback((p: Point, e: PointerLike) => {
    // Pixel brush: snap captured points to the centers of canvas grid cells as you draw, for
    // a genuine blocky/pixel-font-friendly stroke rather than a smoothed curve.
    const snapped = pixelSnap ? snapToGridCell(p, gridSize) : p;
    const sample: StrokeSample = { x: snapped.x, y: snapped.y, pressure: pressureFor(snapped, e) };
    rawSamplesRef.current = [sample];
    samplesRef.current = [sample];
    setIsDrawing(true);
    setPreviewOutline([]);
    setPreviewCenterline(null);
    clearQuickShapeHold();
  }, [pressureFor, pixelSnap, gridSize, clearQuickShapeHold]);

  const pointerMove = useCallback(
    (p: Point, e: PointerLike) => {
      if (!isDrawing) return;
      const snapped = pixelSnap ? snapToGridCell(p, gridSize) : p;
      if (pixelSnap) {
        // Pixel Brush stays on its own grid-snapped path, unaffected by
        // Stabilizer — a blocky brush has nothing to stabilize.
        const samples = samplesRef.current;
        const last = samples[samples.length - 1];
        const minMove = gridSize * 0.5;
        if (Math.hypot(snapped.x - last.x, snapped.y - last.y) < minMove) return;
        const sample: StrokeSample = { x: snapped.x, y: snapped.y, pressure: pressureFor(snapped, e) };
        rawSamplesRef.current.push(sample);
        samples.push(sample);
        const preview = buildPreview();
        setPreviewCenterline(preview.centerline);
        setPreviewOutline(preview.outline);
        return;
      }
      const raw = rawSamplesRef.current;
      const lastRaw = raw[raw.length - 1];
      const minRawMove = Math.max(0.8, 1.2 * hitScale);
      if (Math.hypot(snapped.x - lastRaw.x, snapped.y - lastRaw.y) < minRawMove) return;
      raw.push({ x: snapped.x, y: snapped.y, pressure: pressureFor(snapped, e) });
      // Real movement happened: any shape recognized while previously
      // holding still no longer applies, and the wait for the next hold
      // starts over from here.
      if (quickShapeRef.current) {
        // Re-derive the live preview stream from the real raw buffer
        // (instead of leaving it pointed at the just-cancelled snapped
        // shape's points) so the preview resumes smoothly, not from a
        // discontinuous jump.
        samplesRef.current = samplesToCenterline(raw, brush, hitScale);
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
        const preview = buildPreview();
        setPreviewCenterline(preview.centerline);
        setPreviewOutline(preview.outline);
      }, QUICK_SHAPE_HOLD_MS);
      // Live preview only: append ONE new stabilized point from a small
      // trailing window, instead of re-running the full smoothing+RDP
      // engine over the whole growing raw buffer on every move (that was
      // the source of the "Stabilizer > 0 lags and draws a broken line"
      // bug — see appendStabilizedSample's doc comment). The exact, full
      // engine still runs once on pointerUp for the actual committed
      // geometry, so this only affects what you see while still drawing.
      samplesRef.current = appendStabilizedSample(raw, samplesRef.current, brush.stabilizer ?? 0);
      const preview = buildPreview();
      setPreviewCenterline(preview.centerline);
      setPreviewOutline(preview.outline);
    },
    [isDrawing, brush, buildPreview, pressureFor, gridSize, pixelSnap, hitScale]
  );

  const pointerUp = useCallback(() => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const heldShape = quickShapeRef.current;
    // Held still at the end and it read as a clean line/circle — use that
    // exact geometry as the centerline instead of the raw wobbly one, no
    // further smoothing needed since it's already perfect.
    const centerlineSamples = heldShape
      ? quickShapePolyline(heldShape).map((p) => ({ ...p, pressure: 1 }))
      : samplesToCenterline(rawSamplesRef.current, brush, hitScale);
    // Build the FINAL geometry from the full, exact engine over the raw
    // pointer buffer — not from the cheap incremental live-preview stream
    // in samplesRef (see appendStabilizedSample's doc comment). This is
    // the one point per stroke where the more expensive full
    // smoothing+RDP pass is worth paying for, since it only runs once.
    // Preserve the tool's normal default (open centerline, closeSmoothly
    // false) unless a held circle/ellipse QuickShape calls for a closed
    // loop; a held line stays open, same as any other Brush stroke.
    const closeSmoothly = heldShape ? heldShape.kind !== "line" : false;
    const centerline = centerlineToContour(centerlineSamples, !pixelSnap, closeSmoothly);
    const rawSamples = centerlineSamples.map((s) => ({ ...s }));
    rawSamplesRef.current = [];
    samplesRef.current = [];
    setPreviewOutline([]);
    setPreviewCenterline(null);
    clearQuickShapeHold();
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
    setIsDrawing(false);
    setPreviewOutline([]);
    setPreviewCenterline(null);
    clearQuickShapeHold();
  }, [clearQuickShapeHold]);

  return { pointerDown, pointerMove, pointerUp, cancel, previewOutline, previewCenterline, isDrawing };
}
