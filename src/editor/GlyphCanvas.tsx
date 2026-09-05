import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useAppStore, type GlyphMetricKey } from "@/glyph/store";
import { useGlyphEditor } from "./useGlyphEditor";
import { useBrushTool } from "./useBrushTool";
import { usePencilTool } from "./usePencilTool";
import { useSelectTool, handlePositions, type HandleId, type SkewHandleId } from "./useSelectTool";
import { useSketchGestures } from "./useSketchGestures";
import { clientToFontPoint } from "./coords";
import { objectFillPath, objectStrokePath, toSvgPoint, contourToPath } from "./pathBuilder";
import { outlineBounds, pointHitsObject } from "./objectOps";
import { getCornerHandles } from "./nodeOps";
import { hitTestSegments } from "./segmentHitTest";
import { findOverlappingObjectIds } from "./overlapDetect";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { GhostGlyph } from "./GhostGlyph";
import { CanvasRuler, RulerGuideLines } from "./CanvasRuler";
import { isFeatureGlyphUnicode } from "@/glyph/featureGlyphs";
import type { GlyphOutline, NodeType, Point, VectorObject } from "@/types/geometry";
import type { FontStyle, Glyph, GlyphMap } from "@/types/glyph";

const FAMILY_GHOST_ORDER: Record<string, readonly [FontStyle, FontStyle]> = {
  regular: ["bold", "italic"],
  bold: ["regular", "italic"],
  italic: ["regular", "bold"],
};

/** Ghost-reference pair for the current style. Built-in styles use the
 * fixed table above; a custom family (or any id not in that table) falls
 * back to referencing Regular + Bold, since it has no natural counterpart. */
function familyGhostOrder(style: FontStyle): readonly [FontStyle, FontStyle] {
  return FAMILY_GHOST_ORDER[style] ?? ["regular", "bold"];
}

function matchingFamilyGlyph(map: GlyphMap, activeGlyph: Glyph, activeChar: string): Glyph | undefined {
  const exact = map[activeChar];
  if (exact) return exact;

  const activeCodes = new Set([activeGlyph.unicode, ...(activeGlyph.unicodes ?? [])]);
  return Object.values(map).find((candidate) => {
    if (activeCodes.has(candidate.unicode)) return true;
    if (candidate.unicodes?.some((code) => activeCodes.has(code))) return true;
    return candidate.char === activeGlyph.char;
  });
}

