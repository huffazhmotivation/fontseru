import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import { useAppStore } from "@/glyph/store";
import { hasOutline, type Glyph } from "@/types/glyph";
import { clampMultiZoom, MULTI_BASE_CELL_PX } from "@/types/glyphView";
import type { Point, VectorObject } from "@/types/geometry";
import { getGlyphPaths } from "./glyphPaths";
import { filterGlyphChars } from "./glyphFilter";
import { useGlyphEditor } from "./useGlyphEditor";
import { useBrushTool } from "./useBrushTool";
import { useBrushNodeTool } from "./useBrushNodeTool";
import { usePencilTool } from "./usePencilTool";
import { useSelectTool, handlePositions, type HandleId, type SkewHandleId } from "./useSelectTool";
import { contourToPath, toSvgPoint } from "./pathBuilder";
import { pointHitsObject } from "./objectOps";
import { hitTestSegments } from "./segmentHitTest";
import { editorCanvasCss } from "./editorCanvasCss";
import { GhostGlyph } from "./GhostGlyph";
import { familyGhostOrder, ghostCenterX, matchingFamilyGlyph } from "./ghostRef";
import { isFeatureGlyphUnicode } from "@/glyph/featureGlyphs";
import type { GlyphMap } from "@/types/glyph";
import {
  ObjectsLayer,
  NodesAndHandlesLayer,
  SkeletonGuideLayer,
  RubberBand,
  BrushNodeLivePreview,
  handleCursor,
} from "./GlyphCanvas";
import { MultiCanvasRuler, MULTI_RULER_SIZE } from "./MultiCanvasRuler";
import {
  cellHitAtWorld,
  cellOrigin,
  computeMultiEditLayout,
  visibleCellIndices,
  worldToGlyphPoint,
  type MultiEditLayout,
} from "./multiEditLayout";

/**
 * MULTI GLYPH EDIT CANVAS
 * =======================
 * The multi-glyph surface as a real drawing board: every glyph box on it
 * is live, so you draw straight into whichever cell you point at instead
 * of bouncing back to Single Mode for each letter.
 *
 * How it stays honest about being "the same editor, just more of it":
 *
 *  • ONE ENGINE. Pointer input is converted into the target cell's own
 *    font-unit space (see multiEditLayout) and handed to the EXACT tool
 *    hooks the single-glyph canvas uses — useGlyphEditor, useBrushTool,
 *    usePencilTool, useSelectTool. Pen, Pencil, Brush, Node, Select and
 *    every snap/undo behaviour therefore work here because they are
 *    literally the same code, not a port of it.
 *
 *  • ONE COPY OF THE DATA. Those hooks read and write `glyphs[activeChar]`
 *    in the store. So pointing at a cell simply means "make this the
 *    active glyph"; nothing is mirrored, buffered or merged back later,
 *    and a glyph drawn here is already drawn in Single Mode.
 *
 *  • THE CELL IS LOCKED FOR THE GESTURE. The cell is resolved once on
 *    pointer-down and reused until pointer-up, so a stroke that overshoots
 *    a cell's edge keeps belonging to the glyph it started in rather than
 *    leaking into the neighbour.
 *
 *  • ONLY THE ACTIVE CELL IS "THICK". The focused cell renders the full
 *    editable stack (objects, nodes, handles, previews, selection box);
 *    every other visible cell renders through `getGlyphPaths`, the cached
 *    path builder the overview and Test Lab already share. Off-screen
 *    cells render nothing at all.
 *
 * View controls, matching what the request asked for:
 *  • Middle-mouse (scroll-wheel) drag pans freely in both axes. So do the
 *    Hand tool and Space-drag.
 *  • Wheel zooms toward the cursor; Shift+wheel pans horizontally.
 *  • Rulers along the top and left read out font units relative to the
 *    ACTIVE cell's origin/baseline, and guides pulled off them are stored
 *    in font units — which is what makes one guide appear in the same
 *    place inside every glyph box.
 */

/** Pointer-down inside this margin (font units, scaled) past a cell's
 *  edge still counts as that cell. */
const CELL_HIT_PAD_PX = 6;

type PanDrag = { startClient: Point; startPan: Point };

/** The subset of a pointer event the tools need, snapshotted so a queued
 *  frame never reads a pooled/mutated event object. */
type PointerMoveSample = {
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  pointerType: string;
  pointerId: number;
  pressure: number;
};

/**
 * How much chrome a cell draws.
 *
 * THIS IS THE DECLUTTERING RULE FOR MULTI MODE.
 *
 * The old surface drew the full single-glyph guide stack — five metric
 * lines, the origin, LSB, advance, every ruler guide and the whole grid —
 * inside EVERY cell. That is correct information and completely unusable
 * information: forty cells on screen meant several hundred coloured lines
 * competing with the letters you were trying to look at, which is the
 * "ruwet" being complained about.
 *
 * So detail is now earned, by two rules that match how people actually
 * use the surface:
 *
 *  • The cell you are DRAWING IN gets everything, always. Focus is where
 *    precision is needed, so that is where precision lines belong.
 *  • Every other cell gets as much as its size on screen can carry. A
 *    cell 300 px tall can hold metric lines legibly; a 60 px thumbnail
 *    can only hold the letter itself, so that is all it gets.
 *
 * Nothing is lost: zoom in and the detail comes back on its own, cell by
 * cell, with no toggle to find and no setting to remember.
 */
type CellDetail = "full" | "metrics" | "lite" | "none";

/** Screen height of one cell → how much chrome it can carry legibly. */
function detailForCellPx(px: number): CellDetail {
  if (px >= 250) return "metrics";
  if (px >= 105) return "lite";
  return "none";
}

interface PassiveCellProps {
  glyph: Glyph;
  ascender: number;
  cellW: number;
  cellH: number;
  drawn: boolean;
  showPlaceholder: boolean;
}

/**
 * A non-focused cell's ink: cached outline paths, or a faint placeholder
 * character when nothing has been drawn yet. Memoized because panning
 * re-renders the container constantly while the individual cells' props
 * almost never change.
 *
 * The placeholder exists for exactly one reason: to say "this empty cell
 * is the letter K". A ghost reference says the same thing, better and at
 * the right size — so when a ghost is actually drawn in this cell the
 * placeholder is switched off. Leaving both on is what produced the
 * doubled letter: a small placeholder at 0.38 em sitting under a ghost at
 * roughly 0.95 em, two different sizes at two different heights.
 */
