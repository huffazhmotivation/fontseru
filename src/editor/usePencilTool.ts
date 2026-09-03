import { useCallback, useRef, useState } from "react";
import type { Contour, Point, VectorObject } from "@/types/geometry";
import { useAppStore } from "@/glyph/store";
import { shortId } from "@/utils/id";
import { simplifyPolyline } from "@/utils/simplify";
import { centerlineToContour } from "@/brushes/strokeToOutline";

/** Below this many captured points, a gesture is a stray tap/jitter, not a
 * real path — nothing is committed (mirrors the Shape tool's "drag too
 * small" no-op). */
const MIN_RAW_POINTS = 3;
/** A fitted contour needs at least a triangle's worth of on-curve nodes to
 * read as a real shape once closed. */
const MIN_SHAPE_NODES = 3;

function movingAveragePoints(points: Point[], windowRadius: number): Point[] {
  if (windowRadius <= 0) return points;
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(0, i - windowRadius); j <= Math.min(points.length - 1, i + windowRadius); j++) {
      sx += points[j].x; sy += points[j].y; n++;
    }
    out.push({ x: sx / n, y: sy / n });
  }
  return out;
}

/**
 * Roughness score in [0, 1]: the fraction of interior samples where the
 * RAW (unsmoothed) hand-drawn gesture reverses direction sharply from one
 * sample to the next. Real hand tremor shows up as many small, high-
 * frequency direction flips; a deliberate curve turns gradually over many
 * samples and barely trips this at all. Used to boost smoothing
 * automatically on a shaky stroke instead of requiring the smoothing
 * slider to be cranked up globally — which would also flatten intentional
 * curvature on every OTHER stroke.
 */
function estimateRoughness(points: Point[]): number {
  if (points.length < 5) return 0;
  const JITTER_ANGLE = (16 * Math.PI) / 180;
  let jittery = 0;
  let counted = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const u0x = b.x - a.x, u0y = b.y - a.y;
    const u1x = c.x - b.x, u1y = c.y - b.y;
    const l0 = Math.hypot(u0x, u0y);
    const l1 = Math.hypot(u1x, u1y);
    if (l0 < 1e-6 || l1 < 1e-6) continue;
    const dot = Math.max(-1, Math.min(1, (u0x * u1x + u0y * u1y) / (l0 * l1)));
    counted++;
    if (Math.acos(dot) > JITTER_ANGLE) jittery++;
  }
  return counted === 0 ? 0 : jittery / counted;
}

/**
 * Cleans a raw freehand polyline (font units) into the sparse, editable
 * point set that gets bezier-fit below. Two passes of moving-average
 * smoothing round out hand tremor without flattening the gesture's real
 * shape, then Ramer-Douglas-Peucker collapses the dense pointer samples
 * down to just the points needed to keep the curve's silhouette. Both the
 * smoothing window and the simplification tolerance scale with
 * `smoothing` (the Pencil tool's own setting, defaulted fairly high) AND
 * with the stroke's own measured roughness — a shaky gesture gets extra
 * smoothing passes automatically so it never comes out as a jagged
 * zigzag, without needing the user to preemptively max out the setting.
 */
export function smoothPencilPoints(rawPoints: Point[], smoothing: number, hitScale: number): Point[] {
  if (rawPoints.length < 3) return rawPoints;
  const roughness = estimateRoughness(rawPoints);
  const effective = Math.max(0, Math.min(1, smoothing + roughness * 0.5));
  const windowRadius = Math.max(1, Math.round(effective * 8));
  let smoothed = movingAveragePoints(rawPoints, windowRadius);
  smoothed = movingAveragePoints(smoothed, Math.max(1, Math.round(windowRadius * 0.6)));
  // Tolerance is in screen-pixel terms (scaled to font units via hitScale)
  // so the same visual crispness holds regardless of zoom level. Raised
  // again (1.6–8.5px -> 2.6–13.5px): even the widened first pass still
  // left a hand-drawn curve with noticeably more on-curve nodes than the
  // cubic-bezier fit below actually needs — the same "dense samples become
  // real nodes 1:1" issue the Brush tool had (see samplesToCenterline /
  // centerlineToOutline). Wider tolerance means fewer, better-placed points
  // go into the fit, i.e. fewer nodes for the same visual smoothness — not
  // a laxer curve, since RDP only ever drops a point that doesn't deviate
  // from the line between its kept neighbors by more than this tolerance.
  const epsilon = Math.max(2.6, 2.4 + effective * 11) * hitScale;
  return simplifyPolyline(smoothed, epsilon);
}

export function usePencilTool(hitScale: number) {
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const commitOutline = useAppStore((s) => s.commitOutline);
  const pencilSmoothing = useAppStore((s) => s.pencilSmoothing);

  const rawPointsRef = useRef<Point[]>([]);
  const [previewContour, setPreviewContour] = useState<Contour | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  const pointerDown = useCallback((p: Point) => {
    rawPointsRef.current = [p];
    setIsDrawing(true);
    setPreviewContour(null);
  }, []);

  const pointerMove = useCallback(
    (p: Point) => {
      if (!isDrawing) return;
      const pts = rawPointsRef.current;
      const last = pts[pts.length - 1];
      const minMove = Math.max(0.8, 1.2 * hitScale);
      if (Math.hypot(p.x - last.x, p.y - last.y) < minMove) return;
      pts.push(p);
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
    rawPointsRef.current = [];
    setPreviewContour(null);
    if (raw.length < MIN_RAW_POINTS || !glyph) return;

    const smoothed = smoothPencilPoints(raw, pencilSmoothing, hitScale);
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
  }, [isDrawing, glyph, activeChar, commitOutline, pencilSmoothing, hitScale]);

  const cancel = useCallback(() => {
    rawPointsRef.current = [];
    setIsDrawing(false);
    setPreviewContour(null);
  }, []);

  return { pointerDown, pointerMove, pointerUp, cancel, previewContour, isDrawing };
}
