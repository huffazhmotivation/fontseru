import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useAppStore } from "@/glyph/store";
import { hasOutline, type Glyph } from "@/types/glyph";
import { clampOverviewZoom } from "@/types/glyphView";
import { getGlyphPaths } from "./glyphPaths";
import { filterGlyphChars } from "./glyphFilter";
import {
  cellRect,
  clampScrollY,
  computeOverviewLayout,
  glyphTileTransform,
  indexAtPoint,
  indicesInRect,
  tileRect,
  visibleIndexRange,
  type OverviewLayout,
  type TileRect,
} from "./overviewLayout";

/**
 * MULTI GLYPH CANVAS (Glyph Overview)
 * ----------------------------------
 * A second canvas surface that renders MANY glyphs at once in a wrapping
 * grid, alongside — never replacing — the existing single-glyph editor.
 *
 * Architectural notes (why it looks the way it does):
 *
 *  • NO SECOND ENGINE. Outlines are drawn with `getGlyphPaths`, the same
 *    cached path builder GlyphRun / the Test Lab specimen already use.
 *    Brush envelopes, outline-brush merging and stroke centerlines
 *    therefore render identically here and in Single Mode, and the
 *    WeakMap cache inside glyphPaths means a glyph's geometry is computed
 *    at most once no matter how many surfaces show it.
 *
 *  • NO DUPLICATED DATA. This component holds no glyph state. It reads
 *    `glyphs` (the active family style's map) straight from the store and
 *    works with character KEYS into that map. Drawing a glyph in Single
 *    Mode updates one entry in that map and this grid re-renders that one
 *    tile — everything else keeps its cached paths.
 *
 *  • VIRTUAL RENDERING. Only the tiles whose rows intersect the viewport
 *    (plus a small overscan) are turned into SVG elements — see
 *    `visibleIndexRange` in ./overviewLayout. A 5,000-glyph font paints
 *    the same ~40 tiles a 40-glyph font does.
 *
 *  • ITS OWN VIEW STATE. `overviewZoom` / `overviewScroll` are separate
 *    store fields from the editor's `zoom` / `pan`, so switching modes
 *    never disturbs where either surface was left.
 *
 *  • SELECTION REUSE. Multi-selection writes to `selectedGlyphChars`, the
 *    multi-glyph selection list GlyphNav and the batch Right Panel
 *    actions already read — so selecting in the overview immediately
 *    powers the existing batch tools instead of inventing a parallel
 *    selection model. Node/object selection (the single-glyph editor's
 *    own selection) is cleared on entering this mode and is never touched
 *    from here, so the two can't conflict.
 */

const OVERSCAN_ROWS = 2;

interface TileProps {
  glyph: Glyph;
  rect: TileRect;
  labelPx: number;
  totalHeight: number;
  ascender: number;
  selected: boolean;
  active: boolean;
}

