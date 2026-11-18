import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Contour, PathNode, Point, VectorObject } from "@/types/geometry";
import { useAppStore } from "@/glyph/store";
import { shortId } from "@/utils/id";
import { fitFreehandClosed } from "@/utils/fitCurve";
import { centerlineToContour } from "@/brushes/strokeToOutline";
import { detectQuickShape, quickShapePolyline, QUICK_SHAPE_HOLD_MS, type QuickShapeResult } from "./quickShape";
import { createPreviewStore, type PreviewStore } from "./previewStore";

export interface PencilToolOptions {
  /** Publish the live preview through `previewStore` instead of React state
   *  (see useBrushTool's option of the same name). When set, the returned
   *  `previewContour` stays null. */
  externalPreview?: boolean;
}

/** Below this many captured points, a gesture is a stray tap/jitter, not a
 * real path — nothing is committed (mirrors the Shape tool's "drag too
 * small" no-op). */
const MIN_RAW_POINTS = 3;
/** A fitted contour needs at least a triangle's worth of on-curve nodes to
 * read as a real shape once closed. */
const MIN_SHAPE_NODES = 2;

/*
 * Pencil model (adapted from DesignSeru's Pencil):
 *  - While drawing, every sample goes through a "rope" stabilizer: the pen
 *    tip trails the pointer on a string of `Stabilizer × 28` screen px and
 *    only moves once the string is taut. Each captured point is FINAL the
 *    moment it is recorded — the live preview draws exactly those points,
 *    so nothing already drawn ever shifts while the stroke grows. (The old
 *    pencil re-smoothed and re-fitted the WHOLE stroke on every frame, so
 *    earlier parts kept wobbling, then jumped again on release.)
 *  - On release the captured points are curve-fitted once (Schneider) with
 *    a tolerance of `0.9 + Smoothing × 4.5` screen px, sharp turns kept as
 *    corners. The result hugs what was on screen, with few nodes.
 */
/** Rope length at Stabilizer 100%, in screen px. */
const ROPE_PX_AT_FULL = 28;
/** Captured points closer than this (screen px) are not recorded. */
const MIN_STEP_PX = 0.6;
/** Ends closer than this (screen px) are joined as one smooth loop. */
const CLOSE_GAP_PX = 12;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Rope stabilizer step: the tip only follows once the pointer is more
 *  than `radius` away from it. */
function rope(pos: Point, target: Point, radius: number): Point {
  const d = dist(pos, target);
  if (d <= radius) return pos;
  const k = (d - radius) / d;
  return { x: pos.x + (target.x - pos.x) * k, y: pos.y + (target.y - pos.y) * k };
}

/** Error tolerance for the final fit, in font units. */
export function pencilFitError(postSmoothing: number, hitScale: number): number {
  return (0.9 + Math.max(0, Math.min(1, postSmoothing)) * 4.5) * hitScale;
}

/** The finished, closed Pencil contour for a captured stroke (null = too small). */
export function fitPencilContour(points: Point[], postSmoothing: number, hitScale: number): Contour | null {
  if (points.length < 2) return null;
  const nodes = fitFreehandClosed(points, pencilFitError(postSmoothing, hitScale), 0.3 * hitScale, CLOSE_GAP_PX * hitScale);
  if (nodes.length < MIN_SHAPE_NODES) return null;
  // Two nodes only close into a shape when at least one segment is curved.
  if (nodes.length === 2 && !nodes.some((n) => n.handleIn || n.handleOut)) return null;
  return { id: shortId("c"), nodes, closed: true };
}

/** Contour id of the live Pencil stroke preview (a plain polyline). */
export const PENCIL_PREVIEW_ID = "pencil-preview";