const PassiveCell = memo(function PassiveCell({
  glyph,
  ascender,
  cellW,
  cellH,
  drawn,
  showPlaceholder,
}: PassiveCellProps) {
  if (!drawn) {
    if (!showPlaceholder) return null;
    return (
      <text
        className="fm-mx-placeholder"
        x={cellW / 2}
        y={cellH * 0.62}
        textAnchor="middle"
        fontSize={cellH * 0.38}
      >
        {glyph.char === " " ? "␣" : glyph.char}
      </text>
    );
  }
  return (
    <>
      {getGlyphPaths(glyph, ascender).map((entry) =>
        entry.kind === "stroke" ? (
          <path
            key={entry.id}
            className="fm-mx-ink"
            d={entry.d}
            fill="none"
            strokeWidth={entry.strokeWidth}
            strokeLinecap={entry.cap as "round" | "butt" | "square"}
            strokeLinejoin={entry.join as "round" | "miter" | "bevel"}
          />
        ) : (
          <path key={entry.id} className="fm-mx-ink-fill" d={entry.d} fillRule="nonzero" />
        )
      )}
    </>
  );
});

/**
 * GHOST REFERENCE INSIDE ONE CELL.
 *
 * A cell's local coordinate space IS glyph space: the cell group is
 * translated to the cell origin, so x = 0 is that glyph's origin and
 * y = 0 is its ascender line — the exact space the single-glyph canvas
 * draws its ghost in.
 *
 * That is the whole trick behind "the ghost matches Single Mode". The
 * props below are passed through untouched from the same store values
 * (opacity/scale/offsetX/offsetY) and the anchor comes from the same
 * shared `ghostCenterX` the single canvas uses, computed from THIS cell's
 * own glyph. Same inputs, same function, same space — so a ghost drawn
 * here and a ghost drawn in Single Mode for the same glyph land on the
 * same font unit, and stay there when you drag the Scale or Offset
 * sliders.
 *
 * The one deliberate difference is Family mode. Single Mode has empty
 * canvas either side of the glyph and parks the two comparison styles in
 * those side lanes; Multi Mode has a neighbouring GLYPH there instead, so
 * lanes would draw one letter's reference on top of another letter's
 * drawing area. Here the two styles are overlaid inside the cell's own em
 * box (the second one fainter so the pair stays readable) — same size,
 * same offsets, same em box, just stacked instead of side by side.
 */
const CellGhost = memo(function CellGhost({
  mode,
  glyph,
  leftFamilyGlyph,
  rightFamilyGlyph,
  ascender,
  capHeight,
  upm,
  totalH,
  opacity,
  scale,
  offsetX,
  offsetY,
  imageSrc,
  imageAspect,
}: {
  mode: "sample" | "family" | "image";
  glyph: Glyph;
  leftFamilyGlyph?: Glyph;
  rightFamilyGlyph?: Glyph;
  ascender: number;
  capHeight: number;
  upm: number;
  totalH: number;
  opacity: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  imageSrc?: string | null;
  imageAspect?: number;
}) {
  const centerX = ghostCenterX(glyph, upm);

  if (mode === "sample") {
    if (isFeatureGlyphUnicode(glyph.unicode)) return null;
    return (
      <g className="fm-mx-ghost" data-ghost-mode="sample" pointerEvents="none">
        <GhostGlyph
          mode="sample"
          char={glyph.char}
          ascender={ascender}
          capHeight={capHeight}
          upm={upm}
          opacity={opacity}
          scale={scale}
          offsetX={offsetX}
          offsetY={offsetY}
          centerX={centerX}
        />
      </g>
    );
  }

  if (mode === "image") {
    if (!imageSrc) return null;
    return (
      <g className="fm-mx-ghost" data-ghost-mode="image" pointerEvents="none">
        <GhostGlyph
          mode="image"
          char={glyph.char}
          ascender={ascender}
          capHeight={capHeight}
          upm={upm}
          opacity={opacity}
          scale={scale}
          offsetX={offsetX}
          offsetY={offsetY}
          centerX={centerX}
          totalH={totalH}
          imageSrc={imageSrc}
          imageAspect={imageAspect}
        />
      </g>
    );
  }

  // ONE family ghost, not two.
  //
  // Single Mode can afford to show both comparison styles because it has
  // an empty lane either side of the glyph to park them in. Multi Mode has
  // a neighbouring LETTER there instead, so both styles have to share the
  // one em box — and two outlines stacked on the same box read as a
  // doubled, smudged glyph rather than a comparison. So only the primary
  // style is drawn here (Regular→Bold, Bold→Regular, Italic→Regular; see
  // familyGhostOrder). The second style stays available in Single Mode,
  // where the lanes make it legible.
  const familyGlyph = leftFamilyGlyph ?? rightFamilyGlyph;
  if (!familyGlyph) return null;
  return (
    <g className="fm-mx-ghost" data-ghost-mode="family" pointerEvents="none">
      <GhostGlyph
        mode="family"
        char={glyph.char}
        glyph={familyGlyph}
        ascender={ascender}
        capHeight={capHeight}
        upm={upm}
        opacity={opacity}
        scale={scale}
        offsetX={offsetX}
        offsetY={offsetY}
      />
    </g>
  );
});

/** Does a ghost actually paint something in this cell? Drives whether the
 *  empty-cell placeholder character is still needed — see PassiveCell. */
function ghostRendersFor(
  mode: "sample" | "family" | "image",
  glyph: Glyph,
  imageSrc: string | null | undefined,
  familyGlyph: Glyph | undefined
): boolean {
  if (mode === "sample") return !isFeatureGlyphUnicode(glyph.unicode);
  if (mode === "image") return !!imageSrc;
  return !!familyGlyph;
}

/** Metric lines + ruler guides drawn inside one cell's own box. Every
 *  value is in font units, so this is identical geometry in every cell —
 *  which is exactly what "a ruler guide per glyph box" means. How MUCH of
 *  it is drawn is decided by `detail`; see CellDetail above. */