function GlyphTileView({
  glyph,
  rect,
  labelPx,
  totalHeight,
  ascender,
  selected,
  active,
}: TileProps) {
  const drawn = hasOutline(glyph);
  const { scale, translateX, translateY } = glyphTileTransform(
    rect,
    glyph.advanceWidth,
    totalHeight
  );
  const label = glyph.char === " " ? "space" : glyph.name ?? glyph.char;
  const labelSize = Math.max(8, Math.min(13, labelPx * 0.72));
  // Baseline of the tile's own em box, so every glyph in the grid sits on
  // one visually consistent line — the fastest way to spot a glyph that
  // is drawn off its baseline.
  const baselineY = translateY + ascender * scale;

  return (
    <g
      className={`fm-ov-tile${selected ? " selected" : ""}${active ? " active" : ""}${drawn ? " drawn" : " empty"}`}
      data-char={glyph.char}
    >
      <rect
        className="fm-ov-tile-box"
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        rx={Math.min(8, rect.w * 0.07)}
      />
      <line
        className="fm-ov-tile-baseline"
        x1={rect.x + 2}
        y1={baselineY}
        x2={rect.x + rect.w - 2}
        y2={baselineY}
      />
      {drawn ? (
        <g transform={`translate(${translateX} ${translateY}) scale(${scale})`}>
          {getGlyphPaths(glyph, ascender).map((entry) =>
            entry.kind === "stroke" ? (
              <path
                key={entry.id}
                className="fm-ov-ink"
                d={entry.d}
                fill="none"
                strokeWidth={entry.strokeWidth}
                strokeLinecap={entry.cap as "round" | "butt" | "square"}
                strokeLinejoin={entry.join as "round" | "miter" | "bevel"}
              />
            ) : (
              <path key={entry.id} className="fm-ov-ink-fill" d={entry.d} fillRule="nonzero" />
            )
          )}
        </g>
      ) : (
        <text
          className="fm-ov-placeholder"
          x={rect.x + rect.w / 2}
          y={rect.y + rect.h * 0.66}
          textAnchor="middle"
          fontSize={rect.h * 0.44}
        >
          {glyph.char === " " ? "␣" : glyph.char}
        </text>
      )}
      <text
        className="fm-ov-tile-label"
        x={rect.x + rect.w / 2}
        y={rect.y + rect.h + labelPx * 0.78}
        textAnchor="middle"
        fontSize={labelSize}
      >
        {label}
      </text>
      {drawn && (
        <circle
          className="fm-ov-done-dot"
          cx={rect.x + rect.w - Math.max(6, rect.w * 0.07)}
          cy={rect.y + Math.max(6, rect.w * 0.07)}
          r={Math.max(2.5, rect.w * 0.022)}
        />
      )}
    </g>
  );
}

// Tiles are the hot path: a scroll or a marquee drag re-renders the grid
// container many times a second while almost no tile's own props change.
const GlyphTile = memo(GlyphTileView);

type DragState =
  | { kind: "pan"; startClientX: number; startClientY: number; startScrollY: number }
  | { kind: "marquee"; originX: number; originY: number; x: number; y: number; additive: boolean };