export function usePencilTool(hitScale: number, options?: PencilToolOptions) {
  const externalPreview = options?.externalPreview === true;
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const commitOutline = useAppStore((s) => s.commitOutline);
  const pencilSmoothing = useAppStore((s) => s.pencilSmoothing);
  const pencilPostSmoothing = useAppStore((s) => s.pencilPostSmoothing);

  /** Stabilized, final points of the stroke in progress. */
  const rawPointsRef = useRef<Point[]>([]);
  /** Rope tip (last stabilized position) and the real pointer position. */
  const tipRef = useRef<Point | null>(null);
  const pointerRef = useRef<Point | null>(null);
  const [previewContourState, setPreviewContourState] = useState<Contour | null>(null);
  const previewStoreRef = useRef<PreviewStore<Contour | null> | null>(null);
  if (!previewStoreRef.current) previewStoreRef.current = createPreviewStore<Contour | null>(null);
  const previewStore = previewStoreRef.current;
  const setPreviewContour = useCallback((next: Contour | null) => {
    if (externalPreview) previewStore.set(next);
    else setPreviewContourState(next);
  }, [externalPreview, previewStore]);
  const previewContour = externalPreview ? null : previewContourState;
  /** Preview nodes, appended as points arrive — never rebuilt mid-stroke. */
  const previewNodesRef = useRef<PathNode[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  // Synchronous mirror of isDrawing (coalesced samples can arrive before the
  // re-render that follows pointerDown/pointerUp).
  const isDrawingRef = useRef(false);
  // The live preview (the captured points, drawn as-is) is rebuilt at most
  // once per animation frame, no matter how many pointer samples arrived in
  // between — every sample is still recorded.
  const previewRafRef = useRef<number | null>(null);
  const cancelScheduledPreview = useCallback(() => {
    if (previewRafRef.current !== null) {
      cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = null;
    }
  }, []);
  useEffect(() => cancelScheduledPreview, [cancelScheduledPreview]);

  // QuickShape (Procreate-style "hold at the end to snap") state — see
  // quickShape.ts. `holdTimerRef` fires once the pointer has been still
  // for QUICK_SHAPE_HOLD_MS; `quickShapeRef` holds whatever it found, so
  // pointerUp can commit the perfect shape instead of the raw gesture.
  // Circle/ellipse only here — a straight line has no area for Pencil's
  // always-filled shape to fill, so line snapping is Brush-only.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickShapeRef = useRef<QuickShapeResult | null>(null);

  const clearQuickShapeHold = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    quickShapeRef.current = null;
  }, []);

  const pointerDown = useCallback((p: Point) => {
    rawPointsRef.current = [p];
    previewNodesRef.current = [];
    tipRef.current = p;
    pointerRef.current = p;
    isDrawingRef.current = true;
    setIsDrawing(true);
    cancelScheduledPreview();
    setPreviewContour(null);
    clearQuickShapeHold();
  }, [clearQuickShapeHold, cancelScheduledPreview, setPreviewContour]);

  const flushPreview = useCallback(() => {
    previewRafRef.current = null;
    const pts = rawPointsRef.current;
    if (!isDrawingRef.current || pts.length < 2 || quickShapeRef.current) return;
    const nodes = previewNodesRef.current;
    for (let i = nodes.length; i < pts.length; i++) nodes.push({ id: `pv${i}`, point: pts[i], handleIn: null, handleOut: null, type: "corner" });
    // New wrapper each frame (the preview store compares by identity); the
    // node array itself is shared and only ever grows during a stroke.
    setPreviewContour({ id: PENCIL_PREVIEW_ID, closed: true, nodes });
  }, [setPreviewContour]);

  const pointerMove = useCallback(
    (p: Point) => {
      if (!isDrawingRef.current) return;
      // Guard against a stray non-finite pointer sample (seen occasionally
      // on Safari during fast/jittery input) ever entering the point
      // stream that gets curve-fit below — one bad sample there can
      // otherwise cascade into a NaN in the fitted path's geometry.
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
      const pts = rawPointsRef.current;
      const last = pts[pts.length - 1];
      pointerRef.current = p;
      const tip = rope(tipRef.current ?? last, p, Math.max(0, Math.min(1, pencilSmoothing)) * ROPE_PX_AT_FULL * hitScale);
      if (dist(tip, last) < MIN_STEP_PX * hitScale) return;
      tipRef.current = tip;
      pts.push(tip);
      // Real movement happened: any shape recognized while previously
      // holding still no longer applies, and the wait for the next hold
      // starts over from here.
      quickShapeRef.current = null;
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      holdTimerRef.current = setTimeout(() => {
        if (!isDrawingRef.current) return;
        const shape = detectQuickShape(rawPointsRef.current, hitScale, false);
        if (!shape) return;
        quickShapeRef.current = shape;
        cancelScheduledPreview();
        setPreviewContour(centerlineToContour(quickShapePolyline(shape), true, true));
      }, QUICK_SHAPE_HOLD_MS);
      if (pts.length < 2) return;
      if (previewRafRef.current === null) previewRafRef.current = requestAnimationFrame(flushPreview);
    },
    [hitScale, pencilSmoothing, flushPreview, cancelScheduledPreview, setPreviewContour]
  );

  const pointerUp = useCallback(() => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    setIsDrawing(false);
    const raw = rawPointsRef.current;
    const heldShape = quickShapeRef.current;
    const pointer = pointerRef.current;
    rawPointsRef.current = [];
    previewNodesRef.current = [];
    tipRef.current = null;
    pointerRef.current = null;
    cancelScheduledPreview();
    setPreviewContour(null);
    clearQuickShapeHold();
    if (raw.length < MIN_RAW_POINTS || !glyph) return;

    if (heldShape) {
      // Held still at the end and it read as a clean shape — commit the
      // perfect geometry as-is, no further smoothing/simplification (it's
      // already exact).
      const contour = centerlineToContour(quickShapePolyline(heldShape), true, true);
      if (!contour || contour.nodes.length < MIN_SHAPE_NODES) return;
      const obj: VectorObject = { id: shortId("obj"), kind: "shape", contours: [contour] };
      commitOutline(activeChar, { objects: [...glyph.outline.objects, obj] });
      return;
    }

    // With a light stabilizer the stroke should end where the pointer was
    // lifted, not a rope-length short of it (DesignSeru does the same).
    if (pointer && pencilSmoothing < 0.6 && dist(pointer, raw[raw.length - 1]) > 0.5 * hitScale) raw.push(pointer);
    // Pencil always finishes as a closed, filled shape (Illustrator/Affinity
    // Pencil behaviour) — see fitFreehandClosed for how the seam is made.
    const contour = fitPencilContour(raw, pencilPostSmoothing, hitScale);
    if (!contour) return;

    const obj: VectorObject = { id: shortId("obj"), kind: "shape", contours: [contour] };
    commitOutline(activeChar, { objects: [...glyph.outline.objects, obj] });
    // Deliberately stays on the Pencil tool (matching Brush) rather than
    // hopping to Select — freehand sketching is almost always several
    // strokes in a row (e.g. an outer contour, then an inner counter).
  }, [glyph, activeChar, commitOutline, pencilSmoothing, pencilPostSmoothing, hitScale, clearQuickShapeHold, cancelScheduledPreview, setPreviewContour]);

  const cancel = useCallback(() => {
    rawPointsRef.current = [];
    previewNodesRef.current = [];
    tipRef.current = null;
    pointerRef.current = null;
    isDrawingRef.current = false;
    setIsDrawing(false);
    cancelScheduledPreview();
    setPreviewContour(null);
    clearQuickShapeHold();
  }, [clearQuickShapeHold, cancelScheduledPreview, setPreviewContour]);

  return useMemo(
    () => ({ pointerDown, pointerMove, pointerUp, cancel, previewContour, previewStore, isDrawing }),
    [pointerDown, pointerMove, pointerUp, cancel, previewContour, previewStore, isDrawing]
  );
}