const CellGuides = memo(function CellGuides({
  detail,
  cellW,
  cellH,
  ascender,
  descender,
  capHeight,
  xHeight,
  baseline,
  advanceWidth,
  lsb,
  showGuides,
  showGrid,
  gridSize,
  guides,
  sc,
}: {
  detail: CellDetail;
  cellW: number;
  cellH: number;
  ascender: number;
  descender: number;
  capHeight: number;
  xHeight: number;
  baseline: number;
  advanceWidth: number;
  lsb: number;
  showGuides: boolean;
  showGrid: boolean;
  gridSize: number;
  guides: { id: string; axis: "h" | "v"; position: number }[];
  sc: number;
}) {
  if (detail === "none") return null;

  const toY = (v: number) => ascender - v;
  const full = detail === "full";
  // "lite" keeps only the two lines a letter is actually sat on — the
  // baseline it stands on and the x-height it reaches. Those two are what
  // let you judge a shape at a glance; ascender/cap/descender only matter
  // once you are close enough to place a node, which is exactly when the
  // cell has grown into "metrics" or "full".
  const wantAllMetrics = (full || detail === "metrics") && showGuides;
  const lines = wantAllMetrics
    ? [
        { key: "ascender", v: ascender, cls: "metric-ascender" },
        { key: "capHeight", v: capHeight, cls: "metric-cap" },
        { key: "xHeight", v: xHeight, cls: "metric-xheight" },
        { key: "baseline", v: baseline, cls: "metric-baseline" },
        { key: "descender", v: descender, cls: "metric-descender" },
      ]
    : detail === "lite" && showGuides
    ? [
        { key: "xHeight", v: xHeight, cls: "metric-xheight" },
        { key: "baseline", v: baseline, cls: "metric-baseline" },
      ]
    : [{ key: "baseline", v: baseline, cls: "metric-baseline" }];

  return (
    <g pointerEvents="none" className={`fm-mx-guides ${detail}`}>
      {/* The grid is the single densest thing on the surface, so it stays
          in the focused cell only — a grid repeated across every cell is
          pure noise at any zoom where more than one cell is visible. */}
      {full && showGrid &&
        Array.from({ length: Math.floor(cellW / gridSize) + 1 }).map((_, i) => (
          <line key={`gv${i}`} x1={i * gridSize} y1={0} x2={i * gridSize} y2={cellH} className="grid-line" />
        ))}
      {full && showGrid &&
        Array.from({ length: Math.floor(cellH / gridSize) + 1 }).map((_, i) => (
          <line key={`gh${i}`} x1={0} y1={i * gridSize} x2={cellW} y2={i * gridSize} className="grid-line" />
        ))}

      {lines.map(({ key, v, cls }) => {
        const y = toY(v);
        if (y < -1 || y > cellH + 1) return null;
        return (
          <g key={key} className={`metric-guide ${cls}`}>
            <line x1={0} y1={y} x2={cellW} y2={y} className="metric-guide-line" />
          </g>
        );
      })}

      {/* Origin / LSB / Advance are per-glyph spacing marks: three more
          vertical lines per cell. Focused cell only. */}
      {full && showGuides && (
        <>
          <line x1={0} y1={0} x2={0} y2={cellH} className="origin-line" />
          <line x1={lsb} y1={0} x2={lsb} y2={cellH} className="glyph-metric-guide-line" />
          <line
            x1={advanceWidth}
            y1={0}
            x2={advanceWidth}
            y2={cellH}
            className="glyph-metric-guide-line advance"
          />
        </>
      )}

      {/* Ruler guides are deliberate, hand-placed and usually few, so they
          survive in every cell that draws anything at all — just quieter
          away from focus (see .fm-mx-guides.metrics / .lite in the CSS). */}
      {guides.map((g) => {
        if (g.axis === "h") {
          const y = toY(g.position);
          if (y < 0 || y > cellH) return null;
          const r = 3 / sc;
          return (
            <g key={g.id}>
              <line x1={0} y1={y} x2={cellW} y2={y} className="ruler-guide-line" />
              {full && (
                <rect
                  x={-r}
                  y={y - r}
                  width={r * 2}
                  height={r * 2}
                  transform={`rotate(45, 0, ${y})`}
                  className="ruler-guide-endcap"
                />
              )}
            </g>
          );
        }
        const x = g.position;
        if (x < 0 || x > cellW) return null;
        const r = 3 / sc;
        return (
          <g key={g.id}>
            <line x1={x} y1={0} x2={x} y2={cellH} className="ruler-guide-line" />
            {full && (
              <rect
                x={x - r}
                y={-r}
                width={r * 2}
                height={r * 2}
                transform={`rotate(45, ${x}, 0)`}
                className="ruler-guide-endcap"
              />
            )}
          </g>
        );
      })}
    </g>
  );
});