export function GlyphOverviewCanvas() {
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const glyphs = useAppStore((s) => s.glyphs);
  const activeChar = useAppStore((s) => s.activeChar);
  const tool = useAppStore((s) => s.tool);
  const ascender = useAppStore((s) => s.metrics.ascender);
  const descender = useAppStore((s) => s.metrics.descender);
  const filter = useAppStore((s) => s.overviewFilter);
  const query = useAppStore((s) => s.overviewQuery);
  const zoom = useAppStore((s) => s.overviewZoom);
  const spacing = useAppStore((s) => s.overviewSpacing);
  const scroll = useAppStore((s) => s.overviewScroll);
  const setOverviewScroll = useAppStore((s) => s.setOverviewScroll);
  const selectedGlyphChars = useAppStore((s) => s.selectedGlyphChars);
  const setGlyphSelection = useAppStore((s) => s.setGlyphSelection);
  const addGlyphsToSelection = useAppStore((s) => s.addGlyphsToSelection);
  const toggleGlyphSelected = useAppStore((s) => s.toggleGlyphSelected);
  const setActiveChar = useAppStore((s) => s.setActiveChar);
  const openGlyphInSingleMode = useAppStore((s) => s.openGlyphInSingleMode);

  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const spacePanRef = useRef(false);
  const movedRef = useRef(false);

  const totalHeight = Math.max(1, ascender - descender);

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const update = () => setViewSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chars = useMemo(
    () => filterGlyphChars(glyphs, filter, selectedGlyphChars, query),
    // `selectedGlyphChars` only participates in the "custom" filter, but
    // listing it unconditionally keeps the memo honest and is cheap — the
    // array identity only changes when the selection actually changes.
    [glyphs, filter, selectedGlyphChars, query]
  );

  const layout: OverviewLayout = useMemo(
    () => computeOverviewLayout({ count: chars.length, viewW: viewSize.w, zoom, spacing }),
    [chars.length, viewSize.w, zoom, spacing]
  );

  // Keep the stored scroll offset legal when the row count, zoom, spacing
  // or the canvas size changes underneath it.
  const scrollY = clampScrollY(layout, viewSize.h, scroll.y);
  useEffect(() => {
    if (scrollY !== scroll.y) setOverviewScroll({ x: 0, y: scrollY });
  }, [scrollY, scroll.y, setOverviewScroll]);

  const selectedSet = useMemo(() => new Set(selectedGlyphChars), [selectedGlyphChars]);
  const range = useMemo(
    () => visibleIndexRange(layout, scrollY, viewSize.h, OVERSCAN_ROWS),
    [layout, scrollY, viewSize.h]
  );

  // ------------------------------------------------------------- input
  const toContentPoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return { x: clientX - rect.left, y: clientY - rect.top + scrollY };
    },
    [scrollY]
  );

  const scrollBy = useCallback(
    (dy: number) => {
      const state = useAppStore.getState();
      const next = clampScrollY(layout, viewSize.h, state.overviewScroll.y + dy);
      if (next !== state.overviewScroll.y) state.setOverviewScroll({ x: 0, y: next });
    },
    [layout, viewSize.h]
  );

  // Native non-passive wheel so the page never scrolls behind the canvas.
  // Plain wheel scrolls the grid; Ctrl/Cmd (or trackpad pinch) zooms while
  // keeping the content under the cursor roughly pinned.
  const wheelStateRef = useRef({ layout, viewH: viewSize.h });
  wheelStateRef.current = { layout, viewH: viewSize.h };
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const store = useAppStore.getState();
      const { layout: lay, viewH } = wheelStateRef.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const cursorY = e.clientY - rect.top;
        const oldZoom = store.overviewZoom;
        const newZoom = clampOverviewZoom(oldZoom * Math.exp(-e.deltaY * 0.0022));
        if (newZoom === oldZoom) return;
        const ratio = newZoom / oldZoom;
        const nextScroll = (store.overviewScroll.y + cursorY) * ratio - cursorY;
        store.setOverviewZoom(newZoom);
        // Clamp against the PRE-zoom layout; the effect above re-clamps
        // against the new one on the next render, which is enough to stop
        // the view ever landing past the end of the content.
        store.setOverviewScroll({ x: 0, y: clampScrollY(lay, viewH, nextScroll) });
        return;
      }
      const dy = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      const next = clampScrollY(lay, viewH, store.overviewScroll.y + dy);
      if (next !== store.overviewScroll.y) store.setOverviewScroll({ x: 0, y: next });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Space-to-pan, matching the single-glyph canvas's own convention.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") spacePanRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spacePanRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      e.preventDefault();
      (e.currentTarget as SVGSVGElement).setPointerCapture?.(e.pointerId);
      movedRef.current = false;

      const panning = tool === "hand" || spacePanRef.current || e.button === 1;
      if (panning) {
        setDrag({
          kind: "pan",
          startClientX: e.clientX,
          startClientY: e.clientY,
          startScrollY: scrollY,
        });
        return;
      }
      if (e.button !== 0) return;

      const p = toContentPoint(e.clientX, e.clientY);
      if (!p) return;
      const index = indexAtPoint(layout, p.x, p.y);
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;

      if (index >= 0) {
        const char = chars[index];
        if (additive) {
          // Shift/Cmd-click toggles one glyph in or out of the selection.
          toggleGlyphSelected(char, true);
        } else {
          setGlyphSelection([char]);
          setActiveChar(char);
        }
        return;
      }
      // Empty space: start a drag rectangle. A plain drag replaces the
      // selection; Shift-drag adds to it.
      if (!additive) setGlyphSelection([]);
      setDrag({ kind: "marquee", originX: p.x, originY: p.y, x: p.x, y: p.y, additive });
    },
    [tool, scrollY, toContentPoint, layout, chars, toggleGlyphSelected, setGlyphSelection, setActiveChar]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const current = dragRef.current;
      if (!current) return;
      movedRef.current = true;
      if (current.kind === "pan") {
        const state = useAppStore.getState();
        const next = clampScrollY(
          layout,
          viewSize.h,
          current.startScrollY - (e.clientY - current.startClientY)
        );
        if (next !== state.overviewScroll.y) state.setOverviewScroll({ x: 0, y: next });
        return;
      }
      const p = toContentPoint(e.clientX, e.clientY);
      if (!p) return;
      setDrag({ ...current, x: p.x, y: p.y });
      // Auto-scroll when the marquee is dragged past an edge.
      const rect = svgRef.current?.getBoundingClientRect();
      if (rect) {
        const localY = e.clientY - rect.top;
        if (localY < 24) scrollBy(-14);
        else if (localY > rect.height - 24) scrollBy(14);
      }
    },
    [layout, viewSize.h, toContentPoint, scrollBy]
  );

  const finishDrag = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const current = dragRef.current;
      (e.currentTarget as SVGSVGElement).releasePointerCapture?.(e.pointerId);
      setDrag(null);
      if (!current || current.kind !== "marquee") return;
      const hit = indicesInRect(layout, {
        x: Math.min(current.originX, current.x),
        y: Math.min(current.originY, current.y),
        w: Math.abs(current.x - current.originX),
        h: Math.abs(current.y - current.originY),
      });
      if (hit.length === 0) return;
      const picked = hit.map((i) => chars[i]).filter(Boolean);
      if (current.additive) addGlyphsToSelection(picked);
      else setGlyphSelection(picked);
    },
    [layout, chars, addGlyphsToSelection, setGlyphSelection]
  );

  const onDoubleClick = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const p = toContentPoint(e.clientX, e.clientY);
      if (!p) return;
      const index = indexAtPoint(layout, p.x, p.y);
      if (index < 0) return;
      // Double-click drops straight into the node/bezier editor for that
      // glyph — the overview's primary navigation gesture.
      openGlyphInSingleMode(chars[index]);
    },
    [toContentPoint, layout, chars, openGlyphInSingleMode]
  );

  const cursorClass =
    drag?.kind === "pan"
      ? "fm-ov-grabbing"
      : tool === "hand" || spacePanRef.current
        ? "fm-ov-grab"
        : "fm-ov-default";

  const marquee =
    drag?.kind === "marquee"
      ? {
          x: Math.min(drag.originX, drag.x),
          y: Math.min(drag.originY, drag.y) - scrollY,
          w: Math.abs(drag.x - drag.originX),
          h: Math.abs(drag.y - drag.originY),
        }
      : null;

  const tiles = [];
  for (let i = range.start; i < range.end; i++) {
    const char = chars[i];
    const glyph = glyphs[char];
    if (!glyph) continue;
    const rect = tileRect(layout, i);
    tiles.push(
      <GlyphTile
        key={char}
        glyph={glyph}
        rect={rect}
        labelPx={layout.labelPx}
        totalHeight={totalHeight}
        ascender={ascender}
        selected={selectedSet.has(char)}
        active={char === activeChar}
      />
    );
  }

  return (
    <div className="fm-canvas-frame fm-ov-frame" ref={frameRef} data-testid="glyph-overview-canvas">
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`0 0 ${Math.max(1, viewSize.w)} ${Math.max(1, viewSize.h)}`}
        className={cursorClass}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onDoubleClick={onDoubleClick}
        style={{ touchAction: "none" }}
      >
        <g transform={`translate(0 ${-scrollY})`}>{tiles}</g>
        {marquee && (
          <rect
            className="fm-ov-marquee"
            x={marquee.x}
            y={marquee.y}
            width={marquee.w}
            height={marquee.h}
          />
        )}
      </svg>

      {chars.length === 0 && (
        <div className="fm-ov-empty">
          Tidak ada glyph yang cocok dengan filter ini.
        </div>
      )}

      {/* Scroll position readout — a plain, non-interactive hint that the
          grid continues past the fold. Cheap to render and it never
          participates in hit-testing. */}
      {layout.contentH > viewSize.h && (
        <div className="fm-ov-scrollbar" aria-hidden="true">
          <div
            className="fm-ov-scrollbar-thumb"
            style={{
              top: `${(scrollY / Math.max(1, layout.contentH)) * 100}%`,
              height: `${Math.max(6, (viewSize.h / Math.max(1, layout.contentH)) * 100)}%`,
            }}
          />
        </div>
      )}
    </div>
  );
}
