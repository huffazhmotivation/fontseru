/**
 * CanvasRuler – top (horizontal) and left (vertical) ruler strips for GlyphCanvas.
 *
 * Coordinate mapping mirrors GlyphCanvas:
 *   SVG viewBox X = font-unit X  (Y-down, but ruler shows Y-up font values)
 *   SVG viewBox Y = ascender - fontY  (Y-down SVG, Y-up font)
 *
 * Dragging from the top ruler creates a horizontal guide line (constant Y).
 * Dragging from the left ruler creates a vertical guide line (constant X).
 *
 * Guide lines are dashed and use a high-contrast cyan accent so they stand
 * out from the metric guides (purple/blue/green/orange) already on canvas.
 * The color is defined via the CSS variable --ruler-guide so both themes
 * get the right value automatically.
 */

import { useCallback, useRef, useState } from "react";
import { useAppStore, type RulerGuide } from "@/glyph/store";
import { shortId } from "@/utils/id";

const RULER_SIZE = 18; // px – width of left ruler / height of top ruler

interface Props {
  /** Current scale: screen px per font unit (sc from GlyphCanvas). */
  scale: number;
  /** Viewbox origin in font-unit space (vbX, vbY from GlyphCanvas). */
  vbX: number;
  vbY: number;
  /** Viewbox size in font-unit space. */
  vbW: number;
  vbH: number;
  /** Font ascender (Y-up). Used to convert SVG-Y ↔ font-Y. */
  ascender: number;
  /** Ref to the SVG element — used to read getBoundingClientRect. */
  svgRef: React.RefObject<SVGSVGElement | null>;
}

// ─── tick helpers ───────────────────────────────────────────────────────────

/** Choose a readable tick interval given the current scale (px/unit). */
function tickInterval(scale: number): number {
  const targets = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const minPx = 28; // minimum px between ticks for readability
  for (const t of targets) if (t * scale >= minPx) return t;
  return 1000;
}

function majorEvery(interval: number): number {
  if (interval <= 2) return 10;
  if (interval <= 10) return 5;
  return 2;
}

// ─── component ──────────────────────────────────────────────────────────────