export function GlyphMultiEditCanvas() {
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const glyphs = useAppStore((s) => s.glyphs);
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const tool = useAppStore((s) => s.tool);
  const upm = useAppStore((s) => s.metrics.unitsPerEm);
  const ascender = useAppStore((s) => s.metrics.ascender);
  const descender = useAppStore((s) => s.metrics.descender);
  const capHeight = useAppStore((s) => s.metrics.capHeight);
  const xHeight = useAppStore((s) => s.metrics.xHeight);
  const baseline = useAppStore((s) => s.metrics.baseline);
  const showGrid = useAppStore((s) => s.showGrid);
  const gridSize = useAppStore((s) => s.gridSize);
  const showGuides = useAppStore((s) => s.showGuides);
  const showRuler = useAppStore((s) => s.showRuler);
  const rulerGuides = useAppStore((s) => s.rulerGuides);
  const liveOutline = useAppStore((s) => s.liveOutline);
  // Ghost reference. Read from the SAME store slice the single-glyph
  // canvas reads, so the two surfaces can never show a different ghost
  // for the same settings — flipping between Single and Multi changes the
  // layout around the ghost, never the ghost itself.
  const ghost = useAppStore((s) => s.ghost);
  const fontStyle = useAppStore((s) => s.fontStyle);
  const [leftGhostStyle, rightGhostStyle] = familyGhostOrder(fontStyle);
  const leftGhostMap = useAppStore((s) => s.glyphsByStyle[leftGhostStyle]) as GlyphMap | undefined;
  const rightGhostMap = useAppStore((s) => s.glyphsByStyle[rightGhostStyle]) as GlyphMap | undefined;
  const brush = useAppStore((s) => s.brush);
  const brushCap = useAppStore((s) => s.brushCap);
  const brushDrawMode = useAppStore((s) => s.brushDrawMode);
  const selectedObjectIds = useAppStore((s) => s.selectedObjectIds);
  const penAutoCloseShape = useAppStore((s) => s.penAutoClose);
  const setTool = useAppStore((s) => s.setTool);
  const selectNodes = useAppStore((s) => s.selectNodes);
  const selectObjects = useAppStore((s) => s.selectObjects);

  const filter = useAppStore((s) => s.overviewFilter);
  const query = useAppStore((s) => s.overviewQuery);
  const spacing = useAppStore((s) => s.overviewSpacing);
  const columns = useAppStore((s) => s.multiColumns);
  const zoom = useAppStore((s) => s.multiZoom);
  const pan = useAppStore((s) => s.multiPan);
  const setMultiPan = useAppStore((s) => s.setMultiPan);
  const multiFitNonce = useAppStore((s) => s.multiFitNonce);
  const selectedGlyphChars = useAppStore((s) => s.selectedGlyphChars);
  const setGlyphSelection = useAppStore((s) => s.setGlyphSelection);
  const toggleGlyphSelected = useAppStore((s) => s.toggleGlyphSelected);
  const openGlyphInSingleMode = useAppStore((s) => s.openGlyphInSingleMode);

  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  const [canvasRect, setCanvasRect] = useState<DOMRect | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const panDragRef = useRef<PanDrag | null>(null);
  const spacePanRef = useRef(false);
  /** Cell locked for the duration of the current drawing gesture. */
  const gestureCellRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<PointerMoveSample | null>(null);
  const flushPointerMoveRef = useRef<() => void>(() => {});
  const moveRafRef = useRef<number | null>(null);
  const processMoveRef = useRef<(sample: PointerMoveSample) => void>(() => {});

  const totalH = Math.max(1, ascender - descender);

  // ------------------------------------------------------------ layout
  const chars = useMemo(
    () => filterGlyphChars(glyphs, filter, selectedGlyphChars, query),
    [glyphs, filter, selectedGlyphChars, query]
  );

  const layout: MultiEditLayout = useMemo(
    () => computeMultiEditLayout({ count: chars.length, columns, upm, totalH, spacing }),
    [chars.length, columns, upm, totalH, spacing]
  );

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const update = () => {
      const inset = showRuler ? MULTI_RULER_SIZE : 0;
      setViewSize({ w: Math.max(0, el.clientWidth - inset), h: Math.max(0, el.clientHeight - inset) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showRuler]);

  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const update = () => setCanvasRect(el.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ----------------------------------------------------- view geometry
  // One scale for the whole plane: screen px per font unit.
  const baseScale = MULTI_BASE_CELL_PX / totalH;
  const sc = Math.max(1e-6, baseScale * (zoom / 100));
  const vbW = viewSize.w ? viewSize.w / sc : layout.contentW || upm;
  const vbH = viewSize.h ? viewSize.h / sc : layout.contentH || totalH;
  const vbX = pan.x - vbW / 2;
  const vbY = pan.y - vbH / 2;
  const hitScale = 1 / sc;

  // The tool hooks. Identical call signature and identical behaviour to
  // GlyphCanvas — they act on whichever glyph is active, which is what
  // pointer-down decides below.
  const editor = useGlyphEditor(hitScale);
  const brushTool = useBrushTool(hitScale);
  const brushNodeTool = useBrushNodeTool(hitScale);
  const pencilTool = usePencilTool(hitScale);
  const selectTool = useSelectTool(hitScale);

  // Fresh handles for use immediately after a synchronous activeChar
  // switch (see onPointerDown) — the callbacks captured in this render's
  // closure would still be bound to the PREVIOUS glyph.
  const toolsRef = useRef({ editor, brushTool, brushNodeTool, pencilTool, selectTool });
  toolsRef.current = { editor, brushTool, brushNodeTool, pencilTool, selectTool };
  // Brush tool, Node draw mode: same toolbar button as freehand Brush, just
  // captured Pen-tool style. Same flag GlyphCanvas uses — without honouring
  // it here the Multi canvas silently fell back to freehand drawing.
  const isNodeBrush = tool === "brush" && brushDrawMode === "node";

  const applyZoomAt = useCallback(
    (nextZoom: number, clientX: number, clientY: number) => {
      const rect = svgRef.current?.getBoundingClientRect();
      const store = useAppStore.getState();
      const clamped = clampMultiZoom(nextZoom);
      if (!rect || !rect.width || !rect.height) {
        store.setMultiZoom(clamped);
        return;
      }
      const tH = Math.max(1, store.metrics.ascender - store.metrics.descender);
      const base = MULTI_BASE_CELL_PX / tH;
      const oldScale = Math.max(1e-6, base * (store.multiZoom / 100));
      const newScale = Math.max(1e-6, base * (clamped / 100));
      if (oldScale === newScale) return;
      // Keep the world point under the cursor pinned while the scale
      // changes — the usual "zoom where you're looking" behaviour.
      const fx = (clientX - rect.left) / rect.width;
      const fy = (clientY - rect.top) / rect.height;
      const worldX = store.multiPan.x + (fx - 0.5) * (rect.width / oldScale);
      const worldY = store.multiPan.y + (fy - 0.5) * (rect.height / oldScale);
      store.setMultiZoom(clamped);
      store.setMultiPan({
        x: worldX + (0.5 - fx) * (rect.width / newScale),
        y: worldY + (0.5 - fy) * (rect.height / newScale),
      });
    },
    []
  );

  // Fit the whole grid into the viewport whenever asked (mount, column or
  // filter change, or the toolbar's Fit button).
  const lastFitRef = useRef(0);
  useEffect(() => {
    if (multiFitNonce === lastFitRef.current) return;
    if (!viewSize.w || !viewSize.h || layout.count === 0) return;
    lastFitRef.current = multiFitNonce;
    const padU = upm * 0.1;
    const w = layout.contentW + padU * 2;
    const h = layout.contentH + padU * 2;
    const target = Math.min(viewSize.w / w, viewSize.h / h);
    useAppStore.getState().setMultiZoom((target / baseScale) * 100);
    setMultiPan({ x: layout.contentW / 2, y: layout.contentH / 2 });
  }, [multiFitNonce, viewSize.w, viewSize.h, layout, upm, baseScale, setMultiPan]);

  // ------------------------------------------------------------- input
  const toWorld = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || !rect.width) return null;
      return { x: vbX + (clientX - rect.left) / sc, y: vbY + (clientY - rect.top) / sc };
    },
    [vbX, vbY, sc]
  );

  // Native non-passive wheel: the page must never scroll behind the
  // canvas, and the browser's own zoom must never hijack Ctrl+wheel.
  const wheelRef = useRef({ applyZoomAt, sc });
  wheelRef.current = { applyZoomAt, sc };
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { applyZoomAt: zoomAt, sc: scale } = wheelRef.current;
      const store = useAppStore.getState();
      if (e.shiftKey) {
        const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        store.setMultiPan({ x: store.multiPan.x + dx / scale, y: store.multiPan.y });
        return;
      }
      zoomAt(store.multiZoom * Math.exp(-e.deltaY * 0.0018), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /** Resolve the cell under a world point and make it the active glyph.
   *  Returns the cell index, or null when the point is outside every cell. */
  const focusCellAt = useCallback(
    (world: Point): number | null => {
      const hit = cellHitAtWorld(layout, world.x, world.y, CELL_HIT_PAD_PX * hitScale);
      if (!hit || !hit.inBox) return null;
      const char = chars[hit.index];
      if (!char) return null;
      if (char !== useAppStore.getState().activeChar) {
        // Synchronous on purpose. The tool hooks read the active glyph
        // through selectors, so without flushing here the very next call
        // would still edit the PREVIOUS glyph's outline. flushSync
        // re-renders this component immediately, which refreshes
        // toolsRef.current before we dispatch the gesture.
        flushSync(() => {
          useAppStore.getState().setActiveChar(char);
        });
      }
      return hit.index;
    },
    [layout, chars, hitScale]
  );

  const glyphPointFor = useCallback(
    (index: number, world: Point): Point => worldToGlyphPoint(layout, index, world, ascender),
    [layout, ascender]
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      e.preventDefault();
      flushPointerMoveRef.current();
      (e.target as Element).setPointerCapture?.(e.pointerId);

      // Middle-mouse (scroll-wheel click) drag, Hand tool and Space-drag
      // all pan freely in both axes.
      if (tool === "hand" || spacePanRef.current || e.button === 1) {
        panDragRef.current = { startClient: { x: e.clientX, y: e.clientY }, startPan: pan };
        return;
      }
      if (e.button !== 0) return;

      const world = toWorld(e.clientX, e.clientY);
      if (!world) return;

      if (tool === "zoom") {
        applyZoomAt(zoom * (e.shiftKey ? 0.8 : 1.25), e.clientX, e.clientY);
        return;
      }

      // The label strip under a cell is a pure selection target: click to
      // add that glyph to the batch selection the Right Panel tools read,
      // without touching its outline.
      const raw = cellHitAtWorld(layout, world.x, world.y);
      if (raw?.inLabel) {
        const char = chars[raw.index];
        if (!char) return;
        if (e.shiftKey || e.metaKey || e.ctrlKey) toggleGlyphSelected(char, true);
        else setGlyphSelection([char]);
        return;
      }

      const index = focusCellAt(world);
      if (index === null) {
        if (tool === "select") setGlyphSelection([]);
        return;
      }
      gestureCellRef.current = index;

      const p = glyphPointFor(index, world);
      const t = toolsRef.current;
      if (tool === "brush") return isNodeBrush ? t.brushNodeTool.pointerDown(p) : t.brushTool.pointerDown(p, e);
      if (tool === "pencil") return t.pencilTool.pointerDown(p);
      if (tool === "select") return t.selectTool.pointerDown(p, e.shiftKey, e.metaKey || e.ctrlKey);
      t.editor.pointerDown(p, e.shiftKey, e.altKey, e.metaKey || e.ctrlKey);
    },
    [
      tool,
      isNodeBrush,
      pan,
      zoom,
      toWorld,
      applyZoomAt,
      layout,
      chars,
      toggleGlyphSelected,
      setGlyphSelection,
      focusCellAt,
      glyphPointFor,
    ]
  );

  const processPointerMove = useCallback(
    (e: PointerMoveSample) => {
      if (panDragRef.current) {
        const d = panDragRef.current;
        setMultiPan({
          x: d.startPan.x - (e.clientX - d.startClient.x) / sc,
          y: d.startPan.y - (e.clientY - d.startClient.y) / sc,
        });
        return;
      }
      const world = toWorld(e.clientX, e.clientY);
      if (!world) return;

      // Outside a gesture, the hovered cell drives the Pen rubber-band
      // preview; during one, the locked cell does — so a stroke never
      // jumps glyphs just because the pointer crossed a cell boundary.
      const index =
        gestureCellRef.current ??
        ((tool === "pen" || isNodeBrush) ? cellHitAtWorld(layout, world.x, world.y)?.index ?? null : null);
      if (index === null) return;
      const p = glyphPointFor(index, world);
      if ((tool === "pen" || isNodeBrush) && chars[index] === activeChar) setHover(p);
      if (gestureCellRef.current === null) return;

      const t = toolsRef.current;
      if (tool === "brush") return isNodeBrush ? t.brushNodeTool.pointerMove(p) : t.brushTool.pointerMove(p, e);
      if (tool === "pencil") return t.pencilTool.pointerMove(p);
      if (tool === "select")
        return t.selectTool.pointerMove(p, e.shiftKey, e.pointerType, e.metaKey);
      t.editor.pointerMove(p, e.shiftKey, e.altKey);
    },
    [sc, toWorld, setMultiPan, tool, isNodeBrush, layout, chars, activeChar, glyphPointFor]
  );
  processMoveRef.current = processPointerMove;

  /** Pointer events can arrive several times per refresh interval —
   *  especially from a graphics tablet or a high-polling mouse. Collect
   *  them cheaply and act on the newest sample once per frame, the same
   *  way the single-glyph canvas does, so a fast brush stroke doesn't
   *  queue up more re-renders than the display can show. */
  const flushPointerMove = useCallback(() => {
    if (moveRafRef.current !== null) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
    }
    const pending = pendingMoveRef.current;
    pendingMoveRef.current = null;
    if (pending) processMoveRef.current(pending);
  }, []);
  flushPointerMoveRef.current = flushPointerMove;

  const onPointerMove = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    pendingMoveRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey || e.ctrlKey,
      pointerType: e.pointerType,
      pointerId: e.pointerId,
      pressure: e.pressure,
    };
    if (moveRafRef.current !== null) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null;
      const pending = pendingMoveRef.current;
      pendingMoveRef.current = null;
      if (pending) processMoveRef.current(pending);
    });
  }, []);

  useEffect(
    () => () => {
      if (moveRafRef.current !== null) cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
      pendingMoveRef.current = null;
    },
    []
  );

  const endGesture = useCallback(() => {
    // Commit the newest sample before releasing, so the last few pixels of
    // a stroke are never dropped by the frame queue.
    flushPointerMove();
    panDragRef.current = null;
    gestureCellRef.current = null;
    const t = toolsRef.current;
    if (tool === "brush") return isNodeBrush ? t.brushNodeTool.pointerUp() : t.brushTool.pointerUp();
    if (tool === "pencil") return t.pencilTool.pointerUp();
    if (tool === "select") return t.selectTool.pointerUp();
    t.editor.pointerUp();
  }, [tool, isNodeBrush]);

  useEffect(() => {
    const onUp = () => endGesture();
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, [endGesture]);

  useEffect(() => {
    if (tool !== "pen" && !isNodeBrush) setHover(null);
  }, [tool, isNodeBrush]);

  // Leaving Brush/Node (other tool, or back to Freehand) drops any
  // half-placed node path instead of leaving it pending in the background.
  const cancelBrushNode = brushNodeTool.cancel;
  useEffect(() => {
    if (!isNodeBrush) cancelBrushNode();
  }, [isNodeBrush, cancelBrushNode]);

  // Space-to-pan + the Node tool's keyboard editing, same bindings as the
  // single-glyph canvas so muscle memory carries over.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.code === "Space") spacePanRef.current = true;
      if (e.key === "Escape") {
        editor.finishOpenContour();
        brushTool.cancel();
        if (isNodeBrush) brushNodeTool.escape();
        pencilTool.cancel();
      }
      if (tool === "node") {
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          editor.deleteSelectedNodes();
        }
        const step = e.shiftKey ? 10 : 1;
        if (e.key === "ArrowLeft") { e.preventDefault(); editor.nudgeNodes(-step, 0); }
        if (e.key === "ArrowRight") { e.preventDefault(); editor.nudgeNodes(step, 0); }
        if (e.key === "ArrowUp") { e.preventDefault(); editor.nudgeNodes(0, step); }
        if (e.key === "ArrowDown") { e.preventDefault(); editor.nudgeNodes(0, -step); }
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") spacePanRef.current = false;
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [editor, brushTool, brushNodeTool, isNodeBrush, pencilTool, tool]);

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      const world = toWorld(e.clientX, e.clientY);
      if (!world) return;
      const raw = cellHitAtWorld(layout, world.x, world.y);
      if (!raw) return;
      // Double-clicking a cell's label takes that glyph into Single Mode —
      // the escape hatch to the full-size editor.
      if (raw.inLabel) {
        const char = chars[raw.index];
        if (char) openGlyphInSingleMode(char);
        return;
      }
      const index = focusCellAt(world);
      if (index === null) return;
      const p = glyphPointFor(index, world);
      const t = toolsRef.current;
      const tol = 6 * hitScale;

      if (tool === "pen") {
        if (t.editor.isCurrentEndpoint(p)) t.editor.finishOpenContour();
        return;
      }
      if (isNodeBrush) {
        // Double-click commits the open node-drawn path, like Pen's
        // endpoint double-click.
        if (t.brushNodeTool.liveNodes.length >= 2) t.brushNodeTool.finishOpen();
        return;
      }
      if (tool === "select") {
        // Same gesture as Single Mode: double-click an object to drop into
        // its nodes.
        for (let i = t.editor.outline.objects.length - 1; i >= 0; i--) {
          const obj = t.editor.outline.objects[i];
          if (!pointHitsObject(obj, p, tol)) continue;
          const refs = obj.contours.flatMap((c) =>
            c.nodes.map((n) => ({ contourId: c.id, nodeId: n.id }))
          );
          selectObjects([obj.id]);
          setTool("node");
          selectNodes(refs);
          return;
        }
        return;
      }
      if (tool === "node") {
        const hitR = 12 * hitScale;
        for (const o of t.editor.nodeableOutline.objects)
          for (const c of o.contours)
            for (const n of c.nodes)
              if (Math.hypot(n.point.x - p.x, n.point.y - p.y) <= hitR)
                return t.editor.cycleNodeType(c.id, n.id);
        if (hitTestSegments(t.editor.nodeableOutline, p, 10 * hitScale * 1.8)) {
          t.editor.insertNodeAt(p);
        }
      }
    },
    [
      toWorld,
      layout,
      chars,
      openGlyphInSingleMode,
      focusCellAt,
      glyphPointFor,
      hitScale,
      tool,
      isNodeBrush,
      selectObjects,
      setTool,
      selectNodes,
    ]
  );

  // ------------------------------------------------------------ render
  const visible = useMemo(
    () => visibleCellIndices(layout, { x: vbX, y: vbY, w: vbW, h: vbH }, 1),
    [layout, vbX, vbY, vbW, vbH]
  );
  const activeIndex = useMemo(() => chars.indexOf(activeChar), [chars, activeChar]);
  // On-screen size of one cell, in CSS pixels. Everything cosmetic keys
  // off this: how much guide detail a passive cell carries, and whether
  // its name label is even large enough to be worth drawing.
  const cellPx = layout.cellH * sc;
  const passiveDetail = detailForCellPx(cellPx);
  const showLabels = layout.labelH * sc >= 7;
  const ghostOn = ghost.enabled && ghost.opacity > 0;
  const ghostMode = ghost.mode ?? "sample";
  const activeOrigin = useMemo(
    () => (activeIndex >= 0 ? cellOrigin(layout, activeIndex) : { x: 0, y: 0 }),
    [layout, activeIndex]
  );
  const selectedSet = useMemo(() => new Set(selectedGlyphChars), [selectedGlyphChars]);

  const renderOutline = liveOutline ?? glyph?.outline ?? { objects: [] };
  const objects = editor.outline.objects;
  const objectsForRender = liveOutline ? renderOutline.objects : objects;
  const selBounds = tool === "select" ? selectTool.bounds : null;
  const handlePts = useMemo(
    () => (selBounds ? handlePositions(selBounds, selectTool.rotateOffset, selectTool.skewOffset) : null),
    [selBounds, selectTool.rotateOffset, selectTool.skewOffset]
  );

  const cursorClass =
    panDragRef.current ? "cursor-hand"
    : tool === "pen" ? "cursor-pen"
    : tool === "node" ? "cursor-node"
    : tool === "shape" ? "cursor-shape"
    : tool === "hand" ? "cursor-hand"
    : tool === "zoom" ? "cursor-zoom"
    : isNodeBrush ? "cursor-pen"
    : tool === "brush" ? "cursor-brush"
    : tool === "pencil" ? "cursor-pencil"
    : tool === "select" && selectTool.hoverHandle ? handleCursor(selectTool.hoverHandle)
    : "cursor-select";

  return (
    <div className="fm-canvas-frame fm-mx-frame" ref={frameRef} data-testid="glyph-multi-edit-canvas">
      {showRuler && (
        <MultiCanvasRuler
          scale={sc}
          vbX={vbX}
          vbY={vbY}
          ascender={ascender}
          originX={activeOrigin.x}
          originY={activeOrigin.y}
          canvasRect={canvasRect}
        />
      )}
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`${vbX} ${vbY} ${Math.max(1e-3, vbW)} ${Math.max(1e-3, vbH)}`}
        className={cursorClass}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onDoubleClick={onDoubleClick}
        style={{
          touchAction: "none",
          ...(showRuler
            ? {
                position: "absolute",
                top: MULTI_RULER_SIZE,
                left: MULTI_RULER_SIZE,
                width: `calc(100% - ${MULTI_RULER_SIZE}px)`,
                height: `calc(100% - ${MULTI_RULER_SIZE}px)`,
              }
            : {}),
        }}
      >
        <style>{editorCanvasCss(sc)}</style>
        {/* Cell chrome. The whole point of this block is RESTRAINT: one
            hairline per cell, one soft fill difference between drawn and
            empty, and a single accent ring that sits OUTSIDE the em box
            so it marks the focused cell without drawing a second line on
            top of that glyph's own advance/origin marks. */}
        <style>{`
          .fm-mx-cell-box {
            fill: var(--canvas);
            stroke: color-mix(in srgb, var(--line) 62%, transparent);
            stroke-width: ${1 / sc};
          }
          .fm-mx-cell.drawn .fm-mx-cell-box { fill: color-mix(in srgb, var(--panel) 42%, var(--canvas)); }
          .fm-mx-cell.selected .fm-mx-cell-box {
            fill: color-mix(in srgb, var(--accent) 8%, var(--canvas));
            stroke: color-mix(in srgb, var(--accent) 42%, var(--line));
          }
          .fm-mx-cell.active .fm-mx-cell-box { fill: var(--canvas); stroke: color-mix(in srgb, var(--accent) 30%, var(--line)); }
          .fm-mx-cell-ring { fill: none; stroke: var(--accent); stroke-width: ${1.9 / sc}; }
          .fm-mx-cell-ring.soft { stroke: color-mix(in srgb, var(--accent) 50%, transparent); stroke-width: ${1.3 / sc}; }
          .fm-mx-ink-fill { fill: var(--ink); stroke: none; }
          .fm-mx-ink { stroke: var(--ink); fill: none; }
          /* Passive ink is a touch quieter than the cell being drawn in,
             so the focused letter reads first without the others fading
             into unreadability. */
          .fm-mx-cell.passive .fm-mx-ink-fill,
          .fm-mx-cell.passive .fm-mx-ink { opacity: 0.86; }
          .fm-mx-placeholder { fill: var(--text-faint); opacity: 0.2; font-family: var(--sans); font-weight: 600; }
          .fm-mx-label { fill: var(--text-faint); font-family: var(--mono); opacity: 0.72; }
          .fm-mx-label.selected { fill: var(--accent); opacity: 1; }
          .fm-mx-cell.active .fm-mx-label { fill: var(--accent); opacity: 1; }
          /* Guide fade-out away from focus — see CellDetail. The lines are
             still there when you need them, just no longer shouting. */
          .fm-mx-guides.metrics { opacity: 0.5; }
          .fm-mx-guides.lite { opacity: 0.34; }
          .fm-mx-ghost { pointer-events: none; }
        `}</style>

        {visible.map((index) => {
          const char = chars[index];
          const cellGlyph = glyphs[char];
          if (!cellGlyph) return null;
          const origin = cellOrigin(layout, index);
          const isActive = char === activeChar;
          const isSelected = selectedSet.has(char);
          const rx = layout.cellW * 0.014;
          const cellFamilyGlyph =
            ghostOn && ghostMode === "family"
              ? matchingFamilyGlyph(leftGhostMap, cellGlyph, char) ??
                matchingFamilyGlyph(rightGhostMap, cellGlyph, char)
              : undefined;
          const cellGhostVisible =
            ghostOn && ghostRendersFor(ghostMode, cellGlyph, ghost.imageSrc, cellFamilyGlyph);
          return (
            <g
              key={char}
              className={`fm-mx-cell${isActive ? " active" : " passive"}${isSelected ? " selected" : ""}${
                hasOutline(cellGlyph) ? " drawn" : " empty"
              }`}
              data-char={char}
              transform={`translate(${origin.x} ${origin.y})`}
            >
              <rect
                className="fm-mx-cell-box"
                x={0}
                y={0}
                rx={rx}
                ry={rx}
                width={layout.cellW}
                height={layout.cellH}
              />
              {/* Focus/selection marker drawn as a ring OUTSIDE the em box.
                  Putting it on the box itself meant the accent stroke and
                  the glyph's own advance line landed on the same pixels —
                  two different meanings, one line. Offsetting it keeps the
                  box edge honest as a metric. */}
              {(isActive || isSelected) && (
                <rect
                  className={`fm-mx-cell-ring${isActive ? "" : " soft"}`}
                  x={-5 / sc}
                  y={-5 / sc}
                  rx={rx + 5 / sc}
                  ry={rx + 5 / sc}
                  width={layout.cellW + 10 / sc}
                  height={layout.cellH + 10 / sc}
                />
              )}
              {/* Ghost sits under everything else, exactly as in Single
                  Mode: below the guides, below the ink, never hit-tested. */}
              {ghostOn && (
                <CellGhost
                  mode={ghostMode}
                  glyph={cellGlyph}
                  leftFamilyGlyph={cellFamilyGlyph}
                  rightFamilyGlyph={undefined}
                  ascender={ascender}
                  capHeight={capHeight}
                  upm={upm}
                  totalH={totalH}
                  opacity={ghost.opacity}
                  scale={ghost.scale}
                  offsetX={ghost.offsetX}
                  offsetY={ghost.offsetY}
                  imageSrc={ghost.imageSrc}
                  imageAspect={ghost.imageAspect}
                />
              )}
              <CellGuides
                detail={isActive ? "full" : passiveDetail}
                cellW={layout.cellW}
                cellH={layout.cellH}
                ascender={ascender}
                descender={descender}
                capHeight={capHeight}
                xHeight={xHeight}
                baseline={baseline}
                advanceWidth={cellGlyph.advanceWidth}
                lsb={cellGlyph.lsb}
                showGuides={showGuides}
                showGrid={showGrid}
                gridSize={gridSize}
                guides={rulerGuides}
                sc={sc}
              />
              {isActive ? (
                // The focused cell renders the full editable stack.
                <>
                  <ObjectsLayer
                    objects={objectsForRender}
                    ascender={ascender}
                    tool={tool}
                    penAutoCloseShape={penAutoCloseShape}
                    drawingContourId={editor.drawingContourId}
                    selectedObjectIds={selectedObjectIds}
                    overlappingIds={EMPTY_ID_SET}
                  />

                  {brushTool.previewOutline.length > 0 && (
                    <path
                      d={brushTool.previewOutline.map((c) => contourToPath(c, ascender)).join(" ")}
                      className="obj-fill"
                      fillRule="nonzero"
                      opacity={0.9}
                    />
                  )}
                  {brushTool.previewCenterline && (
                    <path
                      d={contourToPath(brushTool.previewCenterline, ascender)}
                      className="brush-preview"
                      strokeWidth={brush.size}
                      strokeLinecap={brushCap}
                      strokeLinejoin="round"
                    />
                  )}
                  {isNodeBrush && (
                    <BrushNodeLivePreview
                      outline={brushNodeTool.previewOutline}
                      strokeObject={brushNodeTool.previewStrokeObject}
                      ascender={ascender}
                    />
                  )}
                  {pencilTool.previewContour && (
                    <>
                      <path
                        d={contourToPath({ ...pencilTool.previewContour, closed: true }, ascender)}
                        className="pencil-preview-fill"
                        fillRule="nonzero"
                      />
                      <path
                        d={contourToPath({ ...pencilTool.previewContour, closed: false }, ascender)}
                        className="pencil-preview"
                        strokeWidth={2 * hitScale}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </>
                  )}
                  {tool === "pen" && editor.drawingContourId && hover && (
                    <RubberBand
                      outline={editor.outline}
                      contourId={editor.drawingContourId}
                      hover={hover}
                      ascender={ascender}
                      hitScale={hitScale}
                    />
                  )}
                  {isNodeBrush && brushNodeTool.liveNodes.length > 0 && hover && (
                    <RubberBand
                      outline={{ objects: [{ id: "brush-node-preview", kind: "brush", contours: [{ id: "brush-node-preview-contour", nodes: brushNodeTool.liveNodes, closed: false }] } as VectorObject] }}
                      contourId="brush-node-preview-contour"
                      hover={hover}
                      ascender={ascender}
                      hitScale={hitScale}
                    />
                  )}
                  {editor.marqueeRect && (
                    <rect
                      x={editor.marqueeRect.x}
                      y={ascender - (editor.marqueeRect.y + editor.marqueeRect.h)}
                      width={editor.marqueeRect.w}
                      height={editor.marqueeRect.h}
                      className="marquee-rect"
                    />
                  )}
                  {selectTool.marqueeRect && (
                    <rect
                      x={selectTool.marqueeRect.x}
                      y={ascender - (selectTool.marqueeRect.y + selectTool.marqueeRect.h)}
                      width={selectTool.marqueeRect.w}
                      height={selectTool.marqueeRect.h}
                      className="marquee-rect"
                    />
                  )}
                  {tool === "select" && selBounds && handlePts && (
                    <g>
                      <rect
                        x={selBounds.minX}
                        y={ascender - selBounds.maxY}
                        width={selBounds.maxX - selBounds.minX}
                        height={selBounds.maxY - selBounds.minY}
                        className="sel-box"
                      />
                      <line
                        x1={handlePts.n.x}
                        y1={ascender - handlePts.n.y}
                        x2={handlePts.rotate.x}
                        y2={ascender - handlePts.rotate.y}
                        className="sel-rot-line"
                      />
                      <circle
                        cx={handlePts.rotate.x}
                        cy={ascender - handlePts.rotate.y}
                        r={5 * hitScale}
                        className="sel-handle"
                      />
                      {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as HandleId[]).map((id) => {
                        const s = 7 * hitScale;
                        return (
                          <rect
                            key={id}
                            x={handlePts[id].x - s / 2}
                            y={ascender - handlePts[id].y - s / 2}
                            width={s}
                            height={s}
                            className="sel-handle"
                          />
                        );
                      })}
                      {(
                        ["skew-x-top", "skew-x-bottom", "skew-y-left", "skew-y-right"] as SkewHandleId[]
                      ).map((id) => {
                        const p = handlePts[id];
                        const s = 6.5 * hitScale;
                        return (
                          <rect
                            key={id}
                            x={p.x - s / 2}
                            y={ascender - p.y - s / 2}
                            width={s}
                            height={s}
                            rx={1.2 * hitScale}
                            className="sel-skew-handle"
                            transform={`rotate(45 ${p.x} ${ascender - p.y})`}
                            data-transform-handle={id}
                          />
                        );
                      })}
                    </g>
                  )}
                  {tool === "node" || tool === "pen" || (isNodeBrush && brushNodeTool.isDrawing) ? (
                    <NodesAndHandlesLayer
                      objects={
                        tool === "node"
                          ? editor.nodeableOutline.objects
                          : isNodeBrush
                          ? (brushNodeTool.liveNodes.length > 0
                              ? [{
                                  id: "brush-node-preview",
                                  kind: "brush",
                                  contours: [{ id: "brush-node-preview-contour", nodes: brushNodeTool.liveNodes, closed: false }],
                                } as VectorObject]
                              : [])
                          : objects
                      }
                      ascender={ascender}
                      hitScale={hitScale}
                      tool={tool}
                      selectedNodes={editor.selectedNodes}
                      selectedHandle={editor.selectedHandle}
                      activeRoundCorner={
                        editor.roundCornerLabel
                          ? {
                              contourId: editor.roundCornerLabel.contourId,
                              cornerPoint: editor.roundCornerLabel.cornerPoint,
                            }
                          : undefined
                      }
                    />
                  ) : (
                    <SkeletonGuideLayer objects={objects} ascender={ascender} />
                  )}
                  {editor.handleSnapGuide && (() => {
                    const { point, x, y } = editor.handleSnapGuide;
                    const svgP = toSvgPoint(point, ascender);
                    return (
                      <g pointerEvents="none" data-testid="handle-snap-guide">
                        {x !== null && (
                          <line x1={svgP.x} y1={0} x2={svgP.x} y2={layout.cellH} className="handle-snap-line" />
                        )}
                        {y !== null && (
                          <line x1={0} y1={svgP.y} x2={layout.cellW} y2={svgP.y} className="handle-snap-line" />
                        )}
                        <circle cx={svgP.x} cy={svgP.y} r={2.6 * hitScale} className="handle-snap-dot" />
                      </g>
                    );
                  })()}
                </>
              ) : (
                <PassiveCell
                  glyph={cellGlyph}
                  ascender={ascender}
                  cellW={layout.cellW}
                  cellH={layout.cellH}
                  drawn={hasOutline(cellGlyph)}
                  showPlaceholder={!cellGhostVisible}
                />
              )}
              {/* One label rule for every cell, focused or not. Labels are
                  dropped entirely once a cell is too small to render them
                  at a readable size — below that they are a grey smear
                  under every box and nothing more. */}
              {showLabels && (
                <text
                  className={`fm-mx-label${isSelected ? " selected" : ""}`}
                  x={layout.cellW / 2}
                  y={layout.cellH + layout.labelH * 0.78}
                  textAnchor="middle"
                  fontSize={layout.labelH * 0.66}
                >
                  {cellLabel(cellGlyph)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {chars.length === 0 && (
        <div className="fm-ov-empty">Tidak ada glyph yang cocok dengan filter ini.</div>
      )}
    </div>
  );
}

/** A cell's caption. Long Feature-Builder names ("uppercase.swash.alt")
 *  are wider than the box they label and used to run into the neighbouring
 *  cell's caption, which is a large part of why the grid read as cluttered;
 *  they are clipped to a length the box can hold. */
function cellLabel(glyph: Glyph): string {
  if (glyph.char === " ") return "space";
  const raw = glyph.name ?? glyph.char;
  return raw.length > 12 ? `${raw.slice(0, 11)}…` : raw;
}

/** Overlap highlighting is a single-glyph review aid; it would cost an
 *  O(n²) pass per cell here for no benefit, so the multi canvas passes a
 *  stable empty set rather than recomputing one. */
const EMPTY_ID_SET: Set<string> = new Set();
