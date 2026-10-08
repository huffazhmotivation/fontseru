import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useAppStore, type GlyphMetricKey } from "@/glyph/store";
import { useGlyphEditor } from "./useGlyphEditor";
import { useBrushTool, type BrushPreview } from "./useBrushTool";
import { useBrushNodeTool } from "./useBrushNodeTool";
import { usePencilTool } from "./usePencilTool";
import { useSelectTool, handlePositions, type HandleId, type SkewHandleId } from "./useSelectTool";
import { useSketchGestures } from "./useSketchGestures";
import { clientToFontPoint } from "./coords";
import { objectFillPath, objectStrokePath, toSvgPoint, contourToPath } from "./pathBuilder";
import { outlineBounds, pointHitsObject, selectionUnitIds } from "./objectOps";
import { getCornerHandles } from "./nodeOps";
import { hitTestSegments } from "./segmentHitTest";
import { findOverlappingObjectIds } from "./overlapDetect";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { mergeOutlineBrushStrokes } from "./glyphPaths";
import { GhostGlyph } from "./GhostGlyph";
import { familyGhostOrder, ghostCenterX as ghostCenterXFor, matchingFamilyGlyph } from "./ghostRef";
import { CanvasRuler, RulerGuideLines, RULER_SIZE } from "./CanvasRuler";
import { EDITOR_CANVAS_CSS_SCALED_BY_VAR } from "./editorCanvasCss";
import { GridLayer } from "./GridLayer";
import { useLongPress } from "./useLongPress";
import { CanvasContextMenu, type CanvasMenuPos } from "@/components/CanvasContextMenu";
import { NodeTypePopup, type NodePopupState } from "@/components/NodeTypePopup";
import { RecordingBadge } from "@/timelapse/RecordingBadge";
import { isFeatureGlyphUnicode } from "@/glyph/featureGlyphs";
import type { Contour, GlyphOutline, NodeType, PathNode, Point, VectorObject } from "@/types/geometry";
import { createPreviewStore, usePreviewValue, type PreviewStore } from "./previewStore";
import { affineToSvgMatrix, transformPreviewIsExact } from "./transformPreview";

const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();
const EXTERNAL_PREVIEW = { externalPreview: true } as const;

/** requestIdleCallback with a setTimeout fallback (Safari). */
function scheduleIdle(cb: () => void, timeout: number): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(cb, { timeout });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(cb, 100);
  return () => window.clearTimeout(id);
}

function sameIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function isFormField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}


type PointerMoveSample = {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  pressure: number;
};

