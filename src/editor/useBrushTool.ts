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
 * Detects an ordinary freehand Monoline/Brush gesture that the user clearly
 * meant as a closed loop — the bowl of an "a"/"e"/"g"/"p"/"q", the counter of
 * a "B"/"R", etc. — WITHOUT requiring the explicit hold-still QuickShape
 * circle/ellipse snap.
 *
 * BUG FIX ("lubang jadi tertutup" / holes closing up on export): `pointerUp`
 * previously only ever set `closeSmoothly` (which becomes `contour.closed`)
 * to true when a held QuickShape kicked in, and QuickShape only recognizes a
 * handful of clean primitive shapes (line, circle/ellipse, ...). Any other
 * hand-drawn loop — which is most bowls, since real letterforms are rarely
 * perfect circles — always got `closed: false`, no matter how obviously the
 * user traced back to their own starting point. `uniformCenterlineToOutline`
 * (strokeToOutline.ts) branches on that exact flag: a *closed* centerline
 * gets its two offset edges kept as independent outer/inner rings (a real
 * hole), but an *open* one gets both ends capped and welded into a single
 * ring, which is only correct for a genuine open stroke (a stem, a
 * crossbar). Capping a stroke whose start and end already sit on top of
 * each other pinches the weld into a razor-thin, self-intersecting seam —
 * exactly the topology the exact clipper resolves unreliably, per the doc
 * comments on `objectToMultiPolygon`/`multiPolygonToContours` in
 * booleanOps.ts — which is what was silently collapsing counters like "e"
 * and "g" into solid ink, and squeezing others (e.g. "a") down to a
 * hairline sliver, in exported OTFs despite looking fine in the live
 * preview's forgiving anti-aliased render.
 *
 * This only fires for a gesture that both (a) travelled a real distance —
 * so a tiny jitter/dot never counts — and (b) ends up back close to its own
 * start relative to that travelled size, so a genuine open stroke (whose
 * ends are naturally far apart) is never affected.
 */
function isFreehandLoopClosed(samples: { x: number; y: number }[], strokeWidth: number): boolean {
  if (samples.length < 4) return false;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const gap = Math.hypot(last.x - first.x, last.y - first.y);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let length = 0;
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (i > 0) length += Math.hypot(p.x - samples[i - 1].x, p.y - samples[i - 1].y);
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY);

  // Too small to be a meaningful loop (a dot, a short jab) — leave it open.
  if (diagonal < strokeWidth * 1.5) return false;
  // A real loop travels out and all the way back — a simple open stroke
  // (even a curved one) never approaches ~2x its own bounding diagonal in
  // travelled length the way a closed bowl does.
  if (length < diagonal * 1.6) return false;

  const closeThreshold = Math.max(strokeWidth * 1.25, diagonal * 0.12);
  return gap <= closeThreshold;
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
    // `fast: true` only matters for Spray Brush (every other brush type
    // ignores it) — see sprayBrushOutlineContours' doc comment. It swaps
    // the live-drawing preview to a much cheaper, thinned-out speck field
    // instead of the full one, which is what was causing Spray Brush to
    // lag/stutter while actively drawing (the full field was previously
    // rebuilt from scratch on every pointer move for the whole stroke so
    // far). The final committed stroke is unaffected: it's rendered via
    // brushOutlineContours()/getGlyphPaths() elsewhere, which never passes
    // this flag and always uses the full-fidelity field.
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
    samplesRef.current = [sample];
    setIsDrawing(true);
    setPreviewOutline([]);
    setPreviewCenterline(null);
    clearQuickShapeHold();
    cancelScheduledPreview();
  }, [pressureFor, pixelSnap, gridSize, clearQuickShapeHold, cancelScheduledPreview]);

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
        schedulePreviewUpdate();
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
        schedulePreviewUpdate();
      }, QUICK_SHAPE_HOLD_MS);
      // Live preview only: append ONE new stabilized point from a small
      // trailing window, instead of re-running the full smoothing+RDP
      // engine over the whole growing raw buffer on every move (that was
      // the source of the "Stabilizer > 0 lags and draws a broken line"
      // bug — see appendStabilizedSample's doc comment). The exact, full
      // engine still runs once on pointerUp for the actual committed
      // geometry, so this only affects what you see while still drawing.
      samplesRef.current = appendStabilizedSample(raw, samplesRef.current, brush.stabilizer ?? 0);
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
    // loop (a held line stays open, same as any other Brush stroke), OR the
    // freehand gesture itself already reads as a closed loop — see
    // isFreehandLoopClosed's doc comment for why this matters for Monoline
    // bowls/counters that never trigger QuickShape.
    const closeSmoothly = heldShape
      ? heldShape.kind !== "line"
      : isFreehandLoopClosed(centerlineSamples, brush.size);
    // A freehand loop's start and end are only ever APPROXIMATELY on top of
    // each other — never pixel-exact like a QuickShape's generated polyline
    // already is. Snap the last sample exactly onto the first before
    // building the contour so the closed ring gets a perfectly coincident
    // seam instead of a near-miss razor-thin gap, which is the same
    // self-intersecting topology this fix exists to avoid in the first
    // place (see isFreehandLoopClosed's doc comment).
    const closedCenterlineSamples =
      closeSmoothly && !heldShape
        ? [...centerlineSamples.slice(0, -1), { ...centerlineSamples[centerlineSamples.length - 1], x: centerlineSamples[0].x, y: centerlineSamples[0].y }]
        : centerlineSamples;
    const centerline = centerlineToContour(closedCenterlineSamples, !pixelSnap, closeSmoothly);
    const rawSamples = centerlineSamples.map((s) => ({ ...s }));
    rawSamplesRef.current = [];
    samplesRef.current = [];
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
    setIsDrawing(false);
    setPreviewOutline([]);
    setPreviewCenterline(null);
    clearQuickShapeHold();
  }, [clearQuickShapeHold]);

  return { pointerDown, pointerMove, pointerUp, cancel, previewOutline, previewCenterline, isDrawing };
}
