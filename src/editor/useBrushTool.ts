import { useCallback, useRef, useState } from "react";
import type { Contour, Point, StrokeSample, VectorObject } from "@/types/geometry";
import { useAppStore } from "@/glyph/store";
import { samplesToCenterline, centerlineToContour, centerlineToOutlineContours } from "@/brushes/strokeToOutline";
import { shortId } from "@/utils/id";

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
 * Lightweight live pointer filter for Brush Stabilizer.
 * 0 preserves the legacy direct capture path exactly; 1 uses the strongest
 * filtering while still advancing on every accepted pointer sample.
 *
 * A low-pass ("catch up slowly") filter, the same family of technique
 * Procreate's StreamLine uses: the live point eases toward the raw pointer
 * by a strength-scaled fraction each sample instead of jumping straight to
 * it. This is deliberately NOT a "pulled string" leash that only starts
 * moving once the pointer strays past a fixed radius — that model always
 * advances in a straight line to wherever the raw pointer currently is,
 * which cuts a deliberate curve into visible corner-like facets. A low-pass
 * filter instead rounds bends smoothly while still suppressing hand tremor,
 * because tremor is high-frequency (filtered out almost entirely) while a
 * deliberate stroke is low-frequency (passes through, just slightly lagged).
 * A tiny dead zone on top catches truly static jitter that a pure low-pass
 * would otherwise let drift by a sub-unit amount on every sample.
 */
export function stabilizeBrushPoint(p: Point, previous: Point | null, amount: number): Point {
  if (!previous) return p;
  const strength = Math.max(0, Math.min(1, amount));
  if (strength === 0) return p;
  const dx = p.x - previous.x;
  const dy = p.y - previous.y;
  const dist = Math.hypot(dx, dy);
  const deadzone = 0.6 * strength;
  if (dist <= deadzone) return previous;
  // strength 0 -> alpha ~1 (no lag, continuous with the early-return above);
  // strength 1 -> alpha 0.18 (heavy smoothing/lag, rounds curves smoothly).
  const alpha = 1 - strength * 0.82;
  return { x: previous.x + dx * alpha, y: previous.y + dy * alpha };
}

export function useBrushTool() {
  const brush = useAppStore((s) => s.brush);
  const brushCap = useAppStore((s) => s.brushCap);
  const gridSize = useAppStore((s) => s.gridSize);
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const commitOutline = useAppStore((s) => s.commitOutline);

  const samplesRef = useRef<StrokeSample[]>([]);
  const stabilizedPtRef = useRef<Point | null>(null);
  // Pixel Brush's live preview is many square contours (one per grid cell),
  // not one nib-shaped contour, so this is always an array — empty for "no
  // preview" rather than null, which keeps the pixel and non-pixel paths
  // uniform for the renderer (see GlyphCanvas.tsx).
  const [previewOutline, setPreviewOutline] = useState<Contour[]>([]);
  const [previewCenterline, setPreviewCenterline] = useState<Contour | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const pixelSnap = brush.type === "pixel" && brush.gridSnap === true;

  // Real stylus pressure drives width when present. Mouse, trackpad, and
  // touch never get a simulated substitute — they always report a
  // constant "full pressure" sample here, so stroke width comes purely
  // from Size (and taper), never from how fast the pointer moved.
  const pressureFor = useCallback((_p: Point, e: PointerLike): number => {
    const real = stylusPressure(e);
    return real >= 0 ? real : 1;
  }, []);

  const buildPreview = useCallback(() => {
    const cl = samplesToCenterline(samplesRef.current, brush);
    if (brush.type === "monoline") {
      return { centerline: centerlineToContour(cl, true), outline: [] as Contour[] };
    }
    // Pixel Brush's grid cell size is baked from the CURRENT canvas grid
    // setting for the live preview too, so what you see while drawing
    // matches exactly what gets committed.
    const settings = pixelSnap ? { ...brush, cellSize: gridSize } : brush;
    return { centerline: null as Contour | null, outline: centerlineToOutlineContours(cl, settings) };
  }, [brush, gridSize, pixelSnap]);

  const pointerDown = useCallback((p: Point, e: PointerLike) => {
    // Pixel brush: snap captured points to the centers of canvas grid cells as you draw, for
    // a genuine blocky/pixel-font-friendly stroke rather than a smoothed curve.
    const snapped = pixelSnap ? snapToGridCell(p, gridSize) : p;
    const stabilized = pixelSnap ? snapped : stabilizeBrushPoint(snapped, null, brush.stabilizer ?? 0);
    samplesRef.current = [{ x: stabilized.x, y: stabilized.y, pressure: pressureFor(snapped, e) }];
    stabilizedPtRef.current = stabilized;
    setIsDrawing(true);
    setPreviewOutline([]);
    setPreviewCenterline(null);
  }, [pressureFor, pixelSnap, gridSize, brush.stabilizer]);

  const pointerMove = useCallback(
    (p: Point, e: PointerLike) => {
      if (!isDrawing) return;
      const snapped = pixelSnap ? snapToGridCell(p, gridSize) : p;
      const stabilized = pixelSnap
        ? snapped
        : stabilizeBrushPoint(snapped, stabilizedPtRef.current, brush.stabilizer ?? 0);
      const samples = samplesRef.current;
      const last = samples[samples.length - 1];
      const minMove = pixelSnap ? gridSize * 0.5 : Math.max(1, brush.spacing * 0.5);
      if (Math.hypot(stabilized.x - last.x, stabilized.y - last.y) < minMove) return;
      samples.push({ x: stabilized.x, y: stabilized.y, pressure: pressureFor(snapped, e) });
      stabilizedPtRef.current = stabilized;
      const preview = buildPreview();
      setPreviewCenterline(preview.centerline);
      setPreviewOutline(preview.outline);
    },
    [isDrawing, brush, buildPreview, pressureFor, gridSize, pixelSnap]
  );

  const pointerUp = useCallback(() => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const centerlineSamples = samplesToCenterline(samplesRef.current, brush);
    const centerline = centerlineToContour(centerlineSamples, !pixelSnap);
    const rawSamples = samplesRef.current.map((s) => ({ ...s }));
    samplesRef.current = [];
    stabilizedPtRef.current = null;
    setPreviewOutline([]);
    setPreviewCenterline(null);
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
  }, [isDrawing, brush, brushCap, glyph, activeChar, commitOutline, gridSize, pixelSnap]);

  const cancel = useCallback(() => {
    samplesRef.current = [];
    stabilizedPtRef.current = null;
    setIsDrawing(false);
    setPreviewOutline([]);
    setPreviewCenterline(null);
  }, []);

  return { pointerDown, pointerMove, pointerUp, cancel, previewOutline, previewCenterline, isDrawing };
}
