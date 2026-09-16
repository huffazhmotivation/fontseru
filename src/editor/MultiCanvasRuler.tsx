import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/glyph/store";
import { shortId } from "@/utils/id";

export const MULTI_RULER_SIZE = 18; // px

/**
 * Top + left ruler strips for the MULTI GLYPH EDIT CANVAS.
 *
 * The multi canvas is one continuous plane holding many em boxes, so a
 * ruler measured from the plane's own origin would print meaningless
 * numbers ("x = 4380") in every cell but the first. Instead both strips
 * read out FONT UNITS RELATIVE TO THE ACTIVE CELL — x = 0 at that glyph's
 * origin, y = 0 at its baseline — which is the same pair of numbers the
 * single-glyph editor's rulers show for the same glyph.
 *
 * Guides dragged off a strip are stored in `rulerGuides` in those same
 * font units, and the canvas draws them inside EVERY cell. So one drag
 * gives you the same guide in every glyph box — an x-height check line,
 * say, lined up across the whole alphabet at once.
 *
 *   drag from top ruler  → horizontal guide (a font Y position)
 *   drag from left ruler → vertical guide   (a font X position)
 *   release back inside the strip → discard it
 *   double-click a guide on the canvas → delete it
 */

function tickInterval(scale: number): number {
  const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  for (const t of candidates) if (t * scale >= 30) return t;
  return 5000;
}
function majorEvery(interval: number): number {
  if (interval <= 2) return 10;
  if (interval <= 10) return 5;
  return 2;
}

interface Props {
  /** Screen px per font unit. */
  scale: number;
  /** Viewport in world (font-unit) space. */
  vbX: number;
  vbY: number;
  ascender: number;
  /** World-space origin of the active cell — the point the ruler counts
   *  from, so its numbers match that glyph's own coordinates. */
  originX: number;
  originY: number;
  canvasRect: DOMRect | null;
}

