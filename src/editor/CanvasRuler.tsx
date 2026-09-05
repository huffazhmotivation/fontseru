/**
 * CanvasRuler – top and left ruler strips overlaid on GlyphCanvas.
 *
 * Rendered as absolutely-positioned <svg> strips inside fm-canvas-frame.
 * The main canvas SVG has CSS margin-top/left = RULER_SIZE so ruler strips
 * sit flush at the frame edge without any gap.
 *
 * Drag from top ruler  → horizontal guide line (dashed cyan)
 * Drag from left ruler → vertical guide line (dashed cyan)
 * Drag guide back into ruler strip → delete it
 * Double-click guide line on canvas → delete it
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore, type RulerGuide } from "@/glyph/store";
import { shortId } from "@/utils/id";

export const RULER_SIZE = 18; // px

// ─── tick interval ───────────────────────────────────────────────────────────
function tickInterval(scale: number): number {
  const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  for (const t of candidates) if (t * scale >= 30) return t;
  return 1000;
}
function majorEvery(interval: number): number {
  if (interval <= 2) return 10;
  if (interval <= 10) return 5;
  return 2;
}

// ─── props ───────────────────────────────────────────────────────────────────
interface Props {
  scale: number;      // screen px per font-unit
  vbX: number;        // viewBox origin X in font-unit space
  vbY: number;        // viewBox origin Y in font-unit space (SVG Y-down)
  vbW: number;        // viewBox width  in font-unit space
  vbH: number;        // viewBox height in font-unit space
  ascender: number;   // font ascender (Y-up)
  /** Bounding rect of the SVG canvas element (not the frame). */
  canvasRect: DOMRect | null;
}

// ─── CanvasRuler ─────────────────────────────────────────────────────────────
export function CanvasRuler({ scale, vbX, vbY, vbW, vbH, ascender, canvasRect }: Props) {
  const addGuide    = useAppStore((s) => s.addRulerGuide);
  const updateGuide = useAppStore((s) => s.updateRulerGuide);
  const removeGuide = useAppStore((s) => s.removeRulerGuide);
  const rulerGuides = useAppStore((s) => s.rulerGuides);

  // ── drag state ─────────────────────────────────────────────────────────────
  type DragState = { id: string; axis: "h" | "v"; rect: DOMRect } | null;
  const [dragging, setDragging] = useState<DragState>(null);
  const draggingRef = useRef<DragState>(null);
  draggingRef.current = dragging;

  // Global pointermove/up during drag (ruler pointer capture is per-element)
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const d = draggingRef.current;
      if (!d) return;
      if (d.axis === "h") {
        const svgY = vbY + (e.clientY - d.rect.top) / scale;
        updateGuide(d.id, ascender - svgY);
      } else {
        updateGuide(d.id, vbX + (e.clientX - d.rect.left) / scale);
      }
    };
    const onUp = (e: PointerEvent) => {
      const d = draggingRef.current;
      if (!d) return;
      setDragging(null);
      draggingRef.current = null;
      // Dragged back into the ruler strip → delete
      if (d.axis === "h" && e.clientY < d.rect.top + RULER_SIZE) {
        removeGuide(d.id);
      } else if (d.axis === "v" && e.clientX < d.rect.left + RULER_SIZE) {
        removeGuide(d.id);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, ascender, scale, updateGuide, removeGuide, vbX, vbY]);

  // ── drag start: top ruler (horizontal guide) ───────────────────────────────
  const onTopDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!canvasRect) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const id = shortId("rg");
      const svgY = vbY + (e.clientY - canvasRect.top) / scale;
      addGuide({ id, axis: "h", position: ascender - svgY });
      const d: DragState = { id, axis: "h", rect: canvasRect };
      setDragging(d);
      draggingRef.current = d;
    },
    [addGuide, ascender, canvasRect, scale, vbY]
  );

  // ── drag start: left ruler (vertical guide) ────────────────────────────────
  const onLeftDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!canvasRect) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const id = shortId("rg");
      addGuide({ id, axis: "v", position: vbX + (e.clientX - canvasRect.left) / scale });
      const d: DragState = { id, axis: "v", rect: canvasRect };
      setDragging(d);
      draggingRef.current = d;
    },
    [addGuide, canvasRect, scale, vbX]
  );

  // ── ticks ─────────────────────────────────────────────────────────────────
  const interval = tickInterval(scale);
  const majorN   = majorEvery(interval);
  const svgW = canvasRect?.width  ?? 0;
  const svgH = canvasRect?.height ?? 0;

  // Top ruler ticks (X axis, font-unit)
  const firstX = Math.ceil(vbX / interval) * interval;
  const topTicks: { x: number; major: boolean }[] = [];
  for (let x = firstX; x < vbX + vbW; x += interval) {
    const px = (x - vbX) * scale;
    if (px < 0 || px > svgW) continue;
    topTicks.push({ x, major: Math.round(x / interval) % majorN === 0 });
  }

  // Left ruler ticks (Y axis, font-unit Y-up)
  const firstFontY = Math.floor((ascender - vbY) / interval) * interval;
  const leftTicks: { fontY: number; py: number; major: boolean }[] = [];
  for (let fontY = firstFontY; ; fontY -= interval) {
    const svgY = ascender - fontY;
    const py = (svgY - vbY) * scale;
    if (py > svgH + 40) break;
    if (py >= -40) leftTicks.push({ fontY, py, major: Math.round(fontY / interval) % majorN === 0 });
    if (leftTicks.length > 200) break;
  }

  return (
    <>
      {/* ── corner ── */}
      <div
        className="fm-ruler-corner"
        style={{ position: "absolute", top: 0, left: 0, width: RULER_SIZE, height: RULER_SIZE, zIndex: 10 }}
      />

      {/* ── top ruler ── */}
      <svg
        className="fm-ruler fm-ruler-top"
        style={{
          position: "absolute",
          top: 0,
          left: RULER_SIZE,
          width: `calc(100% - ${RULER_SIZE}px)`,
          height: RULER_SIZE,
          cursor: "s-resize",
          zIndex: 9,
          touchAction: "none",
        }}
        onPointerDown={onTopDown}
      >
        <rect width="100%" height="100%" className="fm-ruler-bg" />
        <line x1={0} y1={RULER_SIZE - 1} x2={svgW} y2={RULER_SIZE - 1} className="fm-ruler-border" />
        {topTicks.map(({ x, major }) => {
          const px = (x - vbX) * scale;
          const tickH = major ? 9 : 5;
          return (
            <g key={x}>
              <line x1={px} y1={RULER_SIZE - tickH} x2={px} y2={RULER_SIZE} className={major ? "fm-ruler-tick-major" : "fm-ruler-tick"} />
              {major && (
                <text x={px + 3} y={RULER_SIZE - 9} className="fm-ruler-label">{Math.round(x)}</text>
              )}
            </g>
          );
        })}
        {/* vertical guide markers */}
        {rulerGuides.filter((g) => g.axis === "v").map((g) => {
          const px = (g.position - vbX) * scale;
          if (px < 0 || px > svgW) return null;
          return <line key={g.id} x1={px} y1={0} x2={px} y2={RULER_SIZE} className="fm-ruler-guide-marker" />;
        })}
      </svg>

      {/* ── left ruler ── */}
      <svg
        className="fm-ruler fm-ruler-left"
        style={{
          position: "absolute",
          top: RULER_SIZE,
          left: 0,
          width: RULER_SIZE,
          height: `calc(100% - ${RULER_SIZE}px)`,
          cursor: "e-resize",
          zIndex: 9,
          touchAction: "none",
        }}
        onPointerDown={onLeftDown}
      >
        <rect width="100%" height="100%" className="fm-ruler-bg" />
        <line x1={RULER_SIZE - 1} y1={0} x2={RULER_SIZE - 1} y2={svgH} className="fm-ruler-border" />
        {leftTicks.map(({ fontY, py, major }) => {
          const tickW = major ? 9 : 5;
          return (
            <g key={fontY}>
              <line x1={RULER_SIZE - tickW} y1={py} x2={RULER_SIZE} y2={py} className={major ? "fm-ruler-tick-major" : "fm-ruler-tick"} />
              {major && (
                <text
                  x={RULER_SIZE - 2}
                  y={py - 2}
                  transform={`rotate(-90, ${RULER_SIZE - 2}, ${py - 2})`}
                  textAnchor="end"
                  className="fm-ruler-label"
                >
                  {Math.round(fontY)}
                </text>
              )}
            </g>
          );
        })}
        {/* horizontal guide markers */}
        {rulerGuides.filter((g) => g.axis === "h").map((g) => {
          const py = (ascender - g.position - vbY) * scale;
          if (py < 0 || py > svgH) return null;
          return <line key={g.id} x1={0} y1={py} x2={RULER_SIZE} y2={py} className="fm-ruler-guide-marker" />;
        })}
      </svg>
    </>
  );
}