export function CanvasRuler({ scale, vbX, vbY, vbW, vbH, ascender, svgRef }: Props) {
  const addGuide = useAppStore((s) => s.addRulerGuide);
  const updateGuide = useAppStore((s) => s.updateRulerGuide);
  const removeGuide = useAppStore((s) => s.removeRulerGuide);
  const rulerGuides = useAppStore((s) => s.rulerGuides);

  // Live drag state for a guide being created/moved from the ruler
  const [dragging, setDragging] = useState<{
    id: string;
    axis: "h" | "v";
    // screen px positions of the canvas SVG rect, cached on drag start
    rect: DOMRect;
  } | null>(null);

  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;

  // ── start drag from top ruler → horizontal guide ──────────────────────────
  const onTopRulerPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      e.preventDefault();
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const id = shortId();
      // Initial font-unit Y: convert clientY to SVG-Y, then to font-Y
      const svgY = vbY + (e.clientY - rect.top) / scale;
      const fontY = ascender - svgY;
      addGuide({ id, axis: "h", position: fontY });
      (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
      const d = { id, axis: "h" as const, rect };
      setDragging(d);
      draggingRef.current = d;
    },
    [addGuide, ascender, scale, svgRef, vbY]
  );

  // ── start drag from left ruler → vertical guide ───────────────────────────
  const onLeftRulerPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      e.preventDefault();
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const id = shortId();
      const fontX = vbX + (e.clientX - rect.left) / scale;
      addGuide({ id, axis: "v", position: fontX });
      (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
      const d = { id, axis: "v" as const, rect };
      setDragging(d);
      draggingRef.current = d;
    },
    [addGuide, scale, svgRef, vbX]
  );

  // ── move (common for both axes) ───────────────────────────────────────────
  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const d = draggingRef.current;
      if (!d) return;
      if (d.axis === "h") {
        const svgY = vbY + (e.clientY - d.rect.top) / scale;
        updateGuide(d.id, ascender - svgY);
      } else {
        updateGuide(d.id, vbX + (e.clientX - d.rect.left) / scale);
      }
    },
    [ascender, scale, updateGuide, vbX, vbY]
  );

  // ── release ───────────────────────────────────────────────────────────────
  const onPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const d = draggingRef.current;
      if (!d) return;
      setDragging(null);
      draggingRef.current = null;
      // If the guide is dragged back into the ruler strip → delete it
      if (d.axis === "h" && e.clientY < d.rect.top + RULER_SIZE) {
        removeGuide(d.id);
      } else if (d.axis === "v" && e.clientX < d.rect.left + RULER_SIZE) {
        removeGuide(d.id);
      }
    },
    [removeGuide]
  );

  const interval = tickInterval(scale);
  const majorN = majorEvery(interval);

  // ── top ruler ticks ───────────────────────────────────────────────────────
  const firstTickX = Math.ceil(vbX / interval) * interval;
  const topTicks: { x: number; major: boolean }[] = [];
  for (let x = firstTickX; x < vbX + vbW; x += interval) {
    topTicks.push({ x, major: Math.round(x / interval) % majorN === 0 });
  }

  // ── left ruler ticks ──────────────────────────────────────────────────────
  const firstTickY = Math.floor((vbY + vbH) / interval) * interval; // font Y is Y-up
  const leftTicks: { fontY: number; svgY: number; major: boolean }[] = [];
  for (let fontY = firstTickY; fontY >= vbY - vbH; fontY -= interval) {
    const svgY = ascender - fontY;
    if (svgY < vbY || svgY > vbY + vbH) continue;
    leftTicks.push({ fontY, svgY, major: Math.round(fontY / interval) % majorN === 0 });
  }

  // Layout: rulers live OUTSIDE the SVG canvas, as two thin HTML/SVG strips
  // positioned with CSS. We render them as SVG elements for crisp sub-pixel
  // rendering and easy coordinate math.

  return (
    <>
      {/* ── top ruler ── */}
      <svg
        className="fm-ruler fm-ruler-top"
        style={{ height: RULER_SIZE, cursor: "s-resize" }}
        onPointerDown={onTopRulerPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <rect width="100%" height="100%" className="fm-ruler-bg" />
        {topTicks.map(({ x, major }) => {
          // Convert font-X to pixel position within the ruler strip
          const px = (x - vbX) * scale;
          const tickH = major ? 8 : 5;
          return (
            <g key={x}>
              <line
                x1={px} y1={RULER_SIZE - tickH} x2={px} y2={RULER_SIZE}
                className={major ? "fm-ruler-tick-major" : "fm-ruler-tick"}
              />
              {major && (
                <text x={px + 3} y={RULER_SIZE - 10} className="fm-ruler-label">
                  {Math.round(x)}
                </text>
              )}
            </g>
          );
        })}
        {/* Guide position markers on top ruler */}
        {rulerGuides.filter((g) => g.axis === "v").map((g) => {
          const px = (g.position - vbX) * scale;
          return (
            <line key={g.id} x1={px} y1={0} x2={px} y2={RULER_SIZE}
              className="fm-ruler-guide-marker" />
          );
        })}
      </svg>

      {/* ── left ruler ── */}
      <svg
        className="fm-ruler fm-ruler-left"
        style={{ width: RULER_SIZE, cursor: "e-resize" }}
        onPointerDown={onLeftRulerPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <rect width="100%" height="100%" className="fm-ruler-bg" />
        {leftTicks.map(({ fontY, svgY, major }) => {
          // Convert SVG-Y (font-unit, Y-down) to pixel within ruler
          const py = (svgY - vbY) * scale;
          const tickW = major ? 8 : 5;
          return (
            <g key={fontY}>
              <line
                x1={RULER_SIZE - tickW} y1={py} x2={RULER_SIZE} y2={py}
                className={major ? "fm-ruler-tick-major" : "fm-ruler-tick"}
              />
              {major && (
                <text
                  x={RULER_SIZE - 10} y={py - 2}
                  transform={`rotate(-90, ${RULER_SIZE - 10}, ${py - 2})`}
                  className="fm-ruler-label"
                >
                  {Math.round(fontY)}
                </text>
              )}
            </g>
          );
        })}
        {/* Guide position markers on left ruler */}
        {rulerGuides.filter((g) => g.axis === "h").map((g) => {
          const py = (ascender - g.position - vbY) * scale;
          return (
            <line key={g.id} x1={0} y1={py} x2={RULER_SIZE} y2={py}
              className="fm-ruler-guide-marker" />
          );
        })}
      </svg>

      {/* ── corner square where rulers meet ── */}
      <div className="fm-ruler-corner" style={{ width: RULER_SIZE, height: RULER_SIZE }} />
    </>
  );
}

/** Overlay that renders ruler guide lines on the canvas SVG (called inside SVG). */
export function RulerGuideLines({
  rulerGuides,
  sc,
  vbX, vbY, vbW, vbH,
  ascender,
  onRemove,
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
          if (y < vbY || y > vbY + vbH) return null;
          return (
            <g key={g.id}>
              <line
                x1={vbX} y1={y} x2={vbX + vbW} y2={y}
                className="ruler-guide-line"
                pointerEvents="none"
              />
              {/* invisible wider hit line for double-click to delete */}
              <line
                x1={vbX} y1={y} x2={vbX + vbW} y2={y}
                stroke="transparent" strokeWidth={10 / sc}
                style={{ cursor: "pointer" }}
                onDoubleClick={() => onRemove(g.id)}
              />
            </g>
          );
        } else {
          const x = g.position;
          if (x < vbX || x > vbX + vbW) return null;
          return (
            <g key={g.id}>
              <line
                x1={x} y1={vbY} x2={x} y2={vbY + vbH}
                className="ruler-guide-line"
                pointerEvents="none"
              />
              <line
                x1={x} y1={vbY} x2={x} y2={vbY + vbH}
                stroke="transparent" strokeWidth={10 / sc}
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