export function MultiCanvasRuler({
  scale,
  vbX,
  vbY,
  ascender,
  originX,
  originY,
  canvasRect,
}: Props) {
  const addGuide = useAppStore((s) => s.addRulerGuide);
  const updateGuide = useAppStore((s) => s.updateRulerGuide);
  const removeGuide = useAppStore((s) => s.removeRulerGuide);
  const rulerGuides = useAppStore((s) => s.rulerGuides);

  type DragState = { id: string; axis: "h" | "v"; rect: DOMRect } | null;
  const [dragging, setDragging] = useState<DragState>(null);
  const draggingRef = useRef<DragState>(null);
  draggingRef.current = dragging;

  /** Screen → font units of the active cell. */
  const toFontX = useCallback(
    (clientX: number, rect: DOMRect) => vbX + (clientX - rect.left) / scale - originX,
    [vbX, scale, originX]
  );
  const toFontY = useCallback(
    (clientY: number, rect: DOMRect) => ascender - (vbY + (clientY - rect.top) / scale - originY),
    [vbY, scale, ascender, originY]
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const d = draggingRef.current;
      if (!d) return;
      updateGuide(d.id, d.axis === "h" ? toFontY(e.clientY, d.rect) : toFontX(e.clientX, d.rect));
    };
    const onUp = (e: PointerEvent) => {
      const d = draggingRef.current;
      if (!d) return;
      setDragging(null);
      draggingRef.current = null;
      // Released back over the strip it came from → the user changed
      // their mind; drop the guide instead of leaving one pinned to the
      // canvas edge.
      if (d.axis === "h" && e.clientY < d.rect.top + MULTI_RULER_SIZE) removeGuide(d.id);
      else if (d.axis === "v" && e.clientX < d.rect.left + MULTI_RULER_SIZE) removeGuide(d.id);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, updateGuide, removeGuide, toFontX, toFontY]);

  const onTopDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!canvasRect) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const id = shortId("rg");
      addGuide({ id, axis: "h", position: toFontY(e.clientY, canvasRect) });
      const d: DragState = { id, axis: "h", rect: canvasRect };
      setDragging(d);
      draggingRef.current = d;
    },
    [addGuide, canvasRect, toFontY]
  );

  const onLeftDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!canvasRect) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const id = shortId("rg");
      addGuide({ id, axis: "v", position: toFontX(e.clientX, canvasRect) });
      const d: DragState = { id, axis: "v", rect: canvasRect };
      setDragging(d);
      draggingRef.current = d;
    },
    [addGuide, canvasRect, toFontX]
  );

  const interval = tickInterval(scale);
  const majorN = majorEvery(interval);
  const svgW = canvasRect?.width ?? 0;
  const svgH = canvasRect?.height ?? 0;

  // Ticks are laid out in the active cell's font units, then mapped back
  // to screen px through the shared world transform.
  const fontXAt = (px: number) => vbX + px / scale - originX;
  const pxForFontX = (fx: number) => (fx + originX - vbX) * scale;
  const pxForFontY = (fy: number) => (ascender - fy + originY - vbY) * scale;

  const firstX = Math.ceil(fontXAt(0) / interval) * interval;
  const topTicks: { fontX: number; px: number; major: boolean }[] = [];
  for (let fx = firstX; ; fx += interval) {
    const px = pxForFontX(fx);
    if (px > svgW) break;
    if (px >= 0) topTicks.push({ fontX: fx, px, major: Math.round(fx / interval) % majorN === 0 });
    if (topTicks.length > 400) break;
  }

  const topFontY = ascender - (vbY - originY);
  const firstY = Math.floor(topFontY / interval) * interval;
  const leftTicks: { fontY: number; py: number; major: boolean }[] = [];
  for (let fy = firstY; ; fy -= interval) {
    const py = pxForFontY(fy);
    if (py > svgH) break;
    if (py >= 0) leftTicks.push({ fontY: fy, py, major: Math.round(fy / interval) % majorN === 0 });
    if (leftTicks.length > 400) break;
  }

  return (
    <>
      <div
        className="fm-ruler-corner"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: MULTI_RULER_SIZE,
          height: MULTI_RULER_SIZE,
          zIndex: 10,
        }}
      />

      <svg
        className="fm-ruler fm-ruler-top"
        style={{
          position: "absolute",
          top: 0,
          left: MULTI_RULER_SIZE,
          width: `calc(100% - ${MULTI_RULER_SIZE}px)`,
          height: MULTI_RULER_SIZE,
          cursor: "s-resize",
          zIndex: 9,
          touchAction: "none",
        }}
        onPointerDown={onTopDown}
      >
        <rect width="100%" height="100%" className="fm-ruler-bg" />
        <line x1={0} y1={MULTI_RULER_SIZE - 1} x2={svgW} y2={MULTI_RULER_SIZE - 1} className="fm-ruler-border" />
        {topTicks.map(({ fontX, px, major }) => (
          <g key={fontX}>
            <line
              x1={px}
              y1={MULTI_RULER_SIZE - (major ? 9 : 5)}
              x2={px}
              y2={MULTI_RULER_SIZE}
              className={major ? "fm-ruler-tick-major" : "fm-ruler-tick"}
            />
            {major && (
              <text x={px + 3} y={MULTI_RULER_SIZE - 9} className="fm-ruler-label">
                {Math.round(fontX)}
              </text>
            )}
          </g>
        ))}
        {rulerGuides
          .filter((g) => g.axis === "v")
          .map((g) => {
            const px = pxForFontX(g.position);
            if (px < 0 || px > svgW) return null;
            return <line key={g.id} x1={px} y1={0} x2={px} y2={MULTI_RULER_SIZE} className="fm-ruler-guide-marker" />;
          })}
      </svg>

      <svg
        className="fm-ruler fm-ruler-left"
        style={{
          position: "absolute",
          top: MULTI_RULER_SIZE,
          left: 0,
          width: MULTI_RULER_SIZE,
          height: `calc(100% - ${MULTI_RULER_SIZE}px)`,
          cursor: "e-resize",
          zIndex: 9,
          touchAction: "none",
        }}
        onPointerDown={onLeftDown}
      >
        <rect width="100%" height="100%" className="fm-ruler-bg" />
        <line x1={MULTI_RULER_SIZE - 1} y1={0} x2={MULTI_RULER_SIZE - 1} y2={svgH} className="fm-ruler-border" />
        {leftTicks.map(({ fontY, py, major }) => (
          <g key={fontY}>
            <line
              x1={MULTI_RULER_SIZE - (major ? 9 : 5)}
              y1={py}
              x2={MULTI_RULER_SIZE}
              y2={py}
              className={major ? "fm-ruler-tick-major" : "fm-ruler-tick"}
            />
            {major && (
              <text
                x={MULTI_RULER_SIZE - 2}
                y={py - 2}
                transform={`rotate(-90, ${MULTI_RULER_SIZE - 2}, ${py - 2})`}
                textAnchor="end"
                className="fm-ruler-label"
              >
                {Math.round(fontY)}
              </text>
            )}
          </g>
        ))}
        {rulerGuides
          .filter((g) => g.axis === "h")
          .map((g) => {
            const py = pxForFontY(g.position);
            if (py < 0 || py > svgH) return null;
            return <line key={g.id} x1={0} y1={py} x2={MULTI_RULER_SIZE} y2={py} className="fm-ruler-guide-marker" />;
          })}
      </svg>
    </>
  );
}