// ─── RulerGuideLines ─────────────────────────────────────────────────────────
/** Rendered inside the canvas SVG — draws the dashed guide lines. */
export function RulerGuideLines({
  rulerGuides, sc, vbX, vbY, vbW, vbH, ascender, onRemove,
}: {
  rulerGuides: RulerGuide[];
  sc: number;
  vbX: number; vbY: number; vbW: number; vbH: number;
  ascender: number;
  onRemove: (id: string) => void;
}) {
  return (
    <>
      {rulerGuides.map((g) => {
        if (g.axis === "h") {
          const y = ascender - g.position;
          if (y < vbY - 50 / sc || y > vbY + vbH + 50 / sc) return null;
          return (
            <g key={g.id}>
              <line x1={vbX} y1={y} x2={vbX + vbW} y2={y} className="ruler-guide-line" pointerEvents="none" />
              {/* Wide invisible hit area for double-click delete */}
              <line
                x1={vbX} y1={y} x2={vbX + vbW} y2={y}
                stroke="transparent" strokeWidth={12 / sc}
                style={{ cursor: "pointer" }}
                onDoubleClick={() => onRemove(g.id)}
              />
            </g>
          );
        } else {
          const x = g.position;
          if (x < vbX - 50 / sc || x > vbX + vbW + 50 / sc) return null;
          return (
            <g key={g.id}>
              <line x1={x} y1={vbY} x2={x} y2={vbY + vbH} className="ruler-guide-line" pointerEvents="none" />
              <line
                x1={x} y1={vbY} x2={x} y2={vbY + vbH}
                stroke="transparent" strokeWidth={12 / sc}
                style={{ cursor: "pointer" }}
                onDoubleClick={() => onRemove(g.id)}
              />
            </g>
          );
        }
      })}
    </>
  );
}