export function GlyphCanvas() {
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const tool = useAppStore((s) => s.tool);
  const sketchMode = useAppStore((s) => s.sketchMode);
  const zoom = useAppStore((s) => s.zoom);
  const pan = useAppStore((s) => s.pan);
  const setPan = useAppStore((s) => s.setPan);
  const setZoom = useAppStore((s) => s.setZoom);
  const showGrid = useAppStore((s) => s.showGrid);
  const gridSize = useAppStore((s) => s.gridSize);
  const gridShape = useAppStore((s) => s.gridShape);
  // Drawing Mode: free sketch canvas — baseline is the only metric guide.
  const drawMode = useAppStore((s) => s.editorMode === "draw");
  const showGuides = useAppStore((s) => s.showGuides);
  const showRuler = useAppStore((s) => s.showRuler);
  const rulerGuides = useAppStore((s) => s.rulerGuides);
  const removeRulerGuide = useAppStore((s) => s.removeRulerGuide);
  // Field-by-field selectors instead of `useAppStore((s) => s.metrics)`:
  // the canvas only ever draws using the five guide values + unitsPerEm
  // below, but `metrics` also carries `wordSpacing` (and other font-wide
  // fields unrelated to this view). Subscribing to the whole object meant
  // every keystroke in the Word Spacing field (RightPanel's Font Metrics
  // section) produced a new `metrics` reference and forced this entire
  // canvas — outline paths, handles, guides, ghost glyphs — to re-render,
  // which is what made typing into Word Spacing feel laggy. Selecting each
  // field individually means this component only re-renders when a value
  // it actually uses changes.
  const upm = useAppStore((s) => s.metrics.unitsPerEm);
  const ascender = useAppStore((s) => s.metrics.ascender);
  const baseline = useAppStore((s) => s.metrics.baseline);
  const descender = useAppStore((s) => s.metrics.descender);
  const capHeight = useAppStore((s) => s.metrics.capHeight);
  const xHeight = useAppStore((s) => s.metrics.xHeight);
  const beginMetricDrag = useAppStore((s) => s.beginMetricDrag);
  const setFontMetricLive = useAppStore((s) => s.setFontMetricLive);
  const endMetricDrag = useAppStore((s) => s.endMetricDrag);
  const setMetricFocus = useAppStore((s) => s.setMetricFocus);
  const beginGlyphMetricDrag = useAppStore((s) => s.beginGlyphMetricDrag);
  const setGlyphMetricLive = useAppStore((s) => s.setGlyphMetricLive);
  const endGlyphMetricDrag = useAppStore((s) => s.endGlyphMetricDrag);
  const setGlyphMetricFocus = useAppStore((s) => s.setGlyphMetricFocus);
  const autoSpacingEnabled = useAppStore((s) => s.autoSpacingEnabled);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const liveOutline = useAppStore((s) => s.liveOutline);
  const activeChar = useAppStore((s) => s.activeChar);
  const ghost = useAppStore((s) => s.ghost);
  // Only subscribe to the two specific ghost styles needed for preview,
  // not the entire glyphsByStyle map which would re-render on any
  // style change (bold/italic/custom edits, family generation, etc.).
  const fontStyle = useAppStore((s) => s.fontStyle);
  const [leftGhostStyle, rightGhostStyle] = familyGhostOrder(fontStyle);
  const leftGhostMap = useAppStore((s) => s.glyphsByStyle[leftGhostStyle]);
  const rightGhostMap = useAppStore((s) => s.glyphsByStyle[rightGhostStyle]);
  const brush = useAppStore((s) => s.brush);
  const brushCap = useAppStore((s) => s.brushCap);
  const brushDrawMode = useAppStore((s) => s.brushDrawMode);
  const fitNonce = useAppStore((s) => s.fitNonce);
  const selectedObjectIds = useAppStore((s) => s.selectedObjectIds);
  const setTool = useAppStore((s) => s.setTool);
  const selectNodes = useAppStore((s) => s.selectNodes);
  const selectObjects = useAppStore((s) => s.selectObjects);
  const penAutoCloseShape = useAppStore((s) => s.penAutoClose);

  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  // Pointer hover position, only consumed by the Pen / Node-Brush
  // rubber-band. Kept in a tiny observable store instead of React state so a
  // hover sample re-renders just the rubber-band, not this whole canvas.
  const hoverStoreRef = useRef<PreviewStore<Point | null> | null>(null);
  if (!hoverStoreRef.current) hoverStoreRef.current = createPreviewStore<Point | null>(null);
  const hoverStore = hoverStoreRef.current;
  const panDragRef = useRef<{ startClient: Point; startPan: Point } | null>(null);
  const pendingPointerMoveRef = useRef<PointerMoveSample | null>(null);
  const pointerMoveRafRef = useRef<number | null>(null);
  const pointerMoveProcessorRef = useRef<(sample: PointerMoveSample) => void>(() => {});
  const pendingWheelRef = useRef<{ deltaY: number; deltaX: number; clientX: number; clientY: number; shiftKey: boolean } | null>(null);
  const wheelRafRef = useRef<number | null>(null);
  const wheelProcessorRef = useRef<(event: NonNullable<typeof pendingWheelRef.current>) => void>(() => {});
  type MetricGuideKey = "ascender" | "capHeight" | "xHeight" | "baseline" | "descender";
  const metricDragRef = useRef<{ key: MetricGuideKey; startClientY: number; startValue: number; startScale: number } | null>(null);
  const pendingMetricClientYRef = useRef<number | null>(null);
  const metricMoveRafRef = useRef<number | null>(null);
  const [activeMetricGuide, setActiveMetricGuide] = useState<MetricGuideKey | null>(null);
  const glyphMetricDragRef = useRef<{ key: GlyphMetricKey; startClientX: number; startValue: number; startScale: number } | null>(null);
  const pendingGlyphMetricClientXRef = useRef<number | null>(null);
  const glyphMetricMoveRafRef = useRef<number | null>(null);
  const [activeGlyphMetricGuide, setActiveGlyphMetricGuide] = useState<GlyphMetricKey | null>(null);
  const spacePanRef = useRef(false);
  // Pointer that started the current canvas gesture (see pointercancel).
  const activePointerIdRef = useRef<number | null>(null);

  const totalH = ascender - descender;
  // Default horizontal anchor for the "sample" and "image" ghost modes:
  // the center of this glyph's own standard advance box (lsb..advance-rsb),
  // not the full upm square. Keeps the reference character/image lined up
  // with where this glyph's ink is actually drawn, the same way LSB/RSB/
  // Advance already default to FontSeru's standard sidebearing metrics.
  const ghostCenterX = ghostCenterXFor(glyph, upm);
  const leftFamilyGlyph = useMemo(
    () => (glyph ? matchingFamilyGlyph(leftGhostMap, glyph, activeChar) : undefined),
    [leftGhostMap, glyph, activeChar]
  );
  const rightFamilyGlyph = useMemo(
    () => (glyph ? matchingFamilyGlyph(rightGhostMap, glyph, activeChar) : undefined),
    [rightGhostMap, glyph, activeChar]
  );

  const baseFit = viewSize.w && viewSize.h ? 0.62 * Math.min(viewSize.w / upm, viewSize.h / totalH) : 0.35;
  const scale = baseFit * (zoom / 100);
  const vbW = viewSize.w ? viewSize.w / scale : upm;
  const vbH = viewSize.h ? viewSize.h / scale : totalH;
  const vbX = pan.x - vbW / 2;
  const vbY = pan.y - vbH / 2;
  const sc = scale || 0.35;
  const hitScale = 1 / sc;

  const editor = useGlyphEditor(hitScale);

  // Right-click (PC) / long-press (tablet) context menu and the node-type
  // popup shown after clicking a node. `lastUpRef` remembers where the last
  // pointer was released so the node popup can open right next to the node.
  const [ctxMenu, setCtxMenu] = useState<CanvasMenuPos | null>(null);
  const [nodePopup, setNodePopup] = useState<NodePopupState | null>(null);
  const lastUpRef = useRef<{ x: number; y: number } | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);
  const closeNodePopup = useCallback(() => { setNodePopup(null); editor.clearNodeClick(); }, [editor]);
  // Live brush/pencil previews are published to small subscribed preview
  // components (BrushStrokePreview / PencilStrokePreview below) instead of
  // React state here, so a drawing frame doesn't re-render the full canvas.
  const brushTool = useBrushTool(hitScale, EXTERNAL_PREVIEW);
  const brushNodeTool = useBrushNodeTool(hitScale);
  const pencilTool = usePencilTool(hitScale, EXTERNAL_PREVIEW);
  // Brush tool, Node draw mode: same toolbar button as freehand Brush, just
  // captured Pen-tool style (see BrushDrawMode). Kept as its own flag rather
  // than switching `tool` to "pen" so it can never touch the real Pen
  // tool's state, and every `tool === "brush"` check elsewhere just needs
  // to additionally branch on this to pick which hook handles the pointer.
  const isNodeBrush = tool === "brush" && brushDrawMode === "node";
  const selectTool = useSelectTool(hitScale);

  // Track the SVG canvas size for viewBox math — must use the SVG element
  // directly so ruler inset (RULER_SIZE px) is already excluded.
  // We run a second observer below for canvasRect (ruler coord math), so this
  // one only needs w/h.
  useLayoutEffect(() => {
    // svgRef isn't set yet on first render; use a small timeout to let React
    // commit then observe. Alternatively, fall back to frameRef-based size
    // and subtract RULER_SIZE when ruler is on — simpler and synchronous.
    const el = frameRef.current;
    if (!el) return;
    const update = () => {
      const rulerOffset = showRuler ? RULER_SIZE : 0;
      setViewSize({ w: el.clientWidth - rulerOffset, h: el.clientHeight - rulerOffset });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showRuler]);

  const getFontPoint = useCallback(
    (e: { clientX: number; clientY: number }): Point | null =>
      svgRef.current ? clientToFontPoint(svgRef.current, e.clientX, e.clientY, ascender) : null,
    [ascender]
  );

  /** Select whatever object sits under the pointer (unless it is already part
   *  of the selection), then open the context menu there. */
  const openContextMenuAt = useCallback(
    (clientX: number, clientY: number) => {
      const p = getFontPoint({ clientX, clientY });
      const store = useAppStore.getState();
      if (p) {
        const tol = 6 * hitScale;
        const objs = editor.outline.objects;
        let hitId: string | null = null;
        for (let i = objs.length - 1; i >= 0; i--) {
          if (pointHitsObject(objs[i], p, tol)) { hitId = objs[i].id; break; }
        }
        if (hitId && !store.selectedObjectIds.includes(hitId)) {
          store.selectObjects(selectionUnitIds(editor.outline, hitId));
        }
      }
      setNodePopup(null);
      setCtxMenu({ x: clientX, y: clientY });
    },
    [getFontPoint, hitScale, editor.outline]
  );
  const longPress = useLongPress(openContextMenuAt);

  const applyZoomAt = useCallback(
    (newZoom: number, clientX: number, clientY: number) => {
      const rect = svgRef.current?.getBoundingClientRect() ?? frameRef.current?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) {
        useAppStore.setState({ zoom: Math.min(8000, Math.max(20, newZoom)) });
        return;
      }
      const state = useAppStore.getState();
      const upm = state.metrics.unitsPerEm;
      const totalH = state.metrics.ascender - state.metrics.descender;
      const fit = 0.62 * Math.min(rect.width / upm, rect.height / totalH);
      const oldScale = fit * (state.zoom / 100);
      const newScale = fit * (Math.min(8000, Math.max(20, newZoom)) / 100);
      const fx = (clientX - rect.left) / rect.width;
      const fy = (clientY - rect.top) / rect.height;
      const Px = state.pan.x + (fx - 0.5) * (rect.width / oldScale);
      const Py = state.pan.y + (fy - 0.5) * (rect.height / oldScale);
      const nvbW = rect.width / newScale;
      const nvbH = rect.height / newScale;
      const clamped = Math.min(8000, Math.max(20, newZoom));
      useAppStore.setState({ zoom: clamped, pan: { x: Px + (0.5 - fx) * nvbW, y: Py + (0.5 - fy) * nvbH } });
    },
    []
  );

  // Native, non-passive wheel: plain wheel (any direction, incl. Ctrl/Cmd or
  // trackpad pinch) zooms toward the cursor; hold Shift to pan instead.
  // Coalesce high-resolution trackpad events to one view update per frame.
  // Store scale in a ref so processWheel never needs to re-create.
  const scRef = useRef(sc);
  scRef.current = sc;
  const processWheel = useCallback((event: NonNullable<typeof pendingWheelRef.current>) => {
    const store = useAppStore.getState();
    if (event.shiftKey) {
      const dx = event.deltaX !== 0 ? event.deltaX : event.deltaY;
      store.setPan({ x: store.pan.x + dx / scRef.current, y: store.pan.y });
      return;
    }
    applyZoomAt(store.zoom * Math.exp(-event.deltaY * 0.0018), event.clientX, event.clientY);
  }, [applyZoomAt]);
  wheelProcessorRef.current = processWheel;

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const pending = pendingWheelRef.current;
      if (pending) {
        pending.deltaY += e.deltaY;
        pending.deltaX += e.deltaX;
        pending.clientX = e.clientX;
        pending.clientY = e.clientY;
        pending.shiftKey = e.shiftKey;
      } else {
        pendingWheelRef.current = {
          deltaY: e.deltaY,
          deltaX: e.deltaX,
          clientX: e.clientX,
          clientY: e.clientY,
          shiftKey: e.shiftKey,
        };
      }
      if (wheelRafRef.current !== null) return;
      wheelRafRef.current = requestAnimationFrame(() => {
        wheelRafRef.current = null;
        const next = pendingWheelRef.current;
        pendingWheelRef.current = null;
        if (next) wheelProcessorRef.current(next);
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelRafRef.current !== null) cancelAnimationFrame(wheelRafRef.current);
      wheelRafRef.current = null;
      pendingWheelRef.current = null;
    };
  }, []);

  // Fit: recompute zoom + pan so the glyph (or the em box) fills the view.
  useEffect(() => {
    if (fitNonce === 0 || !viewSize.w || !viewSize.h) return;
    const g = useAppStore.getState().glyphs[activeChar];
    const b = g ? outlineBounds(g.outline) : null;
    const box = b ?? { minX: 0, maxX: upm, minY: descender, maxY: ascender };
    const padU = upm * 0.12;
    const w = box.maxX - box.minX + padU * 2 || upm;
    const h = box.maxY - box.minY + padU * 2 || totalH;
    const targetScale = 0.95 * Math.min(viewSize.w / w, viewSize.h / h);
    const newZoom = Math.min(8000, Math.max(20, (targetScale / baseFit) * 100));
    setZoom(newZoom);
    setPan({ x: (box.minX + box.maxX) / 2, y: ascender - (box.minY + box.maxY) / 2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitNonce]);

  const usingHandPan = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => tool === "hand" || spacePanRef.current || e.button === 1,
    [tool]
  );

  // Multi-touch extras layered on top of the existing pointer pipeline:
  // pinch-to-zoom, 2/3-finger tap for undo/redo, and simple palm rejection.
  // Enabled in every mode (including Normal Mode) so 2/3-finger tap
  // undo/redo always works; single-finger draw/pan/tool handling below is
  // completely untouched since the hook only intercepts 2+ simultaneous
  // touch pointers and always returns false for mouse/pen/single-touch.
  const getZoomNow = useCallback(() => useAppStore.getState().zoom, []);
  const cancelActiveInteraction = useCallback(() => {
    brushTool.cancel();
    brushNodeTool.cancel();
    pencilTool.cancel();
    if (tool === "select") selectTool.pointerUp();
    else if (tool !== "brush" && tool !== "pencil") editor.pointerUp();
  }, [brushTool, brushNodeTool, pencilTool, selectTool, editor, tool]);
  // 2-finger drag pan: reuses the exact same hand-pan math as the "hand"
  // tool's single-pointer drag (panDragRef above), just driven by the
  // touch midpoint's frame-to-frame delta instead of a single pointer.
  const sketchPanBy = useCallback(
    (dxClient: number, dyClient: number) => {
      const store = useAppStore.getState();
      store.setPan({ x: store.pan.x - dxClient / sc, y: store.pan.y - dyClient / sc });
    },
    [sc]
  );
  const sketchGestures = useSketchGestures({
    enabled: true,
    applyZoomAt,
    getZoom: getZoomNow,
    onUndo: () => useAppStore.getState().undo(),
    onRedo: () => useAppStore.getState().redo(),
    onCancelActive: cancelActiveInteraction,
    onPanBy: sketchPanBy,
  });

  // Pointer events can arrive several times during one refresh interval.
  // Collect input cheaply and paint only the newest sample once per frame.
  const processPointerMove = useCallback(
    (sample: PointerMoveSample) => {
      if (sketchGestures.handlePointerMove(sample as unknown as PointerEvent)) return;
      const p = getFontPoint(sample);
      if (!p) return;
      // Hover is only rendered for Pen's rubber-band. Select's handle hover
      // has its own change guard in useSelectTool.
      if (tool === "pen" || isNodeBrush) hoverStore.set(p);
      if (panDragRef.current) {
        setPan({
          x: panDragRef.current.startPan.x - (sample.clientX - panDragRef.current.startClient.x) / sc,
          y: panDragRef.current.startPan.y - (sample.clientY - panDragRef.current.startClient.y) / sc,
        });
        return;
      }
      if (tool === "brush") return isNodeBrush ? brushNodeTool.pointerMove(p) : brushTool.pointerMove(p, sample);
      if (tool === "pencil") return pencilTool.pointerMove(p);
      if (tool === "select") return selectTool.pointerMove(p, sample.shiftKey, sample.pointerType, sample.metaKey);
      editor.pointerMove(p, sample.shiftKey, sample.altKey);
    },
    [sketchGestures, getFontPoint, tool, setPan, sc, brushTool, brushNodeTool, isNodeBrush, pencilTool, selectTool, editor, hoverStore]
  );
  pointerMoveProcessorRef.current = processPointerMove;

  const flushPointerMove = useCallback(() => {
    if (pointerMoveRafRef.current !== null) {
      cancelAnimationFrame(pointerMoveRafRef.current);
      pointerMoveRafRef.current = null;
    }
    const pending = pendingPointerMoveRef.current;
    pendingPointerMoveRef.current = null;
    if (pending) pointerMoveProcessorRef.current(pending);
  }, []);

  // Brush and Pencil strokes need EVERY input sample, not one per frame: a
  // pen or fast mouse reports far more positions than the screen repaints
  // (Apple Pencil: 240 Hz), and keeping only the newest per frame turned
  // quick curves into visible straight facets. While a brush/pencil stroke
  // is in progress, all coalesced samples go straight to the tool (each
  // throttles its own preview to one rebuild per frame).
  const brushDirectMoveRef = useRef<(e: PointerEvent) => boolean>(() => false);
  brushDirectMoveRef.current = (native: PointerEvent) => {
    const brushStroke = tool === "brush" && !isNodeBrush && brushTool.isDrawing;
    const pencilStroke = tool === "pencil" && pencilTool.isDrawing;
    if ((!brushStroke && !pencilStroke) || panDragRef.current) return false;
    if (sketchGestures.handlePointerMove(native)) return true;
    const coalesced = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    for (const ev of coalesced.length > 0 ? coalesced : [native]) {
      const p = getFontPoint(ev);
      if (!p) continue;
      if (brushStroke) brushTool.pointerMove(p, { pressure: ev.pressure, pointerType: ev.pointerType, timeStamp: ev.timeStamp });
      else pencilTool.pointerMove(p);
    }
    return true;
  };

  const queuePointerMove = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    if (brushDirectMoveRef.current(e.nativeEvent)) return;
    pendingPointerMoveRef.current = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      clientX: e.clientX,
      clientY: e.clientY,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey || e.ctrlKey,
      pressure: e.pressure,
    };
    if (pointerMoveRafRef.current !== null) return;
    pointerMoveRafRef.current = requestAnimationFrame(() => {
      pointerMoveRafRef.current = null;
      const pending = pendingPointerMoveRef.current;
      pendingPointerMoveRef.current = null;
      if (pending) pointerMoveProcessorRef.current(pending);
    });
  }, []);

  useEffect(() => () => {
    if (pointerMoveRafRef.current !== null) cancelAnimationFrame(pointerMoveRafRef.current);
    if (metricMoveRafRef.current !== null) cancelAnimationFrame(metricMoveRafRef.current);
    if (glyphMetricMoveRafRef.current !== null) cancelAnimationFrame(glyphMetricMoveRafRef.current);
    pointerMoveRafRef.current = null;
    metricMoveRafRef.current = null;
    glyphMetricMoveRafRef.current = null;
    pendingPointerMoveRef.current = null;
    pendingMetricClientYRef.current = null;
    pendingGlyphMetricClientXRef.current = null;
  }, []);

  useEffect(() => {
    if (tool !== "pen" && !isNodeBrush) hoverStore.set(null);
  }, [tool, isNodeBrush, hoverStore]);

  // Switching tools mid-gesture (keyboard shortcut while dragging, toolbar
  // tap with a second pointer…) used to leave the previous tool's drag
  // state alive, so the next pointer move kept dragging under the new tool.
  // The store's setTool already finalizes any pending liveOutline; here
  // every tool hook just drops its gesture bookkeeping. A brush/pencil
  // stroke in progress is abandoned, and an open Node-Brush path is
  // finished exactly like Escape would.
  const prevToolKeyRef = useRef({ tool, isNodeBrush });
  const toolResetRef = useRef<(prev: { tool: string; isNodeBrush: boolean }) => void>(() => {});
  toolResetRef.current = (prev) => {
    // Drop (don't replay) a move still queued for the previous tool.
    if (pointerMoveRafRef.current !== null) cancelAnimationFrame(pointerMoveRafRef.current);
    pointerMoveRafRef.current = null;
    pendingPointerMoveRef.current = null;
    panDragRef.current = null;
    activePointerIdRef.current = null;
    longPress.cancel();
    editor.reset();
    selectTool.reset();
    if (prev.tool === "brush" && !prev.isNodeBrush) brushTool.cancel();
    if (prev.tool === "pencil") pencilTool.cancel();
    if (prev.isNodeBrush) brushNodeTool.escape();
  };
  useEffect(() => {
    const prev = prevToolKeyRef.current;
    if (prev.tool === tool && prev.isNodeBrush === isNodeBrush) return;
    prevToolKeyRef.current = { tool, isNodeBrush };
    toolResetRef.current(prev);
  }, [tool, isNodeBrush]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      // Safari (unlike Chrome) will start a native drag-selection over the
      // SVG canvas on a plain mousedown+drag if nothing stops it — every
      // tool here begins with exactly that gesture (marquee-select,
      // pencil/pen strokes, node drags...). The visible result is Safari
      // painting the dragged region with `::selection`'s background,
      // which happens to be the app's bright accent green — read by users
      // as "the whole canvas turns green in Safari". preventDefault()
      // here, together with `user-select: none` on the canvas frame in
      // CSS, stops that selection from ever starting.
      e.preventDefault();
      flushPointerMove();
      // Right mouse button only opens the context menu (see onContextMenu);
      // it must never draw / place nodes / start a drag.
      if (e.pointerType === "mouse" && e.button === 2) return;
      if (sketchGestures.handlePointerDown(e)) { longPress.cancel(); return; }
      const p = getFontPoint(e);
      if (!p) return;
      // Touch / pen long-press -> context menu, only for Select/Node (the
      // drawing tools would otherwise lose a stroke while the finger rests).
      if (tool === "select" || tool === "node") longPress.begin(e);
      (e.target as Element).setPointerCapture?.(e.pointerId);
      activePointerIdRef.current = e.pointerId;
      if (usingHandPan(e)) {
        panDragRef.current = { startClient: { x: e.clientX, y: e.clientY }, startPan: pan };
        return;
      }
      if (tool === "zoom") return applyZoomAt(zoom * (e.shiftKey ? 0.8 : 1.25), e.clientX, e.clientY);
      if (tool === "brush") return isNodeBrush ? brushNodeTool.pointerDown(p) : brushTool.pointerDown(p, e);
      if (tool === "pencil") return pencilTool.pointerDown(p);
      if (tool === "select") return selectTool.pointerDown(p, e.shiftKey, e.metaKey || e.ctrlKey || (drawMode && e.altKey));
      editor.pointerDown(p, e.shiftKey, e.altKey, e.metaKey || e.ctrlKey);
    },
    [getFontPoint, tool, editor, brushTool, brushNodeTool, isNodeBrush, pencilTool, selectTool, pan, zoom, applyZoomAt, usingHandPan, sketchGestures, flushPointerMove, longPress]
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    longPress.move(e);
    queuePointerMove(e);
  }, [longPress, queuePointerMove]);

  // pointerup reaches BOTH the SVG's onPointerUp and the window listener
  // below (which exists to catch releases outside the canvas). Running the
  // whole release path twice meant two tool pointerUp calls per click —
  // harmless only by accident. The SVG handler marks the native event and
  // the window listener skips anything already handled.
  const handledPointerUpsRef = useRef(new WeakSet<Event>());
  const pointerUpHandlerRef = useRef<(e: PointerEvent | ReactPointerEvent<SVGSVGElement>) => void>(() => {});
  pointerUpHandlerRef.current = (e) => {
    if (e.pointerId === activePointerIdRef.current) activePointerIdRef.current = null;
    lastUpRef.current = { x: e.clientX, y: e.clientY };
    longPress.cancel();
    flushPointerMove();
    sketchGestures.handlePointerUp(e);
    panDragRef.current = null;
    if (tool === "brush") return isNodeBrush ? brushNodeTool.pointerUp() : brushTool.pointerUp();
    if (tool === "pencil") return pencilTool.pointerUp();
    if (tool === "select") return selectTool.pointerUp();
    editor.pointerUp();
  };
  const onPointerUp = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    handledPointerUpsRef.current.add(e.nativeEvent);
    pointerUpHandlerRef.current(e);
  }, []);

  const onContextMenu = useCallback((e: ReactMouseEvent<SVGSVGElement>) => {
    // Replaces the browser menu on right-click; also swallows the native
    // long-press menu some touch browsers fire so ours is the only one.
    e.preventDefault();
    longPress.cancel();
    if (tool === "brush" || tool === "pencil" || tool === "pen" || tool === "hand" || tool === "zoom") {
      if (e.nativeEvent instanceof PointerEvent && e.nativeEvent.pointerType !== "mouse") return;
    }
    openContextMenuAt(e.clientX, e.clientY);
  }, [tool, longPress, openContextMenuAt]);

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      const p = getFontPoint(e);
      if (!p) return;

      if (tool === "pen") {
        // Double-click on the current endpoint commits the open path.
        if (editor.isCurrentEndpoint(p)) { editor.finishOpenContour(); return; }
        // Double-click outside any vector object → escape to Select.
        const tol = 6 * hitScale;
        const hitAny = editor.outline.objects.some((obj) => pointHitsObject(obj, p, tol));
        if (!hitAny) setTool("select");
        return;
      }

      if (isNodeBrush) {
        // Double-click commits the open node-drawn path, exactly like the
        // Pen tool's endpoint double-click above.
        if (brushNodeTool.liveNodes.length >= 2) { brushNodeTool.finishOpen(); return; }
        const tol = 6 * hitScale;
        const hitAny = editor.outline.objects.some((obj) => pointHitsObject(obj, p, tol));
        if (!hitAny) setTool("select");
        return;
      }

      if (tool === "select") {
        // Double-clicking an object jumps straight into editing its nodes —
        // matching the "double-click to enter node mode" behavior of
        // professional vector editors.
        const tol = 6 * hitScale;
        for (let i = editor.outline.objects.length - 1; i >= 0; i--) {
          const obj = editor.outline.objects[i];
          if (!pointHitsObject(obj, p, tol)) continue;
          const refs = obj.contours.flatMap((c) => c.nodes.map((n) => ({ contourId: c.id, nodeId: n.id })));
          // Keep this object marked as selected so Node mode knows it's the
          // only object whose nodes should be active (see useGlyphEditor's
          // nodeableOutline / setTool in the store).
          selectObjects([obj.id]);
          setTool("node");
          selectNodes(refs);
          return;
        }
        return;
      }

      // Double-click outside any vector object in brush/pencil/node tool
      // → switch to Select. Quick escape without touching the toolbar.
      if (tool === "brush" || tool === "pencil" || tool === "node") {
        const tol = 6 * hitScale;
        const hitAny = editor.outline.objects.some((obj) => pointHitsObject(obj, p, tol));
        if (!hitAny) {
          setTool("select");
          return;
        }
      }

      if (tool !== "node") return;
      const hitR = 12 * hitScale;
      // Only the active (selected) object's nodes/segments are live in Node
      // mode — editor.nodeableOutline is already filtered to that, so a
      // double-click near another object's node can't cycle/insert on it.
      const hit = editor.nodeableOutline.objects.some((o) =>
        o.contours.some((c) => c.nodes.some((n) => Math.hypot(n.point.x - p.x, n.point.y - p.y) <= hitR))
      );
      // double-click a node -> cycle type; a segment -> insert a node;
      // otherwise, double-clicking inside an object's body backs out to
      // select mode with that object selected — the reverse of select
      // mode's "double-click an object to jump into its nodes".
      if (hit) {
        for (const o of editor.nodeableOutline.objects)
          for (const c of o.contours)
            for (const n of c.nodes)
              if (Math.hypot(n.point.x - p.x, n.point.y - p.y) <= hitR) return editor.cycleNodeType(c.id, n.id);
      }
      const segHit = hitTestSegments(editor.nodeableOutline, p, 10 * hitScale * 1.8);
      if (segHit) {
        editor.insertNodeAt(p);
        return;
      }
      for (let i = editor.outline.objects.length - 1; i >= 0; i--) {
        const obj = editor.outline.objects[i];
        if (!pointHitsObject(obj, p, 6 * hitScale)) continue;
        setTool("select");
        selectObjects([obj.id]);
        return;
      }
    },
    [tool, isNodeBrush, brushNodeTool, getFontPoint, editor, hitScale, setTool, selectNodes, selectObjects]
  );

  // pointercancel (the OS/browser took the pointer away: palm rejection,
  // a system gesture…) must NOT run the commit path of pointerup — but it
  // must still end the gesture, or the tool stays stuck mid-drag. The
  // interrupted gesture is abandoned: live edits are discarded and an
  // in-progress brush/pencil stroke is dropped.
  const pointerCancelHandlerRef = useRef<(e: PointerEvent) => void>(() => {});
  pointerCancelHandlerRef.current = (e) => {
    longPress.cancel();
    sketchGestures.handlePointerUp(e);
    // Only the pointer that owns the gesture cancels it (a stray second
    // touch that was rejected by palm/gesture handling is irrelevant).
    if (activePointerIdRef.current === null || e.pointerId !== activePointerIdRef.current) return;
    activePointerIdRef.current = null;
    if (pointerMoveRafRef.current !== null) cancelAnimationFrame(pointerMoveRafRef.current);
    pointerMoveRafRef.current = null;
    pendingPointerMoveRef.current = null;
    panDragRef.current = null;
    if (tool === "brush") return isNodeBrush ? brushNodeTool.endDrag() : brushTool.cancel();
    if (tool === "pencil") return pencilTool.cancel();
    if (tool === "select") return selectTool.cancel();
    editor.cancel();
  };

  // Registered once; the handlers themselves live in refs so these listeners
  // are never torn down and re-added on every render (which used to happen
  // on every live drag frame).
  useEffect(() => {
    const handled = handledPointerUpsRef.current;
    function onWindowPointerUp(e: PointerEvent) {
      if (handled.has(e)) return;
      pointerUpHandlerRef.current(e);
    }
    function onWindowPointerCancel(e: PointerEvent) {
      pointerCancelHandlerRef.current(e);
    }
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerCancel);
    return () => {
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerCancel);
    };
  }, []);

  // A plain click on a node (Node tool) -> Corner / Smooth / Symmetric popup.
  useEffect(() => {
    const click = editor.nodeClick;
    if (!click) return;
    const at = lastUpRef.current;
    if (tool === "node" && at) setNodePopup({ x: at.x, y: at.y, ref: click.ref });
    editor.clearNodeClick();
  }, [editor.nodeClick, editor, tool]);
  useEffect(() => { if (tool !== "node") setNodePopup(null); }, [tool]);

  // Holding an arrow key auto-repeats node nudges; the first nudge of a
  // press opens a glyph-edit bracket so the whole hold is ONE undo step
  // (closed on key release / window blur).
  const nudgeBracketOpenRef = useRef(false);
  const endNudgeBracket = useCallback(() => {
    if (!nudgeBracketOpenRef.current) return;
    nudgeBracketOpenRef.current = false;
    useAppStore.getState().endGlyphEdit();
  }, []);
  const keyDownHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyDownHandlerRef.current = (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (e.code === "Space") {
      spacePanRef.current = true;
      // Space is the temporary-pan modifier here; without this the page (or
      // a focused toolbar button) also scrolls / "clicks" on Space.
      if (!isFormField(e.target) && !(t && (t.tagName === "BUTTON" || t.getAttribute("role") === "button"))) e.preventDefault();
    }
    if (e.key === "Escape") {
      editor.finishOpenContour();
      brushTool.cancel();
      if (isNodeBrush) brushNodeTool.escape();
      pencilTool.cancel();
    }
    if (tool === "node") {
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); editor.deleteSelectedNodes(); }
      const step = e.shiftKey ? 10 : 1;
      const delta =
        e.key === "ArrowLeft" ? { x: -step, y: 0 }
        : e.key === "ArrowRight" ? { x: step, y: 0 }
        : e.key === "ArrowUp" ? { x: 0, y: step }
        : e.key === "ArrowDown" ? { x: 0, y: -step }
        : null;
      if (delta) {
        e.preventDefault();
        if (editor.selectedNodes.length > 0 && !nudgeBracketOpenRef.current) {
          nudgeBracketOpenRef.current = true;
          useAppStore.getState().beginGlyphEdit();
        }
        editor.nudgeNodes(delta.x, delta.y);
      }
    }
  };
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) { keyDownHandlerRef.current(e); }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") spacePanRef.current = false;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") endNudgeBracket();
    }
    // A Space (or arrow) released while the window is unfocused never
    // delivers its keyup — reset so the canvas doesn't stay stuck in
    // hand-pan mode after e.g. Cmd+Tab while holding Space.
    function onBlur() {
      spacePanRef.current = false;
      endNudgeBracket();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      endNudgeBracket();
    };
  }, [endNudgeBracket]);

  const beginGuideDrag = useCallback(
    (key: MetricGuideKey, e: ReactPointerEvent<SVGLineElement>) => {
      if (tool !== "home" || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      beginMetricDrag();
      // These are the only fields MetricGuideKey ever names, so this small
      // local lookup replaces the old `metrics[key]` without needing the
      // whole `metrics` object as a dependency (see the selector note above).
      const guideValues: Record<MetricGuideKey, number> = { ascender, capHeight, xHeight, baseline, descender };
      metricDragRef.current = {
        key,
        startClientY: e.clientY,
        startValue: guideValues[key],
        startScale: sc,
      };
      setActiveMetricGuide(key);
    },
    [tool, beginMetricDrag, ascender, capHeight, xHeight, baseline, descender, sc]
  );

  const moveGuideDrag = useCallback(
    (e: ReactPointerEvent<SVGLineElement>) => {
      const drag = metricDragRef.current;
      if (!drag || tool !== "home") return;
      e.preventDefault();
      e.stopPropagation();
      pendingMetricClientYRef.current = e.clientY;
      if (metricMoveRafRef.current !== null) return;
      metricMoveRafRef.current = requestAnimationFrame(() => {
        metricMoveRafRef.current = null;
        const activeDrag = metricDragRef.current;
        const clientY = pendingMetricClientYRef.current;
        pendingMetricClientYRef.current = null;
        if (!activeDrag || clientY === null) return;
        const deltaUnits = -(clientY - activeDrag.startClientY) / Math.max(activeDrag.startScale, 0.0001);
        setFontMetricLive(activeDrag.key, activeDrag.startValue + deltaUnits);
      });
    },
    [tool, setFontMetricLive]
  );

  const finishGuideDrag = useCallback(
    (e: ReactPointerEvent<SVGLineElement>) => {
      if (!metricDragRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      if (metricMoveRafRef.current !== null) cancelAnimationFrame(metricMoveRafRef.current);
      metricMoveRafRef.current = null;
      const drag = metricDragRef.current;
      const clientY = pendingMetricClientYRef.current;
      pendingMetricClientYRef.current = null;
      if (drag && clientY !== null) {
        const deltaUnits = -(clientY - drag.startClientY) / Math.max(drag.startScale, 0.0001);
        setFontMetricLive(drag.key, drag.startValue + deltaUnits);
      }
      metricDragRef.current = null;
      endMetricDrag();
      setActiveMetricGuide(null);
    },
    [endMetricDrag]
  );

  const focusGuideMetric = useCallback(
    (key: MetricGuideKey, e: ReactMouseEvent<SVGLineElement>) => {
      if (tool !== "home") return;
      e.preventDefault();
      e.stopPropagation();
      setMetricFocus(key);
    },
    [tool, setMetricFocus]
  );

  const beginGlyphGuideDrag = useCallback(
    (key: GlyphMetricKey, e: ReactPointerEvent<SVGElement>) => {
      if (tool !== "home" || e.button !== 0 || !glyph) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      beginGlyphMetricDrag();
      glyphMetricDragRef.current = {
        key,
        startClientX: e.clientX,
        startValue: glyph[key],
        startScale: sc,
      };
      setActiveGlyphMetricGuide(key);
    },
    [tool, glyph, beginGlyphMetricDrag, sc]
  );

  const moveGlyphGuideDrag = useCallback(
    (e: ReactPointerEvent<SVGElement>) => {
      const drag = glyphMetricDragRef.current;
      if (!drag || tool !== "home" || !glyph) return;
      e.preventDefault();
      e.stopPropagation();
      pendingGlyphMetricClientXRef.current = e.clientX;
      if (glyphMetricMoveRafRef.current !== null) return;
      glyphMetricMoveRafRef.current = requestAnimationFrame(() => {
        glyphMetricMoveRafRef.current = null;
        const activeDrag = glyphMetricDragRef.current;
        const clientX = pendingGlyphMetricClientXRef.current;
        pendingGlyphMetricClientXRef.current = null;
        if (!activeDrag || clientX === null) return;
        const deltaUnits = (clientX - activeDrag.startClientX) / Math.max(activeDrag.startScale, 0.0001);
        setGlyphMetricLive(activeChar, activeDrag.key, activeDrag.startValue + deltaUnits);
      });
    },
    [tool, glyph, activeChar, setGlyphMetricLive]
  );

  const finishGlyphGuideDrag = useCallback(
    (e: ReactPointerEvent<SVGElement>) => {
      if (!glyphMetricDragRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      if (glyphMetricMoveRafRef.current !== null) cancelAnimationFrame(glyphMetricMoveRafRef.current);
      glyphMetricMoveRafRef.current = null;
      const drag = glyphMetricDragRef.current;
      const clientX = pendingGlyphMetricClientXRef.current;
      pendingGlyphMetricClientXRef.current = null;
      if (drag && clientX !== null) {
        const deltaUnits = (clientX - drag.startClientX) / Math.max(drag.startScale, 0.0001);
        setGlyphMetricLive(activeChar, drag.key, drag.startValue + deltaUnits);
      }
      glyphMetricDragRef.current = null;
      endGlyphMetricDrag();
      setActiveGlyphMetricGuide(null);
    },
    [activeChar, endGlyphMetricDrag, setGlyphMetricLive]
  );

  const focusGlyphGuideMetric = useCallback(
    (key: GlyphMetricKey, e: ReactMouseEvent<SVGElement>) => {
      if (tool !== "home") return;
      e.preventDefault();
      e.stopPropagation();
      setGlyphMetricFocus(key);
    },
    [tool, setGlyphMetricFocus]
  );

  const metricGuides: { key: MetricGuideKey; label: string; value: number; className: string }[] = [
    { key: "ascender", label: "Ascender", value: ascender, className: "metric-ascender" },
    { key: "capHeight", label: "Cap Height", value: capHeight, className: "metric-cap" },
    { key: "xHeight", label: "x-Height", value: xHeight, className: "metric-xheight" },
    { key: "baseline", label: "Baseline", value: baseline, className: "metric-baseline" },
    { key: "descender", label: "Descender", value: descender, className: "metric-descender" },
  ];

  const toY = (val: number) => ascender - val;
  const objects = editor.outline.objects;
  const renderOutline = liveOutline ?? glyph?.outline ?? { objects: [] };
  const visualObjects = renderOutline.objects;
  // (Outline-Brush boolean merge during live gestures: see
  // useOutlineBrushMerge in ObjectsLayer.)
  // Select-tool move/rotate/scale/skew drag: render every object whose look
  // is exactly affine-equivariant from its UNCHANGED base object plus an SVG
  // transform (see transformPreview.ts), so its memoized path / brush
  // outline isn't rebuilt every frame. Everything else renders the live
  // geometry exactly as before.
  const dragPreview = tool === "select" && liveOutline ? selectTool.dragPreview : null;
  const transformedRender = useMemo(() => {
    if (!dragPreview || !liveOutline) return null;
    const liveById = new Map<string, VectorObject>();
    for (const o of liveOutline.objects) if (dragPreview.ids.has(o.id)) liveById.set(o.id, o);
    const transformedIds = new Set<string>();
    const renderObjects = dragPreview.baseObjects.map((o) => {
      if (!dragPreview.ids.has(o.id)) return o;
      if (transformPreviewIsExact(o, dragPreview.kind)) {
        transformedIds.add(o.id);
        return o;
      }
      return liveById.get(o.id) ?? o;
    });
    // Sanity: the preview must describe exactly the live outline's objects
    // (same ids, same order); otherwise just render the live geometry.
    if (renderObjects.length !== liveOutline.objects.length) return null;
    for (let i = 0; i < renderObjects.length; i++) if (renderObjects[i].id !== liveOutline.objects[i].id) return null;
    return { renderObjects, transformedIds, matrix: affineToSvgMatrix(dragPreview.matrix, ascender) };
  }, [dragPreview, liveOutline, ascender]);
  const objectsForRender = transformedRender ? transformedRender.renderObjects : liveOutline ? visualObjects : objects;

  // Overlap highlighting is O(objects² × segments²) in the worst case. It is
  // hidden during live gestures anyway, so it is only (re)computed once the
  // outline settles, in idle time, never synchronously on mount or on every
  // drag frame. Flattened geometry is cached per object (overlapDetect.ts).
  const [overlappingIds, setOverlappingIds] = useState<ReadonlySet<string>>(EMPTY_ID_SET);
  const lastOverlapObjectsRef = useRef<VectorObject[] | null>(null);
  useEffect(() => {
    if (liveOutline) return;
    if (objects === lastOverlapObjectsRef.current) return;
    const target = objects;
    return scheduleIdle(() => {
      lastOverlapObjectsRef.current = target;
      const next = findOverlappingObjectIds(target);
      setOverlappingIds((prev) => (sameIdSet(prev, next) ? prev : next));
    }, 300);
  }, [objects, liveOutline]);

  // Stable (memoized) inputs for the memoized node/handle layer — inline
  // literals here used to bust its memo on every canvas render.
  const brushNodeLiveNodes = brushNodeTool.liveNodes;
  const brushNodePreviewOutline = useMemo<GlyphOutline | null>(
    () => (brushNodeLiveNodes.length > 0 ? brushNodePreviewOutlineFor(brushNodeLiveNodes) : null),
    [brushNodeLiveNodes]
  );
  const roundCornerContourId = editor.roundCornerLabel?.contourId;
  const roundCornerPoint = editor.roundCornerLabel?.cornerPoint;
  const activeRoundCorner = useMemo(
    () => (roundCornerContourId && roundCornerPoint ? { contourId: roundCornerContourId, cornerPoint: roundCornerPoint } : undefined),
    [roundCornerContourId, roundCornerPoint]
  );

  const selBounds = tool === "select" ? selectTool.bounds : null;
  const handlePts = useMemo(
    () => (selBounds ? handlePositions(selBounds, selectTool.rotateOffset, selectTool.skewOffset) : null),
    [selBounds, selectTool.rotateOffset, selectTool.skewOffset]
  );

  const cursorClass =
    isNodeBrush ? "cursor-pen"
    : tool === "pen" ? "cursor-pen"
    : tool === "node" ? "cursor-node"
    : tool === "shape" ? "cursor-shape"
    : tool === "hand" ? "cursor-hand"
    : tool === "zoom" ? "cursor-zoom"
    : tool === "brush" ? "cursor-brush"
    : tool === "pencil" ? "cursor-pencil"
    : tool === "select" && selectTool.hoverHandle ? handleCursor(selectTool.hoverHandle)
    : "cursor-select";

  // Track the SVG canvas bounding rect for ruler coordinate math.
  const [canvasRect, setCanvasRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const update = () => setCanvasRect(el.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Grid and metrics belong only to the editable center canvas. Ghost lanes
  // intentionally contain glyph shapes only.
  const ghostOn = ghost.enabled && !drawMode;

  return (
    <div className="fm-canvas-frame" ref={frameRef}>
      {showRuler && (
        <CanvasRuler
          scale={sc}
          vbX={vbX} vbY={vbY}
          vbW={vbW} vbH={vbH}
          ascender={ascender}
          canvasRect={canvasRect}
        />
      )}
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        className={cursorClass}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        style={{
          touchAction: "none",
          // Zoom-dependent CSS sizes read this variable (see the static
          // stylesheet below), so zooming only changes one custom property
          // instead of regenerating and re-parsing the whole <style> text.
          ["--sc" as string]: sc,
          ...(showRuler ? { position: "absolute", top: RULER_SIZE, left: RULER_SIZE, width: `calc(100% - ${RULER_SIZE}px)`, height: `calc(100% - ${RULER_SIZE}px)` } : {}),
        }}
      >
        <style>{EDITOR_CANVAS_CSS_SCALED_BY_VAR}</style>

        <defs>
          <clipPath id="fontseru-main-canvas" clipPathUnits="userSpaceOnUse">
            <rect x={drawMode ? vbX : 0} y={vbY} width={drawMode ? vbW : upm} height={vbH} />
          </clipPath>
          <clipPath id="ghost-reference-left" clipPathUnits="userSpaceOnUse">
            <rect x={-upm} y={vbY} width={upm} height={vbH} />
          </clipPath>
          <clipPath id="ghost-reference-right" clipPathUnits="userSpaceOnUse">
            <rect x={upm} y={vbY} width={upm} height={vbH} />
          </clipPath>
        </defs>

        {ghostOn && glyph && ghost.mode === "sample" && !isFeatureGlyphUnicode(glyph.unicode) && (
          <g
            data-testid="ghost-reference-canvas"
            data-ghost-mode="sample"
            pointerEvents="none"
          >
            <GhostGlyph
              mode="sample"
              char={glyph.char}
              ascender={ascender}
              capHeight={capHeight}
              upm={upm}
              opacity={ghost.opacity}
              scale={ghost.scale}
              offsetX={ghost.offsetX}
              offsetY={ghost.offsetY}
              centerX={ghostCenterX}
            />
          </g>
        )}

        {ghostOn && glyph && ghost.mode === "family" && (
          <g
            data-testid="ghost-reference-canvas"
            data-ghost-mode="family"
            pointerEvents="none"
          >
            <g
              clipPath="url(#ghost-reference-left)"
              data-testid="ghost-reference-left"
              data-family-style={leftGhostStyle}
            >
              <GhostGlyph
                mode="family"
                char={glyph.char}
                glyph={leftFamilyGlyph}
                ascender={ascender}
                capHeight={capHeight}
                upm={upm}
                opacity={ghost.opacity}
                scale={ghost.scale}
                offsetX={ghost.offsetX}
                offsetY={ghost.offsetY}
                laneOffsetX={-upm}
              />
            </g>
            <g
              clipPath="url(#ghost-reference-right)"
              data-testid="ghost-reference-right"
              data-family-style={rightGhostStyle}
            >
              <GhostGlyph
                mode="family"
                char={glyph.char}
                glyph={rightFamilyGlyph}
                ascender={ascender}
                capHeight={capHeight}
                upm={upm}
                opacity={ghost.opacity}
                scale={ghost.scale}
                offsetX={ghost.offsetX}
                offsetY={ghost.offsetY}
                laneOffsetX={upm}
              />
            </g>
          </g>
        )}

 {ghostOn && glyph && ghost.mode === "image" && ghost.imageSrc && (
          <g
            data-testid="ghost-reference-canvas"
            data-ghost-mode="image"
            pointerEvents="none"
          >
            <GhostGlyph
              mode="image"
              char={glyph.char}
              ascender={ascender}
              capHeight={capHeight}
              upm={upm}
              opacity={ghost.opacity}
              scale={ghost.scale}
              offsetX={ghost.offsetX}
              offsetY={ghost.offsetY}
              centerX={ghostCenterX}
              totalH={totalH}
              imageSrc={ghost.imageSrc}
              imageAspect={ghost.imageAspect}
            />
          </g>
        )}

        {showGrid && (
          <GridLayer shape={gridShape} size={gridSize} sc={sc} ascender={ascender} vbX={vbX} vbY={vbY} vbW={vbW} vbH={vbH} />
        )}

        <g clipPath="url(#fontseru-main-canvas)">
        <>
          {metricGuides.filter(({ key }) => key === "baseline" || (showGuides && !drawMode)).map(({ key, label, value, className }) => {
            const trueY = toY(value);
            // Same visual clamp as Advance/LSB/RSB below: if the guide is
            // dragged above/below the current viewport, pin its rendered
            // line to the near edge instead of letting it vanish off-
            // screen. Purely visual — `value`/drag math stay unclamped.
            const marginY = 20 / sc;
            const y = Math.min(vbY + vbH - marginY, Math.max(vbY + marginY, trueY));
            const active = activeMetricGuide === key;
            const labelX = (drawMode ? vbX : Math.max(0, vbX)) + 10 / sc;
            const guideX1 = drawMode ? vbX : 0;
            const guideX2 = drawMode ? vbX + vbW : upm;
            return (
              <g key={key} className={`metric-guide ${className} ${active ? "active" : ""} ${tool === "home" ? "" : "locked"}`} data-testid={`font-guide-${key}`}>
                <line x1={guideX1} y1={y} x2={guideX2} y2={y} className="metric-guide-line" pointerEvents="none" />
                <line
                  x1={guideX1}
                  y1={y}
                  x2={guideX2}
                  y2={y}
                  className="metric-guide-hit"
                  pointerEvents={tool === "home" ? "stroke" : "none"}
                  onPointerDown={(e) => beginGuideDrag(key, e)}
                  onPointerMove={moveGuideDrag}
                  onPointerUp={finishGuideDrag}
                  onPointerCancel={finishGuideDrag}
                  onLostPointerCapture={finishGuideDrag}
                  onDoubleClick={(e) => focusGuideMetric(key, e)}
                  data-metric={key}
                />
                <text x={labelX} y={y - 6 / sc} className="guide-label" pointerEvents="none">{label}</text>
                {active && (
                  <g pointerEvents="none" data-testid="metric-drag-value">
                    <rect x={labelX} y={y + 5 / sc} width={72 / sc} height={20 / sc} rx={4 / sc} className="metric-guide-value-bg" />
                    <text x={labelX + 7 / sc} y={y + 19 / sc} className="metric-guide-value">{Math.round(value)}u</text>
                  </g>
                )}
              </g>
            );
          })}
        </>
        </g>

        {/* LSB/Advance/RSB handles render OUTSIDE the main-canvas clip and
            get their on-screen x clamped to the current viewport (not the
            em-square). Two separate problems this fixes:
             1) Long feature glyphs (ligatures/swashes) often have an
                advanceWidth well past `upm`, so Advance/RSB used to sit
                inside the `fontseru-main-canvas` clip and get silently cut
                off past x=upm even when zoomed/panned to show them.
             2) Dragging any of the three far enough could push the handle
                past the current viewport edge, off-screen with no visual
                feedback.
            Clamping is purely visual — `guide.value`/the drag math both
            keep using the true, unclamped position, so nothing about the
            canvas/viewport itself changes; the handle just stays pinned at
            the edge, like an off-screen indicator, until you pan/zoom back
            to its real position. */}
        {showGuides && glyph && !drawMode && (() => {
          const top = vbY + 14 / sc;
          const handleW = 86 / sc;
          const handleH = 20 / sc;
          const lsbX = glyph.lsb;
          const advanceX = glyph.advanceWidth;
          const marginX = handleW / 2 + 4 / sc;
          const clampX = (x: number) => Math.min(vbX + vbW - marginX, Math.max(vbX + marginX, x));
          const lsbXView = clampX(lsbX);
          const advanceXView = clampX(advanceX);
          const originXView = clampX(0);
          const isAuto = autoSpacingEnabled;
          const guides: { key: GlyphMetricKey; label: string; value: number; x: number; y: number; advance?: boolean }[] = [
            { key: "lsb", label: "LSB", value: glyph.lsb, x: lsbXView, y: top },
            { key: "advanceWidth", label: "Advance", value: glyph.advanceWidth, x: advanceXView, y: top, advance: true },
            // RSB moves the same physical right advance boundary, but gets
            // its own drag handle and numeric value just below Advance.
            { key: "rsb", label: "RSB", value: glyph.rsb, x: advanceXView, y: top + 24 / sc },
          ];
          return (
            <>
              {/* Origin (x=0): the fixed left boundary of glyph space that
                  LSB is measured *from*. Solid + its own hue + a small "0"
                  flag near the baseline, so the left edge of the glyph box
                  always has an explicit, unmistakable mark — separate from
                  the draggable, dashed LSB guide right next to it. */}
              <line x1={originXView} y1={vbY} x2={originXView} y2={vbY + vbH} className="origin-line" pointerEvents="none" />
              <g pointerEvents="none" data-testid="glyph-origin-mark">
                <rect x={originXView - 9 / sc} y={vbY + vbH - 20 / sc} width={18 / sc} height={16 / sc} rx={3 / sc} className="origin-flag-bg" />
                <text x={originXView} y={vbY + vbH - 8.5 / sc} textAnchor="middle" className="origin-flag-label">0</text>
              </g>

              <line x1={lsbXView} y1={vbY} x2={lsbXView} y2={vbY + vbH} className="glyph-metric-guide-line" pointerEvents="none" />
              <line x1={advanceXView} y1={vbY} x2={advanceXView} y2={vbY + vbH} className="glyph-metric-guide-line advance" pointerEvents="none" />
              {guides.map((guide) => {
                const active = activeGlyphMetricGuide === guide.key;
                const rectX = guide.x - handleW / 2;
                const showAutoBadge = isAuto && !guide.advance;
                return (
                  <g key={guide.key} data-testid={`glyph-guide-${guide.key}`}>
                    <rect
                      x={rectX}
                      y={guide.y}
                      width={handleW}
                      height={handleH}
                      rx={4 / sc}
                      className={`glyph-metric-handle ${guide.advance ? "advance" : ""} ${showAutoBadge ? "auto" : ""} ${active ? "active" : ""} ${tool === "home" ? "" : "locked"}`}
                      pointerEvents={tool === "home" ? "all" : "none"}
                      onPointerDown={(e) => beginGlyphGuideDrag(guide.key, e)}
                      onPointerMove={moveGlyphGuideDrag}
                      onPointerUp={finishGlyphGuideDrag}
                      onPointerCancel={finishGlyphGuideDrag}
                      onLostPointerCapture={finishGlyphGuideDrag}
                      onDoubleClick={(e) => focusGlyphGuideMetric(guide.key, e)}
                    />
                    {showAutoBadge && <circle cx={rectX + 8 / sc} cy={guide.y + handleH / 2} r={2.6 / sc} className="glyph-metric-auto-dot" pointerEvents="none" />}
                    <text
                      x={guide.x}
                      y={guide.y + 13.5 / sc}
                      textAnchor="middle"
                      className="glyph-metric-label"
                    >
                      {guide.label} {Math.round(guide.value)}
                    </text>
                  </g>
                );
              })}
            </>
          );
        })()}

        {/* Each object is its OWN path — overlapping/touching objects never subtract.
            Extracted into a memoized layer so mouse-move-only state changes in this
            component (hover, live pointer tracking) never force every object's path
            string to be rebuilt from scratch — the part that used to make dragging
            or even just moving the mouse feel "stuck" after pasting a large vector. */}
        <ObjectsLayer
          objects={objectsForRender}
          ascender={ascender}
          tool={tool}
          penAutoCloseShape={penAutoCloseShape}
          drawingContourId={editor.drawingContourId}
          selectedObjectIds={selectedObjectIds}
          overlappingIds={liveOutline ? EMPTY_ID_SET : overlappingIds}
          live={liveOutline !== null}
          transformedIds={transformedRender?.transformedIds}
          transformMatrix={transformedRender?.matrix}
        />

        {/* Brush silhouette preview (true nib/taper outline) */}
        <BrushStrokePreview store={brushTool.previewStore} ascender={ascender} size={brush.size} cap={brushCap} />

        {/* Brush tool, Node draw mode: live preview of the path placed so
            far — see BrushNodeLivePreview. */}
        {isNodeBrush && (
          <BrushNodeLivePreview
            outline={brushNodeTool.previewOutline}
            strokeObject={brushNodeTool.previewStrokeObject}
            ascender={ascender}
          />
        )}

        {/* Pencil preview: the live curve-fit result, shown both as the
            open gesture drawn so far AND — faintly — as it will land once
            closed, so the eventual auto-close never comes as a surprise. */}
        <PencilStrokePreview store={pencilTool.previewStore} ascender={ascender} hitScale={hitScale} />

        {/* Pen rubber-band */}
        {tool === "pen" && editor.drawingContourId && (
          <HoverRubberBand store={hoverStore} outline={editor.outline} contourId={editor.drawingContourId} ascender={ascender} hitScale={hitScale} />
        )}

        {/* Brush Node draw mode rubber-band — same idea as Pen's, tracking
            brushNodeTool's own in-progress path instead of the shared
            editor outline. */}
        {isNodeBrush && brushNodePreviewOutline && (
          <HoverRubberBand
            store={hoverStore}
            outline={brushNodePreviewOutline}
            contourId="brush-node-preview-contour"
            ascender={ascender}
            hitScale={hitScale}
          />
        )}

        {/* Node-tool marquee */}
        {editor.marqueeRect && (
          <rect x={editor.marqueeRect.x} y={ascender - (editor.marqueeRect.y + editor.marqueeRect.h)}
            width={editor.marqueeRect.w} height={editor.marqueeRect.h} className="marquee-rect" />
        )}

        {/* Select-tool marquee */}
        {selectTool.marqueeRect && (
          <rect x={selectTool.marqueeRect.x} y={ascender - (selectTool.marqueeRect.y + selectTool.marqueeRect.h)}
            width={selectTool.marqueeRect.w} height={selectTool.marqueeRect.h} className="marquee-rect" />
        )}

        {/* Corner-round live readout: radius (font units) next to the cursor
            while Cmd/Ctrl-dragging a corner, so the value can be read off
            and reused for a matching round elsewhere. */}
        {editor.roundCornerLabel && (() => {
          const { point, radius } = editor.roundCornerLabel;
          const svgP = toSvgPoint(point, ascender);
          const lx = svgP.x + 14 / sc;
          const ly = svgP.y - 14 / sc;
          const text = `${Math.round(radius)}u`;
          const w = (16 + text.length * 7.5) / sc;
          return (
            <g pointerEvents="none" data-testid="round-corner-value">
              <rect x={lx} y={ly - 16 / sc} width={w} height={20 / sc} rx={4 / sc} className="metric-guide-value-bg" />
              <text x={lx + 7 / sc} y={ly - 2 / sc} className="metric-guide-value">{text}</text>
            </g>
          );
        })()}

        {/* Handle alignment guide: while dragging a bezier handle (Node/Pen
            tool), a soft snap onto another point's x and/or y draws a
            dashed cross-guide through the snapped axis/axes plus a live
            coordinate readout — mirrors FontLab's node-handle snap
            feedback (see snapHandlePoint in useGlyphEditor). */}
        {tool === "node" && editor.handleSnapGuide && (() => {
          const { point, x, y } = editor.handleSnapGuide;
          const svgP = toSvgPoint(point, ascender);
          const lx = svgP.x + 12 / sc;
          const ly = svgP.y - 10 / sc;
          const text = `${Math.round(point.x)}, ${Math.round(point.y)}`;
          const w = (16 + text.length * 6.6) / sc;
          return (
            <g pointerEvents="none" data-testid="handle-snap-guide">
              {x !== null && <line x1={svgP.x} y1={vbY} x2={svgP.x} y2={vbY + vbH} className="handle-snap-line" />}
              {y !== null && <line x1={vbX} y1={svgP.y} x2={vbX + vbW} y2={svgP.y} className="handle-snap-line" />}
              <circle cx={svgP.x} cy={svgP.y} r={2.6 / sc} className="handle-snap-dot" />
              <rect x={lx} y={ly - 15 / sc} width={w} height={19 / sc} rx={4 / sc} className="metric-guide-value-bg" />
              <text x={lx + 6 / sc} y={ly - 2 / sc} className="metric-guide-value">{text}</text>
            </g>
          );
        })()}

        {/* Selection box + transform handles */}
        {tool === "select" && selBounds && handlePts && (
          <g>
            <rect x={selBounds.minX} y={ascender - selBounds.maxY} width={selBounds.maxX - selBounds.minX}
              height={selBounds.maxY - selBounds.minY} className="sel-box" />
            <line x1={handlePts.n.x} y1={ascender - handlePts.n.y} x2={handlePts.rotate.x} y2={ascender - handlePts.rotate.y} className="sel-rot-line" />
            <circle cx={handlePts.rotate.x} cy={ascender - handlePts.rotate.y} r={5 * hitScale} className="sel-handle" />
            {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as HandleId[]).map((id) => {
              const s = 7 * hitScale;
              return <rect key={id} x={handlePts[id].x - s / 2} y={ascender - handlePts[id].y - s / 2} width={s} height={s} className="sel-handle" />;
            })}
            {(["skew-x-top", "skew-x-bottom", "skew-y-left", "skew-y-right"] as SkewHandleId[]).map((id) => {
              const p = handlePts[id];
              const s = 6.5 * hitScale;
              const edge =
                id === "skew-x-top" ? { x: p.x, y: selBounds.maxY }
                : id === "skew-x-bottom" ? { x: p.x, y: selBounds.minY }
                : id === "skew-y-left" ? { x: selBounds.minX, y: p.y }
                : { x: selBounds.maxX, y: p.y };
              return (
                <g key={id}>
                  <line x1={edge.x} y1={ascender - edge.y} x2={p.x} y2={ascender - p.y} className="sel-skew-guide" />
                  <rect
                    x={p.x - s / 2}
                    y={ascender - p.y - s / 2}
                    width={s}
                    height={s}
                    rx={1.2 * hitScale}
                    className="sel-skew-handle"
                    transform={`rotate(45 ${p.x} ${ascender - p.y})`}
                    data-transform-handle={id}
                  />
                </g>
              );
            })}
          </g>
        )}

        {/* Nodes + handles (Node tool, while drawing with Pen, or Brush's
            Node draw mode) — memoized layer, see ObjectsLayer above for why. */}
        {(tool === "node" || tool === "pen" || (isNodeBrush && brushNodeTool.isDrawing)) ? (
          <NodesAndHandlesLayer
            objects={
              tool === "node"
                ? editor.nodeableOutline.objects
                : isNodeBrush
                ? (brushNodePreviewOutline?.objects ?? NO_OBJECTS)
                : objects
            }
            ascender={ascender}
            hitScale={hitScale}
            tool={tool}
            selectedNodes={editor.selectedNodes}
            selectedHandle={editor.selectedHandle}
            activeRoundCorner={activeRoundCorner}
          />
        ) : (
          /* Outside Node/Pen: line + brush objects are built from a skeleton
             (centerline) that the rendered fill/stroke hides. Keep that
             skeleton visible as a non-interactive guide — dashed centerline
             + node dots — so it stays legible while moving/scaling with
             other tools. Purely visual: no pointer events, so it never
             competes with whatever the active tool is doing. */
          <SkeletonGuideLayer objects={objects} ascender={ascender} />
        )}

        {/* Ruler guides: user-dragged dashed lines from ruler strips */}
        {rulerGuides.length > 0 && (
          <RulerGuideLines
            rulerGuides={rulerGuides}
            sc={sc}
            vbX={vbX} vbY={vbY} vbW={vbW} vbH={vbH}
            ascender={ascender}
            onRemove={removeRulerGuide}
          />
        )}
      </svg>
      <RecordingBadge />
      {ctxMenu && <CanvasContextMenu pos={ctxMenu} onClose={closeCtxMenu} />}
      {nodePopup && <NodeTypePopup popup={nodePopup} onClose={closeNodePopup} />}
    </div>
  );
}

/**
 * Renders every object's fill/stroke path. Memoized on its own props so that
 * re-renders of GlyphCanvas triggered by unrelated state (mouse hover
 * position, pan, live pointer tracking, etc.) skip straight past this
 * entirely instead of rebuilding a path string per object every time —
 * the cost that scales directly with how many nodes a pasted vector
 * brought in.
 */
const NO_OBJECTS: VectorObject[] = [];

function brushNodePreviewOutlineFor(nodes: PathNode[]): GlyphOutline {
  return {
    objects: [{
      id: "brush-node-preview",
      kind: "brush",
      contours: [{ id: "brush-node-preview-contour", nodes, closed: false }],
    } as VectorObject],
  };
}

function isOutlineBrushObject(o: VectorObject): boolean {
  return o.kind === "brush" && o.brushType === "outline";
}

function sameObjectList(a: VectorObject[], b: VectorObject[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Outline-Brush boolean merge, cached on the IDENTITIES of the Outline Brush
 * objects only — any other object changing (a pen node drag, a shape being
 * moved) no longer re-runs the polygon union.
 *
 * During a live gesture, an Outline Brush stroke that is itself being edited
 * (new identity vs. the last settled render) is left out of the merge and
 * renders as its own silhouette for the duration of the gesture, so the
 * union is NOT recomputed on every pointer frame; the settled outline goes
 * back through the full merge the moment the gesture is committed.
 */
function useOutlineBrushMerge(objects: VectorObject[], live: boolean) {
  const cacheRef = useRef<{ inputs: VectorObject[]; result: ReturnType<typeof mergeOutlineBrushStrokes> } | null>(null);
  const settledRef = useRef<Set<VectorObject> | null>(null);
  const outlineObjs = objects.filter(isOutlineBrushObject);
  const settled = settledRef.current;
  const inputs = live && settled ? outlineObjs.filter((o) => settled.has(o)) : outlineObjs;
  let cache = cacheRef.current;
  if (!cache || !sameObjectList(cache.inputs, inputs)) {
    cache = { inputs, result: inputs.length > 0 ? mergeOutlineBrushStrokes(inputs) : null };
    cacheRef.current = cache;
  }
  if (!live) settledRef.current = new Set(outlineObjs);
  return cache.result;
}

export const ObjectsLayer = memo(function ObjectsLayer({
  objects, ascender, tool, penAutoCloseShape, drawingContourId, selectedObjectIds, overlappingIds,
  live = false, transformedIds, transformMatrix,
}: {
  objects: VectorObject[];
  ascender: number;
  tool: string;
  penAutoCloseShape: boolean;
  drawingContourId: string | null;
  selectedObjectIds: string[];
  overlappingIds: ReadonlySet<string>;
  /** A live gesture is in progress (liveOutline set) — see useOutlineBrushMerge. */
  live?: boolean;
  /** Select-tool drag preview: these objects are drawn from their base
   *  geometry wrapped in `transformMatrix` (see transformPreview.ts). */
  transformedIds?: ReadonlySet<string>;
  transformMatrix?: string;
}) {
  // Same merge used for Preview/Test Lab/export (see glyphPaths.ts) so
  // crossing Outline Brush strokes read as one clean merged shape on the
  // main canvas too, instead of each stroke's own independent hollow ring
  // just stacking on top of the others.
  const outlineMerge = useOutlineBrushMerge(objects, live);
  const selectedSet = useMemo(() => new Set(selectedObjectIds), [selectedObjectIds]);
  const mergedD = useMemo(
    () => (outlineMerge ? outlineMerge.contours.map((c) => contourToPath(c, ascender)).join(" ") : null),
    [outlineMerge, ascender]
  );
  const firstConsumedId = outlineMerge ? objects.find((o) => outlineMerge.consumedIds.has(o.id))?.id ?? null : null;

  return (
    <>
      {objects.map((obj) => {
        // Pen tool, Auto Close Shape OFF: the shape currently being drawn
        // previews as an outline only, until the last node closes it onto
        // the first (see penPointerDown) — at which point it's a normal,
        // committed, filled object like any other. Nothing else changes.
        const isLiveDrawPreview =
          tool === "pen" &&
          !penAutoCloseShape &&
          drawingContourId != null &&
          obj.contours.some((c) => c.id === drawingContourId && !c.closed);
        const isSelected = selectedSet.has(obj.id);
        // Node tool: dim every object except the one being edited. The
        // active object stays fully solid (opacity here would blur exactly
        // the outline you're trying to read while dragging nodes/handles),
        // but everything else recedes — this is what keeps a dense, mostly-
        // black glyph canvas from reading as one flat pekat mass while you
        // work, without touching fill color/opacity itself.
        const dimmed = tool === "node" && selectedObjectIds.length > 0 && !isSelected;
        // FontLab/Glyphs default to a semi-transparent "working" fill in
        // Node mode (their True Fill toggle is what gives the opaque
        // version) — nodes/handles read clearly against the shape instead
        // of a solid dark silhouette swallowing them. Only applies to the
        // object(s) actually being edited; a dimmed object is already
        // faded by its wrapper opacity, so it skips this to avoid stacking
        // two separate transparency effects into an almost-invisible shape.
        const semiFill = tool === "node" && !dimmed;
        const isMergedMember = outlineMerge?.consumedIds.has(obj.id) ?? false;
        // Only the first member of the merged group actually paints the
        // shared fill; the rest pass "" so ObjectShape skips its own fill
        // path entirely (their selection outline still uses their own
        // individual silhouette, see ObjectShape).
        const mergedFillD = isMergedMember ? (obj.id === firstConsumedId ? mergedD : "") : null;
        return (
          <ObjectShape
            key={obj.id}
            obj={obj}
            ascender={ascender}
            selected={isSelected}
            outlineOnly={isLiveDrawPreview}
            overlapping={overlappingIds.has(obj.id)}
            dimmed={dimmed}
            semiFill={semiFill}
            mergedFillD={mergedFillD}
            transform={transformMatrix && transformedIds?.has(obj.id) ? transformMatrix : undefined}
          />
        );
      })}
    </>
  );
});

/**
 * Renders every node + its handles for the Node/Pen tools. Memoized for the
 * same reason as ObjectsLayer: this is the block that used to instantiate
 * one <rect>/<circle> (plus handle lines) per node on every render, which
 * is exactly where a large Figma paste's node count turned into a visibly
 * "stuck" canvas during ordinary mouse movement.
 */
export const NodesAndHandlesLayer = memo(function NodesAndHandlesLayer({
  objects, ascender, hitScale, tool, selectedNodes, selectedHandle, activeRoundCorner,
}: {
  objects: VectorObject[];
  ascender: number;
  hitScale: number;
  tool: string;
  selectedNodes: { contourId: string; nodeId: string }[];
  selectedHandle: { contourId: string; nodeId: string; part: "handleIn" | "handleOut" } | null;
  activeRoundCorner?: { contourId: string; cornerPoint: Point };
}) {
  // Built once per selection change instead of a linear scan per node.
  const selectedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const r of selectedNodes) keys.add(`${r.contourId}:${r.nodeId}`);
    return keys;
  }, [selectedNodes]);
  return (
    <>
      {objects.map((obj) => (
        <ObjectNodesAndHandles
          key={obj.id}
          obj={obj}
          ascender={ascender}
          hitScale={hitScale}
          tool={tool}
          selectedKeys={selectedKeys}
          selectedHandle={selectedHandle}
          activeRoundCorner={activeRoundCorner}
        />
      ))}
    </>
  );
});

/**
 * One object's nodes, handles and corner-round icons. Memoized per object so
 * that during a node/handle drag (which, with structural sharing in nodeOps,
 * only replaces the object being edited) every other object's nodes skip
 * re-rendering entirely.
 */
const ObjectNodesAndHandles = memo(function ObjectNodesAndHandles({
  obj, ascender, hitScale, tool, selectedKeys, selectedHandle, activeRoundCorner,
}: {
  obj: VectorObject;
  ascender: number;
  hitScale: number;
  tool: string;
  selectedKeys: ReadonlySet<string>;
  selectedHandle: { contourId: string; nodeId: string; part: "handleIn" | "handleOut" } | null;
  activeRoundCorner?: { contourId: string; cornerPoint: Point };
}) {
  const cornerHandles = useMemo(
    () => (tool === "node" ? getCornerHandles({ objects: [obj] } as GlyphOutline, 16 * hitScale, activeRoundCorner) : []),
    [tool, obj, hitScale, activeRoundCorner]
  );
  return (
    <g>
      {/* Solid skeleton/centerline for line & brush objects — this is the
          actual path being edited, kept visible under its own thick
          rendered stroke/silhouette (mirrors the "show path" behavior
          you get in Node tool in apps like Affinity Designer), so you
          can see exactly where the curve/nodes sit while dragging. */}
      {(obj.kind === "line" || obj.kind === "brush") &&
        obj.contours.map((contour) => (
          <path
            key={contour.id}
            d={contourToPath(contour, ascender)}
            className="skeleton-guide-path active"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        ))}
      {obj.contours.map((contour) =>
        contour.nodes.map((node) => {
          const svgP = toSvgPoint(node.point, ascender);
          const isSel = selectedKeys.has(`${contour.id}:${node.id}`);
          // Font editors (Glyphs, FontLab, RoboFont) keep every on-curve
          // and off-curve handle visible for the whole glyph while the
          // Node tool is active — not just the selected node's — because
          // seeing the full curve skeleton at once is how you spot a
          // stray handle angle elsewhere in the shape. Outside Node tool
          // (Select/Shape/etc), fall back to "only nodes that actually
          // have handles" so other tools' overlays stay uncluttered.
          const showHandles = tool === "node" ? true : Boolean(node.handleIn || node.handleOut);
          return (
            <g key={node.id}>
              {showHandles && node.handleIn && (
                <HandleGlyph node={node} part="handleIn" ascender={ascender} hitScale={hitScale} emphasized={isSel}
                  selected={selectedHandle?.contourId === contour.id && selectedHandle?.nodeId === node.id && selectedHandle?.part === "handleIn"} />
              )}
              {showHandles && node.handleOut && (
                <HandleGlyph node={node} part="handleOut" ascender={ascender} hitScale={hitScale} emphasized={isSel}
                  selected={selectedHandle?.contourId === contour.id && selectedHandle?.nodeId === node.id && selectedHandle?.part === "handleOut"} />
              )}
              <NodeShape point={svgP} type={node.type} hitScale={hitScale} selected={isSel} />
            </g>
          );
        })
      )}
      {/* Figma-style corner-round handle: a small rounded square sitting
          a fixed distance in from each sharp corner (drag it out to
          round) or from each already-rounded corner (drag it further to
          re-radius, or back to the vertex to un-round) — never a plain
          dot, and never sized or positioned off the live radius, so
          it's always the same easy target to find and grab no matter
          how far a corner has already been rounded. Rendered once per
          object, in font-space, from the same getCornerHandles() the
          pointer-down hit test uses, so the drawn icon and the
          clickable spot can't drift apart. */}
      {cornerHandles.map((h) => {
        const halfPx = 4;
        const halfFont = halfPx * hitScale;
        const rxFont = 1.8 * hitScale;
        const svgP = toSvgPoint(h.point, ascender);
        return (
          <rect
            key={`ch-${h.nodeId}`}
            x={svgP.x - halfFont}
            y={svgP.y - halfFont}
            width={halfFont * 2}
            height={halfFont * 2}
            rx={rxFont}
            ry={rxFont}
            className={`corner-radius-handle ${h.rounded ? "rounded" : ""}`}
            pointerEvents="none"
          />
        );
      })}
    </g>
  );
});

/**
 * Renders a single object's fill/stroke path. Memoized (React.memo) so it
 * only re-renders when its own props actually change — with `obj` being a
 * plain, replace-not-mutate reference throughout this codebase, an
 * untouched object skips re-rendering entirely even while something else
 * on the canvas (or just the mouse) is moving. The `d` path string itself
 * is additionally cached with useMemo keyed on the object, since that
 * string build is the part whose cost scales with node count — exactly
 * what a big pasted vector adds a lot of.
 */
/**
 * Non-interactive skeleton guide for "line"/"brush" objects: just their
 * centerline (dashed), drawn on top of whatever tool is active so the
 * spine stays visible while editing with Select/Shape/etc — not just while
 * Node/Pen is active. Deliberately has no selection/handle state and no
 * pointer events; it's a read-only overlay, not an alternate edit surface.
 *
 * Node dots are intentionally NOT drawn here — those only show up while
 * the Node/Pen tool is active (see NodesAndHandlesLayer), so the presence
 * of node dots is a reliable visual cue for "I'm in Node mode" vs. Select.
 */
export const SkeletonGuideLayer = memo(function SkeletonGuideLayer({
  objects, ascender,
}: {
  objects: VectorObject[];
  ascender: number;
}) {
  const skeletonObjects = objects.filter((o) => o.kind === "line" || o.kind === "brush");
  if (skeletonObjects.length === 0) return null;
  return (
    <g pointerEvents="none">
      {skeletonObjects.map((obj) => (
        <g key={obj.id}>
          {obj.contours.map((contour) => (
            <SkeletonGuidePath key={contour.id} contour={contour} ascender={ascender} />
          ))}
        </g>
      ))}
    </g>
  );
});

/** Per-contour memo: an untouched contour keeps its identity across edits,
 *  so its path string isn't rebuilt while something else is being dragged. */
const SkeletonGuidePath = memo(function SkeletonGuidePath({ contour, ascender }: { contour: Contour; ascender: number }) {
  const d = useMemo(() => contourToPath(contour, ascender), [contour, ascender]);
  return <path d={d} className="skeleton-guide-path" vectorEffect="non-scaling-stroke" />;
});

const ObjectShape = memo(function ObjectShape({
  obj, ascender, selected, outlineOnly, overlapping, dimmed, semiFill, mergedFillD, transform,
}: {
  obj: VectorObject; ascender: number; selected: boolean; outlineOnly?: boolean; overlapping?: boolean; dimmed?: boolean; semiFill?: boolean; mergedFillD?: string | null;
  /** SVG transform applied during a Select-tool drag preview (see transformPreview.ts). */
  transform?: string;
}) {
  const isFillKind = obj.kind === "shape" || obj.kind === "expanded";
  const isMonolineBrush = obj.kind === "brush" && obj.brushType === "monoline";
  const isVariableBrush = obj.kind === "brush" && !isMonolineBrush;

  const fillOrStrokeD = useMemo(() => {
    if (isVariableBrush) return "";
    return isFillKind ? objectFillPath(obj, ascender) : objectStrokePath(obj, ascender);
  }, [obj, ascender, isFillKind, isVariableBrush]);

  const variableBrushD = useMemo(() => {
    if (!isVariableBrush) return "";
    return brushOutlineContours(obj).map((c) => contourToPath(c, ascender)).join(" ");
  }, [obj, ascender, isVariableBrush]);

  // Node tool dimming wraps whichever branch below fires in a <g> with
  // reduced opacity. Deliberately opacity on the group, not a fill-color
  // change — the shape's own ink stays --ink at full strength, so if this
  // object gets selected next the color doesn't "pop" or shift, only the
  // surrounding recede/return.
  const wrap = (node: ReactNode) =>
    dimmed || transform ? <g opacity={dimmed ? 0.42 : undefined} transform={transform}>{node}</g> : <>{node}</>;

  // obj-fill + optional overlap/semi-fill modifiers, joined conditionally.
  const fillClass = () =>
    ["obj-fill", overlapping && "obj-fill-overlap", semiFill && "semi-fill"].filter(Boolean).join(" ");

  if (isFillKind) {
    const d = fillOrStrokeD;
    if (outlineOnly) {
      return <path d={d} className="obj-fill-preview-outline" vectorEffect="non-scaling-stroke" transform={transform} />;
    }
    return wrap(
      <>
        <path d={d} className={fillClass()} />
        {selected && <path d={d} className="obj-sel-outline" vectorEffect="non-scaling-stroke" />}
      </>
    );
  }
  if (obj.kind === "brush") {
    if (isMonolineBrush) {
      const d = fillOrStrokeD;
      return wrap(
        <>
          <path d={d} className={overlapping ? "obj-stroke obj-stroke-overlap" : "obj-stroke"} strokeWidth={obj.strokeWidth ?? 20} strokeLinecap={obj.cap ?? "round"} strokeLinejoin={obj.join ?? "round"} />
          {selected && <path d={d} className="obj-sel-outline" vectorEffect="non-scaling-stroke" />}
        </>
      );
    }
    // Variable-profile brushes render a derived silhouette while retaining the
    // editable centerline as their stored geometry. Outline Brush strokes
    // that are part of a merged group (see mergeOutlineBrushStrokes) paint
    // the SHARED merged fill instead of their own independent silhouette —
    // only the FIRST member of the group actually emits it (mergedFillD is
    // "" for every other member, see ObjectsLayer), so the merge isn't
    // drawn once per stroke. The individual, unmerged silhouette is still
    // used for the selection outline so selecting one stroke highlights
    // just that stroke's own shape, not the whole merged group.
    const d = mergedFillD != null ? mergedFillD : variableBrushD;
    return wrap(
      <>
        {d && <path d={d} className={fillClass()} />}
        {selected && <path d={variableBrushD} className="obj-sel-outline" vectorEffect="non-scaling-stroke" />}
      </>
    );
  }
  const d = fillOrStrokeD;
  return wrap(
    <>
      <path d={d} className={overlapping ? "obj-stroke obj-stroke-overlap" : "obj-stroke"} strokeWidth={obj.strokeWidth ?? 20} strokeLinecap={obj.cap ?? "round"} strokeLinejoin={obj.join ?? "round"} />
      {selected && <path d={d} className="obj-sel-outline" vectorEffect="non-scaling-stroke" />}
    </>
  );
});

const NodeShape = memo(function NodeShape({ point, type, hitScale, selected, guide }: { point: Point; type: NodeType; hitScale: number; selected: boolean; guide?: boolean }) {
  const cls = `node-shape ${type} ${selected ? "selected" : ""} ${guide ? "guide" : ""}`;
  if (type === "corner") {
    const s = (selected ? 7.5 : 6.5) * hitScale;
    const rx = 1.5 * hitScale;
    return <rect x={point.x - s / 2} y={point.y - s / 2} width={s} height={s} rx={rx} ry={rx} className={cls} />;
  }
  const r = (selected ? 4.5 : type === "symmetric" ? 4 : 3.6) * hitScale;
  return <circle cx={point.x} cy={point.y} r={r} className={cls} />;
});

const HandleGlyph = memo(function HandleGlyph({
  node, part, ascender, hitScale, selected, emphasized = true,
}: {
  node: { point: Point; handleIn: Point | null; handleOut: Point | null };
  part: "handleIn" | "handleOut"; ascender: number; hitScale: number; selected: boolean;
  /** Whether this handle's own node is the currently selected one. When
   * false (drawn only because Node tool shows the whole glyph's skeleton at
   * once), the line/dot render dimmed so the selected node's own handles —
   * the ones actually draggable right now — stay the visual focus. */
  emphasized?: boolean;
}) {
  const handle = part === "handleIn" ? node.handleIn : node.handleOut;
  if (!handle) return null;
  const from = toSvgPoint(node.point, ascender);
  const to = toSvgPoint(handle, ascender);
  // Off-curve handle points render as a diamond — two triangles pointing
  // away from each other along the vertical axis — rather than a circle.
  // This matches FontLab's off-curve node glyph, and reads more clearly
  // against the round on-curve smooth/symmetric nodes right next to it.
  const r = (selected ? 4.2 : 3.6) * hitScale;
  const diamond = `M ${to.x} ${to.y - r} L ${to.x + r} ${to.y} L ${to.x} ${to.y + r} L ${to.x - r} ${to.y} Z`;
  return (
    <>
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={`handle-line ${emphasized ? "" : "dim"}`} />
      <path d={diamond} className={`handle-dot ${selected ? "active" : ""} ${emphasized ? "" : "dim"}`} />
    </>
  );
});

export function RubberBand({
  outline, contourId, hover, ascender, hitScale,
}: {
  outline: ReturnType<typeof useGlyphEditor>["outline"]; contourId: string; hover: Point; ascender: number; hitScale: number;
}) {
  const contour = outline.objects.flatMap((o) => o.contours).find((c) => c.id === contourId);
  if (!contour || contour.nodes.length === 0) return null;
  const last = contour.nodes[contour.nodes.length - 1];
  const first = contour.nodes[0];
  const fromSvg = toSvgPoint(last.point, ascender);
  const toSvg = toSvgPoint(hover, ascender);
  const nearFirst = contour.nodes.length > 1 && Math.hypot(hover.x - first.point.x, hover.y - first.point.y) <= 16 * hitScale;
  const firstSvg = toSvgPoint(first.point, ascender);
  return (
    <>
      <line x1={fromSvg.x} y1={fromSvg.y} x2={toSvg.x} y2={toSvg.y} className="rubber-line" />
      {nearFirst && <circle cx={firstSvg.x} cy={firstSvg.y} r={7 * hitScale} className="close-ring" />}
    </>
  );
}

/** Pen / Node-Brush rubber-band fed by the hover preview store, so pointer
 *  hover re-renders only this element instead of the whole canvas. */
const HoverRubberBand = memo(function HoverRubberBand({
  store, outline, contourId, ascender, hitScale,
}: {
  store: PreviewStore<Point | null>; outline: GlyphOutline; contourId: string; ascender: number; hitScale: number;
}) {
  const hover = usePreviewValue(store);
  if (!hover) return null;
  return <RubberBand outline={outline} contourId={contourId} hover={hover} ascender={ascender} hitScale={hitScale} />;
});

/** Live freehand Brush stroke preview (true nib/taper silhouette, or the
 *  centerline for Monoline), subscribed to the brush tool's preview store. */
const BrushStrokePreview = memo(function BrushStrokePreview({
  store, ascender, size, cap,
}: {
  store: PreviewStore<BrushPreview>; ascender: number; size: number; cap: string;
}) {
  const preview = usePreviewValue(store);
  return (
    <>
      {preview.outline.length > 0 && (
        <path
          d={preview.outline.map((c) => contourToPath(c, ascender)).join(" ")}
          className="obj-fill"
          fillRule="nonzero"
          opacity={0.9}
        />
      )}
      {preview.centerline && (
        <path
          d={contourToPath(preview.centerline, ascender)}
          className="brush-preview"
          strokeWidth={size}
          strokeLinecap={cap as "round" | "butt" | "square"}
          strokeLinejoin="round"
        />
      )}
    </>
  );
});

/** Pencil preview: the live curve-fit result, shown both as the open
 *  gesture drawn so far AND — faintly — as it will land once closed, so the
 *  eventual auto-close never comes as a surprise. */
const PencilStrokePreview = memo(function PencilStrokePreview({
  store, ascender, hitScale,
}: {
  store: PreviewStore<Contour | null>; ascender: number; hitScale: number;
}) {
  const contour = usePreviewValue(store);
  if (!contour) return null;
  return (
    <>
      <path
        d={contourToPath({ ...contour, closed: true }, ascender)}
        className="pencil-preview-fill"
        fillRule="nonzero"
      />
      <path
        d={contourToPath({ ...contour, closed: false }, ascender)}
        className="pencil-preview"
        strokeWidth={2 * hitScale}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
});

/**
 * Live preview for the Brush tool's Node draw mode, shared by the Single and
 * Multi Glyph canvases.
 *
 * - Variable-width brushes: the true nib/taper silhouette (`outline`), built
 *   by the same engine that renders the committed object.
 * - Monoline: painted with the native SVG stroke of the centerline using the
 *   exact classes/width/cap/join a COMMITTED monoline uses in ObjectShape, at
 *   full opacity — so what you see while placing nodes is the final result,
 *   not an approximation of it.
 */
export function BrushNodeLivePreview({
  outline, strokeObject, ascender,
}: {
  outline: ReturnType<typeof brushOutlineContours>;
  strokeObject: VectorObject | null;
  ascender: number;
}) {
  if (strokeObject) {
    return (
      <path
        d={objectStrokePath(strokeObject, ascender)}
        className="obj-stroke"
        strokeWidth={strokeObject.strokeWidth ?? 20}
        strokeLinecap={strokeObject.cap ?? "round"}
        strokeLinejoin={strokeObject.join ?? "round"}
      />
    );
  }
  if (outline.length === 0) return null;
  return (
    <path
      d={outline.map((c) => contourToPath(c, ascender)).join(" ")}
      className="obj-fill"
      fillRule="nonzero"
      opacity={0.9}
    />
  );
}

export function handleCursor(h: HandleId): string {
  if (h === "rotate") return "cursor-rot";
  if (h === "skew-x-top" || h === "skew-x-bottom") return "cursor-skew-x";
  if (h === "skew-y-left" || h === "skew-y-right") return "cursor-skew-y";
  if (h === "n" || h === "s") return "cursor-ns";
  if (h === "e" || h === "w") return "cursor-ew";
  if (h === "nw" || h === "se") return "cursor-nwse";
  return "cursor-nesw";
}