type PointerMoveSample = {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  altKey: boolean;
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
  const showGuides = useAppStore((s) => s.showGuides);
  const showRuler = useAppStore((s) => s.showRuler);
  const rulerGuides = useAppStore((s) => s.rulerGuides);
  const removeRulerGuide = useAppStore((s) => s.removeRulerGuide);
  const metrics = useAppStore((s) => s.metrics);
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
  const activeChar = useAppStore((s) => s.activeChar);
  const ghost = useAppStore((s) => s.ghost);
  const glyphsByStyle = useAppStore((s) => s.glyphsByStyle);
  const fontStyle = useAppStore((s) => s.fontStyle);
  const brush = useAppStore((s) => s.brush);
  const brushCap = useAppStore((s) => s.brushCap);
  const fitNonce = useAppStore((s) => s.fitNonce);
  const selectedObjectIds = useAppStore((s) => s.selectedObjectIds);
  const setTool = useAppStore((s) => s.setTool);
  const selectNodes = useAppStore((s) => s.selectNodes);
  const selectObjects = useAppStore((s) => s.selectObjects);
  const penAutoCloseShape = useAppStore((s) => s.penAutoClose);

  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Point | null>(null);
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

  const { unitsPerEm: upm, ascender, baseline, descender, capHeight, xHeight } = metrics;
  const totalH = ascender - descender;
  // Default horizontal anchor for the "sample" and "image" ghost modes:
  // the center of this glyph's own standard advance box (lsb..advance-rsb),
  // not the full upm square. Keeps the reference character/image lined up
  // with where this glyph's ink is actually drawn, the same way LSB/RSB/
  // Advance already default to FontSeru's standard sidebearing metrics.
  const ghostCenterX = glyph ? (glyph.advanceWidth + glyph.lsb - glyph.rsb) / 2 : upm * 0.5;
  const [leftGhostStyle, rightGhostStyle] = familyGhostOrder(fontStyle);
  const leftFamilyGlyph = glyph
    ? matchingFamilyGlyph(glyphsByStyle[leftGhostStyle], glyph, activeChar)
    : undefined;
  const rightFamilyGlyph = glyph
    ? matchingFamilyGlyph(glyphsByStyle[rightGhostStyle], glyph, activeChar)
    : undefined;

  const baseFit = viewSize.w && viewSize.h ? 0.62 * Math.min(viewSize.w / upm, viewSize.h / totalH) : 0.35;
  const scale = baseFit * (zoom / 100);
  const vbW = viewSize.w ? viewSize.w / scale : upm;
  const vbH = viewSize.h ? viewSize.h / scale : totalH;
  const vbX = pan.x - vbW / 2;
  const vbY = pan.y - vbH / 2;
  const sc = scale || 0.35;
  const hitScale = 1 / sc;

  const editor = useGlyphEditor(hitScale);
  const brushTool = useBrushTool(hitScale);
  const pencilTool = usePencilTool(hitScale);
  const selectTool = useSelectTool(hitScale);

  // Track container size for the viewBox math.
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const update = () => setViewSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const getFontPoint = useCallback(
    (e: { clientX: number; clientY: number }): Point | null =>
      svgRef.current ? clientToFontPoint(svgRef.current, e.clientX, e.clientY, ascender) : null,
    [ascender]
  );

  const applyZoomAt = useCallback(
    (newZoom: number, clientX: number, clientY: number) => {
      const rect = frameRef.current?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return setZoom(newZoom);
      const fx = (clientX - rect.left) / rect.width;
      const fy = (clientY - rect.top) / rect.height;
      const Px = vbX + fx * vbW;
      const Py = vbY + fy * vbH;
      const clamped = Math.min(8000, Math.max(20, newZoom));
      const nScale = baseFit * (clamped / 100);
      const nvbW = rect.width / nScale;
      const nvbH = rect.height / nScale;
      setZoom(clamped);
      setPan({ x: Px + (0.5 - fx) * nvbW, y: Py + (0.5 - fy) * nvbH });
    },
    [vbX, vbY, vbW, vbH, baseFit, setZoom, setPan]
  );

  // Native, non-passive wheel: plain wheel (any direction, incl. Ctrl/Cmd or
  // trackpad pinch) zooms toward the cursor; hold Shift to pan instead.
  // Coalesce high-resolution trackpad events to one view update per frame.
  const processWheel = useCallback((event: NonNullable<typeof pendingWheelRef.current>) => {
    const store = useAppStore.getState();
    if (event.shiftKey) {
      const dx = event.deltaX !== 0 ? event.deltaX : event.deltaY;
      store.setPan({ x: store.pan.x + dx / sc, y: store.pan.y });
      return;
    }
    applyZoomAt(store.zoom * Math.exp(-event.deltaY * 0.0018), event.clientX, event.clientY);
  }, [applyZoomAt, sc]);
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
    pencilTool.cancel();
    if (tool === "select") selectTool.pointerUp();
    else if (tool !== "brush" && tool !== "pencil") editor.pointerUp();
  }, [brushTool, pencilTool, selectTool, editor, tool]);
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
      if (tool === "pen") setHover(p);
      if (panDragRef.current) {
        setPan({
          x: panDragRef.current.startPan.x - (sample.clientX - panDragRef.current.startClient.x) / sc,
          y: panDragRef.current.startPan.y - (sample.clientY - panDragRef.current.startClient.y) / sc,
        });
        return;
      }
      if (tool === "brush") return brushTool.pointerMove(p, sample);
      if (tool === "pencil") return pencilTool.pointerMove(p);
      if (tool === "select") return selectTool.pointerMove(p, sample.shiftKey, sample.pointerType);
      editor.pointerMove(p, sample.shiftKey, sample.altKey);
    },
    [sketchGestures, getFontPoint, tool, setPan, sc, brushTool, pencilTool, selectTool, editor]
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

  const queuePointerMove = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    pendingPointerMoveRef.current = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      clientX: e.clientX,
      clientY: e.clientY,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
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
    if (tool !== "pen") setHover(null);
  }, [tool]);

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
      if (sketchGestures.handlePointerDown(e)) return;
      const p = getFontPoint(e);
      if (!p) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      if (usingHandPan(e)) {
        panDragRef.current = { startClient: { x: e.clientX, y: e.clientY }, startPan: pan };
        return;
      }
      if (tool === "zoom") return applyZoomAt(zoom * (e.shiftKey ? 0.8 : 1.25), e.clientX, e.clientY);
      if (tool === "brush") return brushTool.pointerDown(p, e);
      if (tool === "pencil") return pencilTool.pointerDown(p);
      if (tool === "select") return selectTool.pointerDown(p, e.shiftKey, e.metaKey || e.ctrlKey);
      editor.pointerDown(p, e.shiftKey, e.altKey, e.metaKey || e.ctrlKey);
    },
    [getFontPoint, tool, editor, brushTool, pencilTool, selectTool, pan, zoom, applyZoomAt, usingHandPan, sketchGestures, flushPointerMove]
  );

  const onPointerMove = queuePointerMove;

  const onPointerUp = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    flushPointerMove();
    sketchGestures.handlePointerUp(e);
    panDragRef.current = null;
    if (tool === "brush") return brushTool.pointerUp();
    if (tool === "pencil") return pencilTool.pointerUp();
    if (tool === "select") return selectTool.pointerUp();
    editor.pointerUp();
  }, [editor, brushTool, pencilTool, selectTool, tool, sketchGestures, flushPointerMove]);

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
    [tool, getFontPoint, editor, hitScale, setTool, selectNodes, selectObjects]
  );

  useEffect(() => {
    function onWindowPointerUp(e: PointerEvent) {
      flushPointerMove();
      sketchGestures.handlePointerUp(e);
      panDragRef.current = null;
      if (tool === "brush") brushTool.pointerUp();
      else if (tool === "pencil") pencilTool.pointerUp();
      else if (tool === "select") selectTool.pointerUp();
      else editor.pointerUp();
    }
    // pointercancel only needs to keep Sketch Mode's touch bookkeeping tidy
    // (e.g. the OS interrupts a touch gesture); it must NOT run the same
    // commit path as pointerup, so normal-mode tool behavior is unchanged.
    function onWindowPointerCancel(e: PointerEvent) {
      sketchGestures.handlePointerUp(e);
    }
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerCancel);
    return () => {
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerCancel);
    };
  }, [editor, brushTool, pencilTool, selectTool, tool, sketchGestures, flushPointerMove]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.code === "Space") spacePanRef.current = true;
      if (e.key === "Escape") { editor.finishOpenContour(); brushTool.cancel(); pencilTool.cancel(); }
      if (tool === "node") {
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); editor.deleteSelectedNodes(); }
        const step = e.shiftKey ? 10 : 1;
        if (e.key === "ArrowLeft") { e.preventDefault(); editor.nudgeNodes(-step, 0); }
        if (e.key === "ArrowRight") { e.preventDefault(); editor.nudgeNodes(step, 0); }
        if (e.key === "ArrowUp") { e.preventDefault(); editor.nudgeNodes(0, step); }
        if (e.key === "ArrowDown") { e.preventDefault(); editor.nudgeNodes(0, -step); }
      }
    }
    function onKeyUp(e: KeyboardEvent) { if (e.code === "Space") spacePanRef.current = false; }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, [editor, brushTool, pencilTool, tool]);

  const beginGuideDrag = useCallback(
    (key: MetricGuideKey, e: ReactPointerEvent<SVGLineElement>) => {
      if (tool !== "home" || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      beginMetricDrag();
      metricDragRef.current = {
        key,
        startClientY: e.clientY,
        startValue: metrics[key],
        startScale: sc,
      };
      setActiveMetricGuide(key);
    },
    [tool, beginMetricDrag, metrics, sc]
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
  // Purely visual: flags the top shape of any stacked pair so overlapping
  // shapes are easy to spot on the canvas. Overlap testing flattens curves and
  // compares polygon pairs, so doing it synchronously for every live pointer
  // sample can dominate Chrome's frame. Debounce it while editing; the latest
  // geometry is still reflected immediately after the pointer stops/commits.
  const [overlappingIds, setOverlappingIds] = useState<Set<string>>(() => findOverlappingObjectIds(objects));
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setOverlappingIds(findOverlappingObjectIds(objects));
    }, 100);
    return () => window.clearTimeout(timer);
  }, [objects]);

  const selBounds = tool === "select" ? selectTool.bounds : null;
  const handlePts = useMemo(
    () => (selBounds ? handlePositions(selBounds, selectTool.rotateOffset, selectTool.skewOffset) : null),
    [selBounds, selectTool.rotateOffset, selectTool.skewOffset]
  );

  const cursorClass =
    tool === "pen" ? "cursor-pen"
    : tool === "node" ? "cursor-node"
    : tool === "shape" ? "cursor-shape"
    : tool === "hand" ? "cursor-hand"
    : tool === "zoom" ? "cursor-zoom"
    : tool === "brush" ? "cursor-brush"
    : tool === "pencil" ? "cursor-pencil"
    : tool === "select" && selectTool.hoverHandle ? handleCursor(selectTool.hoverHandle)
    : "cursor-select";

  // Grid and metrics belong only to the editable center canvas. Ghost lanes
  // intentionally contain glyph shapes only.
  const gridMinX = 0;
  const gridMaxX = upm;

  return (
    <div className={`fm-canvas-frame${showRuler ? " fm-canvas-frame--ruler" : ""}`} ref={frameRef}>
      {showRuler && (
        <CanvasRuler
          scale={sc}
          vbX={vbX} vbY={vbY}
          vbW={vbW} vbH={vbH}
          ascender={ascender}
          svgRef={svgRef}
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
        style={{ touchAction: "none" }}
      >
        <style>{`
          .cursor-pen { cursor: crosshair; } .cursor-node { cursor: default; }
          .cursor-shape { cursor: crosshair; }
          .cursor-pencil { cursor: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij4gPGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMGEwYTBhIiBzdHJva2Utd2lkdGg9IjEuNCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj4gPHBhdGggZD0iTTE1LjYgMi42bDUuOCA1LjgtMTEuNCAxMS40LTcuMiAxLjQgMS40LTcuMnoiIGZpbGw9IiNmZmZmZmYiLz4gPHBhdGggZD0iTTEyLjkgNS4zbDUuOCA1LjgiIC8+IDxwYXRoIGQ9Ik0zLjkgMjAuMWwxLjEtNS42IiAvPiA8L2c+IDwvc3ZnPg==') 3 20, crosshair; }
          .cursor-hand { cursor: grab; } .cursor-zoom { cursor: zoom-in; }
          .cursor-brush { cursor: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij4gPGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMGEwYTBhIiBzdHJva2Utd2lkdGg9IjEuNCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj4gPHBhdGggZD0iTTEyIDQuNGMzLjEgMCA1LjQgMi40IDUuNCA1LjYgMCAyLjEtMS4xIDMuNi0yLjggNC44TDEyIDIxLjZsLTIuNi02LjhDNy43IDEzLjYgNi42IDEyLjEgNi42IDEwYzAtMy4yIDIuMy01LjYgNS40LTUuNnoiIGZpbGw9IiNmZmZmZmYiLz4gPGNpcmNsZSBjeD0iMTIiIGN5PSI5LjYiIHI9IjIuNiIgZmlsbD0iIzBhMGEwYSIgc3Ryb2tlPSJub25lIi8+IDwvZz4gPC9zdmc+') 12 21, crosshair; } .cursor-select { cursor: default; }
          .cursor-nwse { cursor: nwse-resize; } .cursor-nesw { cursor: nesw-resize; }
          .cursor-ns { cursor: ns-resize; } .cursor-ew { cursor: ew-resize; } .cursor-rot { cursor: crosshair; }
          .cursor-skew-x { cursor: ew-resize; } .cursor-skew-y { cursor: ns-resize; }
          .grid-line { stroke: var(--grid); stroke-width: ${1 / sc}; }
          .grid-major { stroke: var(--grid-major); stroke-width: ${1 / sc}; }
          .guide-line { stroke: var(--guide); stroke-width: ${1 / sc}; stroke-dasharray: ${5 / sc} ${5 / sc}; }
          .metric-guide { opacity: 0.72; transition: opacity 120ms ease; }
          .metric-guide .metric-guide-line { stroke-width: ${1 / sc}; stroke-dasharray: ${5 / sc} ${5 / sc}; }
          .metric-guide.metric-ascender .metric-guide-line { stroke: var(--m-ascender); stroke-width: ${1.3 / sc}; }
          .metric-guide.metric-cap .metric-guide-line { stroke: var(--m-cap); stroke-width: ${1.3 / sc}; }
          .metric-guide.metric-xheight .metric-guide-line { stroke: var(--m-xheight); stroke-width: ${1.3 / sc}; stroke-dasharray: ${2 / sc} ${4 / sc}; }
          .metric-guide.metric-baseline .metric-guide-line { stroke: var(--accent); stroke-width: ${1.5 / sc}; }
          .metric-guide.metric-descender .metric-guide-line { stroke: var(--m-descender); }
          /* Each metric now carries its own hue (see --m-* tokens above), so
             every guide is legible at a glance instead of reading as "one
             faint gray line" the way a shared --guide/--guide-2 did. */
          .metric-guide { opacity: 0.85; }
          .metric-guide:hover, .metric-guide.active { opacity: 1; }
          .metric-guide:hover .metric-guide-line, .metric-guide.active .metric-guide-line { stroke-width: ${2 / sc}; }
          .metric-guide-hit { stroke: transparent; stroke-width: ${12 / sc}; cursor: ns-resize; pointer-events: stroke; }
          .metric-guide.locked { opacity: 0.5; }
          .metric-guide.locked .metric-guide-hit { pointer-events: none; cursor: default; }
          .metric-guide-value-bg { fill: var(--canvas); stroke: var(--accent); stroke-width: ${1 / sc}; opacity: 0.96; }
          .metric-guide-value { fill: var(--text); font-size: ${11 / sc}px; font-family: var(--mono); font-weight: 600; }
          .lsb-line, .rsb-line { stroke: var(--sb); stroke-width: ${1.1 / sc}; opacity: 0.85; }
          .glyph-metric-guide-line { stroke: var(--sb); stroke-width: ${1.1 / sc}; stroke-dasharray: ${5 / sc} ${5 / sc}; opacity: 0.85; }
          .glyph-metric-guide-line.advance { stroke: var(--accent); stroke-width: ${1.4 / sc}; }
          .glyph-metric-handle { fill: var(--canvas); stroke: var(--sb); stroke-width: ${1.25 / sc}; cursor: ew-resize; }
          .glyph-metric-handle.locked { opacity: 0.55; pointer-events: none; cursor: default; }
          .glyph-metric-handle.advance { stroke: var(--accent); }
          .glyph-metric-handle.active { fill: var(--sb-soft); stroke: var(--sb); stroke-width: ${1.7 / sc}; }
          .glyph-metric-handle.advance.active { fill: var(--accent-soft); stroke: var(--accent); }
          .glyph-metric-handle.auto { fill: var(--auto-soft); stroke: var(--auto-2); }
          .glyph-metric-label { fill: var(--text); font-size: ${10.5 / sc}px; font-family: var(--mono); font-weight: 600; pointer-events: none; }
          .glyph-metric-auto-dot { fill: var(--auto-2); }
          .guide-label { fill: var(--text-dim); font-size: ${11 / sc}px; font-family: var(--mono); }
          /* Origin (x=0): the left boundary every LSB value is measured
             from. Drawn as a solid, brighter line (never dashed, never
             draggable) with its own "0" flag so it can never be mistaken
             for the LSB guide sitting right next to it. */
          .origin-line { stroke: var(--origin); stroke-width: ${1.4 / sc}; opacity: 0.9; }
          .origin-tick { stroke: var(--origin); stroke-width: ${1.4 / sc}; }
          .origin-flag-bg { fill: var(--origin-soft); stroke: var(--origin); stroke-width: ${1 / sc}; }
          .origin-flag-label { fill: var(--origin); font-size: ${10 / sc}px; font-family: var(--mono); font-weight: 700; pointer-events: none; }
          .obj-fill { fill: var(--ink); fill-rule: nonzero; stroke: none; }
          /* FontLab/Glyphs-style "semi-fill": in Node mode the shape being
             actively edited renders at reduced opacity by default — their
             True Fill toggle is what gives the solid/opaque version — so
             nodes and handles read clearly against it instead of vanishing
             into a solid dark silhouette. */
          .obj-fill.semi-fill { opacity: 0.62; }
          .obj-fill-overlap { fill: var(--overlap); opacity: 0.88; }
          .obj-fill-preview-outline { fill: none; stroke: var(--ink); stroke-width: ${1.25 / sc}; opacity: 0.85; }
          .obj-stroke { fill: none; stroke: var(--ink); }
          .obj-stroke-overlap { stroke: var(--overlap); opacity: 0.88; }
          .obj-sel-outline { fill: none; stroke: var(--accent); stroke-width: ${1.5 / sc}; opacity: 0.9; }
          .brush-preview { fill: none; stroke: var(--accent); opacity: 0.85; }
          .pencil-preview { fill: none; stroke: var(--accent); opacity: 0.9; }
          .pencil-preview-fill { fill: var(--accent); opacity: 0.16; }
          .rubber-line { stroke: var(--accent); stroke-width: ${1.2 / sc}; stroke-dasharray: ${4 / sc} ${3 / sc}; }
          .handle-line { stroke: var(--handle-line); stroke-width: ${1.5 / sc}; }
          .handle-line.dim { opacity: 0.4; }
          .handle-dot { fill: var(--canvas); stroke: var(--accent); stroke-width: ${1.3 / sc}; opacity: 0.85; }
          .handle-dot.active { opacity: 1; }
          .handle-dot.dim { opacity: 0.3; }
          .handle-snap-line { stroke: var(--accent); stroke-width: ${1 / sc}; stroke-dasharray: ${4 / sc} ${4 / sc}; opacity: 0.75; }
          .handle-snap-dot { fill: var(--accent); opacity: 0.9; }
          .node-shape { stroke-width: ${1.3 / sc}; }
          .node-shape.corner { fill: var(--node-corner); stroke: var(--canvas); }
          .node-shape.smooth { fill: var(--node-smooth); stroke: var(--canvas); }
          .node-shape.symmetric { fill: var(--node-symmetric); stroke: var(--canvas); }
          .node-shape.selected { fill: var(--accent); stroke: var(--canvas); }
          .node-shape.guide { opacity: 0.6; }
          .skeleton-guide-path { fill: none; stroke: var(--accent); stroke-width: ${1 / sc}; stroke-dasharray: ${3 / sc} ${3 / sc}; opacity: 0.4; }
          .skeleton-guide-path.active { stroke: #000; stroke-dasharray: none; stroke-width: ${1.25 / sc}; opacity: 0.85; }
          .close-ring { fill: none; stroke: var(--accent); stroke-width: ${1.8 / sc}; }
          /* Ruler-dragged guides: high-contrast cyan so they read clearly
             against the existing metric guides (purple/blue/green/orange). */
          .ruler-guide-line { stroke: var(--ruler-guide); stroke-width: ${1.1 / sc}; stroke-dasharray: ${6 / sc} ${4 / sc}; opacity: 0.9; }
          .marquee-rect { fill: var(--accent-soft); stroke: var(--accent); stroke-width: ${1 / sc}; opacity: 0.5; }
          .sel-box { fill: none; stroke: var(--accent); stroke-width: ${1.2 / sc}; stroke-dasharray: ${5 / sc} ${4 / sc}; }
          .sel-handle { fill: var(--canvas); stroke: var(--accent); stroke-width: ${1.5 / sc}; }
          .sel-skew-handle { fill: var(--accent-soft); stroke: var(--accent); stroke-width: ${1.25 / sc}; }
          .sel-skew-guide { stroke: color-mix(in srgb, var(--accent) 55%, transparent); stroke-width: ${1 / sc}; stroke-dasharray: ${2 / sc} ${3 / sc}; }
          .sel-rot-line { stroke: var(--accent); stroke-width: ${1.2 / sc}; }
          .corner-radius-handle { fill: var(--accent); stroke: var(--panel-bg, #1e1e1e); stroke-width: ${1.4 / sc}; opacity: 0.95; }
          .corner-radius-handle.rounded { fill: var(--accent); opacity: 1; }
        `}</style>

        <defs>
          <clipPath id="fontseru-main-canvas" clipPathUnits="userSpaceOnUse">
            <rect x={0} y={vbY} width={upm} height={vbH} />
          </clipPath>
          <clipPath id="ghost-reference-left" clipPathUnits="userSpaceOnUse">
            <rect x={-upm} y={vbY} width={upm} height={vbH} />
          </clipPath>
          <clipPath id="ghost-reference-right" clipPathUnits="userSpaceOnUse">
            <rect x={upm} y={vbY} width={upm} height={vbH} />
          </clipPath>
        </defs>

        {ghost.enabled && glyph && ghost.mode === "sample" && !isFeatureGlyphUnicode(glyph.unicode) && (
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

        {ghost.enabled && glyph && ghost.mode === "family" && (
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

        {ghost.enabled && glyph && ghost.mode === "image" && ghost.imageSrc && (
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

        <g clipPath="url(#fontseru-main-canvas)">
        {showGrid && Array.from({ length: Math.floor((gridMaxX - gridMinX) / gridSize) + 1 }).map((_, i) => {
          const x = gridMinX + i * gridSize;
          const major = x === gridMinX || x === 0 || x === upm || x === gridMaxX;
          return (
            <line key={"v" + x} x1={x} y1={0} x2={x} y2={totalH}
              className={major ? "grid-major" : "grid-line"} />
          );
        })}
        {showGrid && Array.from({ length: Math.floor(totalH / gridSize) + 1 }).map((_, i) => {
          const y = ascender - i * gridSize;
          return <line key={"h" + i} x1={gridMinX} y1={y} x2={gridMaxX} y2={y} className="grid-line" />;
        })}

        <>
          {metricGuides.filter(({ key }) => key === "baseline" || showGuides).map(({ key, label, value, className }) => {
            const trueY = toY(value);
            // Same visual clamp as Advance/LSB/RSB below: if the guide is
            // dragged above/below the current viewport, pin its rendered
            // line to the near edge instead of letting it vanish off-
            // screen. Purely visual — `value`/drag math stay unclamped.
            const marginY = 20 / sc;
            const y = Math.min(vbY + vbH - marginY, Math.max(vbY + marginY, trueY));
            const active = activeMetricGuide === key;
            const labelX = Math.max(0, vbX) + 10 / sc;
            return (
              <g key={key} className={`metric-guide ${className} ${active ? "active" : ""} ${tool === "home" ? "" : "locked"}`} data-testid={`font-guide-${key}`}>
                <line x1={0} y1={y} x2={upm} y2={y} className="metric-guide-line" pointerEvents="none" />
                <line
                  x1={0}
                  y1={y}
                  x2={upm}
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
        {showGuides && glyph && (() => {
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
          objects={objects}
          ascender={ascender}
          tool={tool}
          penAutoCloseShape={penAutoCloseShape}
          drawingContourId={editor.drawingContourId}
          selectedObjectIds={selectedObjectIds}
          overlappingIds={overlappingIds}
        />

        {/* Brush silhouette preview (true nib/taper outline) */}
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

        {/* Pencil preview: the live curve-fit result, shown both as the
            open gesture drawn so far AND — faintly — as it will land once
            closed, so the eventual auto-close never comes as a surprise. */}
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

        {/* Pen rubber-band */}
        {tool === "pen" && editor.drawingContourId && hover && (
          <RubberBand outline={editor.outline} contourId={editor.drawingContourId} hover={hover} ascender={ascender} hitScale={hitScale} />
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

        {/* Nodes + handles (Node tool, or while drawing with Pen) — memoized layer,
            see ObjectsLayer above for why. */}
        {(tool === "node" || tool === "pen") ? (
          <NodesAndHandlesLayer
            objects={tool === "node" ? editor.nodeableOutline.objects : objects}
            ascender={ascender}
            hitScale={hitScale}
            tool={tool}
            selectedNodes={editor.selectedNodes}
            selectedHandle={editor.selectedHandle}
            activeRoundCorner={
              editor.roundCornerLabel
                ? { contourId: editor.roundCornerLabel.contourId, cornerPoint: editor.roundCornerLabel.cornerPoint }
                : undefined
            }
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
const ObjectsLayer = memo(function ObjectsLayer({
  objects, ascender, tool, penAutoCloseShape, drawingContourId, selectedObjectIds, overlappingIds,
}: {
  objects: VectorObject[];
  ascender: number;
  tool: string;
  penAutoCloseShape: boolean;
  drawingContourId: string | null;
  selectedObjectIds: string[];
  overlappingIds: Set<string>;
}) {
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
        const isSelected = selectedObjectIds.includes(obj.id);
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
const NodesAndHandlesLayer = memo(function NodesAndHandlesLayer({
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
  return (
    <>
      {objects.map((obj) => (
        <g key={obj.id}>
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
              const isSel = selectedNodes.some((r) => r.contourId === contour.id && r.nodeId === node.id);
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
          {tool === "node" &&
            getCornerHandles(
              { objects: [obj] } as GlyphOutline,
              16 * hitScale,
              activeRoundCorner
            ).map((h) => {
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
      ))}
    </>
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
const SkeletonGuideLayer = memo(function SkeletonGuideLayer({
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
            <path key={contour.id} d={contourToPath(contour, ascender)} className="skeleton-guide-path" vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      ))}
    </g>
  );
});

const ObjectShape = memo(function ObjectShape({
  obj, ascender, selected, outlineOnly, overlapping, dimmed, semiFill,
}: { obj: VectorObject; ascender: number; selected: boolean; outlineOnly?: boolean; overlapping?: boolean; dimmed?: boolean; semiFill?: boolean }) {
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
    dimmed ? <g opacity={0.42}>{node}</g> : <>{node}</>;

  // obj-fill + optional overlap/semi-fill modifiers, joined conditionally.
  const fillClass = () =>
    ["obj-fill", overlapping && "obj-fill-overlap", semiFill && "semi-fill"].filter(Boolean).join(" ");

  if (isFillKind) {
    const d = fillOrStrokeD;
    if (outlineOnly) {
      return <path d={d} className="obj-fill-preview-outline" vectorEffect="non-scaling-stroke" />;
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
    // editable centerline as their stored geometry.
    const d = variableBrushD;
    return wrap(
      <>
        <path d={d} className={fillClass()} />
        {selected && <path d={d} className="obj-sel-outline" vectorEffect="non-scaling-stroke" />}
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

function RubberBand({
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

function handleCursor(h: HandleId): string {
  if (h === "rotate") return "cursor-rot";
  if (h === "skew-x-top" || h === "skew-x-bottom") return "cursor-skew-x";
  if (h === "skew-y-left" || h === "skew-y-right") return "cursor-skew-y";
  if (h === "n" || h === "s") return "cursor-ns";
  if (h === "e" || h === "w") return "cursor-ew";
  if (h === "nw" || h === "se") return "cursor-nwse";
  return "cursor-nesw";
}
