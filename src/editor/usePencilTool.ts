import { useCallback, useRef, useState } from "react";
import type { Contour, Point, VectorObject } from "@/types/geometry";
import { useAppStore } from "@/glyph/store";
import { shortId } from "@/utils/id";
import { simplifyPolyline } from "@/utils/simplify";
import { smoothStroke } from "@/brushes/strokeSmoothing";
import { centerlineToContour } from "@/brushes/strokeToOutline";
import { detectQuickShape, quickShapePolyline, QUICK_SHAPE_HOLD_MS, type QuickShapeResult } from "./quickShape";

/** Below this many captured points, a gesture is a stray tap/jitter, not a
 * real path — nothing is committed (mirrors the Shape tool's "drag too
 * small" no-op). */
const MIN_RAW_POINTS = 3;
/** A fitted contour needs at least a triangle's worth of on-curve nodes to
 * read as a real shape once closed. */
const MIN_SHAPE_NODES = 3;
/** Extra RDP tolerance (screen px) applied once, only to the final
 * committed shape — see the comment above its use in pointerUp. Chosen a
 * bit above the live pass's own upper bound (13.5px worth of effective
 * tolerance) so it only ever removes points the live pass left behind for
 * responsiveness, not ones that were load-bearing for the curve's shape. */
const FINAL_SIMPLIFY_TOLERANCE_PX = 3.5;

/**
 * Thin, Pencil-flavored wrapper around the shared `smoothStroke` engine
 * (see `brushes/strokeSmoothing.ts`) — kept as its own export so the rest
 * of this file (and its comments below) can keep talking about "Pencil
 * points" specifically, and so existing call sites don't need to change.
 * The Brush tool calls `smoothStroke` directly for the same reason: both
 * tools now run through the exact same algorithm, just with their own
 * setting value and epsilon scale.
 */
export function smoothPencilPoints(rawPoints: Point[], smoothing: number, hitScale: number): Point[] {
  return smoothStroke(rawPoints, smoothing, hitScale);
}

export function usePencilTool(hitScale: number) {
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const commitOutline = useAppStore((s) => s.commitOutline);
  const pencilSmoothing = useAppStore((s) => s.pencilSmoothing);
  const pencilPostSmoothing = useAppStore((s) => s.pencilPostSmoothing);

  const rawPointsRef = useRef<Point[]>([]);
  const [previewContour, setPreviewContour] = useState<Contour | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

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
    setIsDrawing(true);
    setPreviewContour(null);
    clearQuickShapeHold();
  }, [clearQuickShapeHold]);

  const pointerMove = useCallback(
    (p: Point) => {
      if (!isDrawing) return;
      // Guard against a stray non-finite pointer sample (seen occasionally
      // on Safari during fast/jittery input) ever entering the point
      // stream that gets curve-fit below — one bad sample there can
      // otherwise cascade into a NaN in the fitted path's geometry.
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
      const pts = rawPointsRef.current;
      const last = pts[pts.length - 1];
      const minMove = Math.max(0.8, 1.2 * hitScale);
      if (Math.hypot(p.x - last.x, p.y - last.y) < minMove) return;
      pts.push(p);
      // Real movement happened: any shape recognized while previously
      // holding still no longer applies, and the wait for the next hold
      // starts over from here.
      quickShapeRef.current = null;
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      holdTimerRef.current = setTimeout(() => {
        const shape = detectQuickShape(rawPointsRef.current, hitScale, false);
        if (!shape) return;
        quickShapeRef.current = shape;
        setPreviewContour(centerlineToContour(quickShapePolyline(shape), true, true));
      }, QUICK_SHAPE_HOLD_MS);
      if (pts.length < 2) return;
      const smoothed = smoothPencilPoints(pts, pencilSmoothing, hitScale);
      setPreviewContour(centerlineToContour(smoothed, true, true));
    },
    [isDrawing, pencilSmoothing, hitScale]
  );

  const pointerUp = useCallback(() => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const raw = rawPointsRef.current;
    const heldShape = quickShapeRef.current;
    rawPointsRef.current = [];
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

    // pointerUp uses pencilPostSmoothing (user-controlled "result" slider)
    // not the live pencilSmoothing baseline — so drawing never self-steers
    // but the committed shape gets as much cleanup as the user asked for.
    let smoothed = smoothPencilPoints(raw, pencilPostSmoothing, hitScale);
    // Second, more aggressive cleanup pass on the COMMITTED shape only
    // (never on the live preview, so the stroke still tracks the pointer
    // 1:1 while drawing). The Brush tool gets an equivalent second pass
    // for free because it simplifies twice — once on the raw centerline,
    // once again on the offset outline edges (see strokeToOutline.ts) —
    // but Pencil only ever produces a single centerline-turned-contour, so
    // without this it kept noticeably more nodes than a Brush stroke of
    // similar shape for the same `smoothing` setting. Epsilon here is
    // deliberately independent of `smoothing` (unlike the live pass): a
    // shape that's just been finished should always get this final
    // node-count cleanup, even with the smoothing slider low.
    smoothed = simplifyPolyline(smoothed, FINAL_SIMPLIFY_TOLERANCE_PX * hitScale);
    // Pencil always finishes as a closed, filled shape — standard
    // professional-app Pencil behavior (Illustrator/Affinity): releasing
    // the pointer auto-closes the path even when the stroke's start and
    // end never actually met. `closeSmoothly=true` fits the closing seam
    // the same way as every other node on the stroke (smooth tangent when
    // the gesture's curvature calls for it, a real corner only when the
    // seam is a genuinely sharp turn) instead of always forcing a straight
    // line across the gap.
    const contour = centerlineToContour(smoothed, true, true);
    if (!contour || contour.nodes.length < MIN_SHAPE_NODES) return;

    const obj: VectorObject = { id: shortId("obj"), kind: "shape", contours: [contour] };
    commitOutline(activeChar, { objects: [...glyph.outline.objects, obj] });
    // Deliberately stays on the Pencil tool (matching Brush) rather than
    // hopping to Select — freehand sketching is almost always several
    // strokes in a row (e.g. an outer contour, then an inner counter).
  }, [isDrawing, glyph, activeChar, commitOutline, pencilSmoothing, pencilPostSmoothing, hitScale, clearQuickShapeHold]);

  const cancel = useCallback(() => {
    rawPointsRef.current = [];
    setIsDrawing(false);
    setPreviewContour(null);
    clearQuickShapeHold();
  }, [clearQuickShapeHold]);

  return { pointerDown, pointerMove, pointerUp, cancel, previewContour, isDrawing };
}
