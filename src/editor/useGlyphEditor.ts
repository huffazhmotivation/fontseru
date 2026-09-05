import { useCallback, useMemo, useRef, useState } from "react";
import type { Contour, GlyphOutline, NodeType, PathNode, Point, VectorObject } from "@/types/geometry";
import { useAppStore, type NodeRef, type HandleRef } from "@/glyph/store";
import { shortId } from "@/utils/id";
import { hitTestOutline } from "./hitTest";
import { hitTestSegments } from "./segmentHitTest";
import { add, reflect, reflectDirection, snapAngle, subtract, length, dot } from "@/utils/geometry";
import {
  cloneOutline,
  findNode,
  findContour,
  retypeNode,
  deleteNodes,
  moveNodesBy,
  insertNodeOnSegment,
  bendSegment,
  roundCorner,
  unroundCorner,
  findCornerHandleAt,
  cornerHandleDirection,
  NODE_TYPE_ORDER,
} from "./nodeOps";
import { findObjectOfContour } from "@/types/geometry";
import { buildShapeContour } from "./shapeBuilder";

export interface Rect { x: number; y: number; w: number; h: number; }

type DragState =
  | { mode: "pen-place"; contourId: string; nodeId: string }
  | { mode: "move-selection"; refs: NodeRef[]; origin: Point }
  | {
      mode: "move-handle";
      contourId: string;
      nodeId: string;
      part: "handleIn" | "handleOut";
      nodeType: NodeType;
      xTargets: number[];
      yTargets: number[];
    }
  | { mode: "curve"; contourId: string; fromIndex: number; t: number }
  | { mode: "marquee"; origin: Point; additive: boolean }
  | { mode: "shape-draw"; start: Point; objectId: string }
  | { mode: "round-corner"; contourId: string; nodeId: string; cornerPoint: Point; dir: Point }
  | null;

function refKey(r: NodeRef) { return `${r.contourId}:${r.nodeId}`; }
function axisLock(delta: Point): Point {
  return Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y };
}

/** Soft-snap tolerance for handle dragging, in screen pixels — matches the
 * Select tool's feel (see useSelectTool's SNAP_TOLERANCE_PX) so alignment
 * behaves consistently across tools; converted to font units via hitScale
 * at call time. */
const HANDLE_SNAP_TOLERANCE_PX = 7;

/**
 * Snaps a dragged handle's x/y independently toward the nearest alignment
 * target on each axis (its own anchor node, plus every other on-curve
 * node's coordinates currently visible), FontLab/Glyphs-style. Returns the
 * corrected point AND which target(s) it actually snapped to, so the
 * caller can draw a dashed guide line + coordinate readout exactly at the
 * point of alignment — soft/non-forcing: nothing snaps unless it's already
 * within tolerance.
 */
function snapHandlePoint(
  p: Point,
  xTargets: number[],
  yTargets: number[],
  tolerance: number
): { point: Point; snappedX: number | null; snappedY: null | number } {
  let x = p.x;
  let y = p.y;
  let snappedX: number | null = null;
  let bestDx = tolerance;
  for (const t of xTargets) {
    const d = Math.abs(t - x);
    if (d < bestDx) { bestDx = d; x = t; snappedX = t; }
  }
  let snappedY: number | null = null;
  let bestDy = tolerance;
  for (const t of yTargets) {
    const d = Math.abs(t - y);
    if (d < bestDy) { bestDy = d; y = t; snappedY = t; }
  }
  return { point: { x, y }, snappedX, snappedY };
}
function rectFrom(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** hitScale = font units per screen pixel. */
export function useGlyphEditor(hitScale: number) {
  const tool = useAppStore((s) => s.tool);
  const penMode = useAppStore((s) => s.penMode);
  const penAutoClose = useAppStore((s) => s.penAutoClose);
  const lineWidth = useAppStore((s) => s.lineWidth);
  const lineCap = useAppStore((s) => s.lineCap);
  const shapeKind = useAppStore((s) => s.shapeKind);
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const liveOutline = useAppStore((s) => s.liveOutline);
  const selectedNodes = useAppStore((s) => s.selectedNodes);
  const selectedHandle = useAppStore((s) => s.selectedHandle);
  const drawingContourId = useAppStore((s) => s.drawingContourId);
  const showGrid = useAppStore((s) => s.showGrid);
  const selectedObjectIds = useAppStore((s) => s.selectedObjectIds);
  const snapEnabled = useAppStore((s) => s.snapEnabled);

  const commitOutline = useAppStore((s) => s.commitOutline);
  const setLiveOutline = useAppStore((s) => s.setLiveOutline);
  const selectNodes = useAppStore((s) => s.selectNodes);
  const toggleNodeSelection = useAppStore((s) => s.toggleNodeSelection);
  const clearSelection = useAppStore((s) => s.clearSelection);
  const setSelectedHandle = useAppStore((s) => s.setSelectedHandle);
  const setDrawingContourId = useAppStore((s) => s.setDrawingContourId);

  const dragRef = useRef<DragState>(null);
  const baseOutlineRef = useRef<GlyphOutline | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<Rect | null>(null);
  const marqueeRectRef = useRef<Rect | null>(null);
  // Live readout for a Cmd/Ctrl-drag corner-round: shows the fillet radius
  // (font units) next to the cursor while dragging, so the exact number can
  // be read off and reused (e.g. typed into another corner-round elsewhere)
  // instead of eyeballing the drag distance. Cleared on release.
  const [roundCornerLabel, setRoundCornerLabel] = useState<{ point: Point; radius: number } | null>(null);
  /** Live alignment feedback while dragging a bezier handle — mirrors
   * FontLab's dashed cross-guides with a coordinate readout. `x`/`y` are
   * set only on the axis actually snapped, so the drawn guide only shows
   * the line(s) that are real (a handle can snap on one axis, both, or
   * neither). Cleared as soon as the drag ends. */
  const [handleSnapGuide, setHandleSnapGuide] = useState<{ point: Point; x: number | null; y: number | null } | null>(null);

  const outline: GlyphOutline = liveOutline ?? glyph?.outline ?? { objects: [] };
  const hitRadius = 12 * hitScale;
  const closeRadius = 16 * hitScale;
  const segmentRadius = 10 * hitScale;
  // How far in from the vertex the corner-round handle sits (screen px,
  // converted to font units) — must match the renderer's CORNER_HANDLE_INSET
  // in GlyphCanvas.tsx so the drawn icon and the clickable spot line up.
  const cornerHandleInset = 16 * hitScale;
  // A little more generous than the handle's own ~7.8px half-diagonal so
  // clicking just outside the drawn square still grabs it — matching the
  // forgiving hit area every other node/handle dot in this file gets.
  const cornerHandleHitRadius = 10 * hitScale;
  // "Close enough to zero, snap back to a sharp corner" cutoff for a
  // round-corner drag, in font units. A flat font-unit constant is
  // sub-pixel at most zoom levels (making it nearly impossible to drag a
  // corner back to fully sharp); a couple of screen pixels' worth of font
  // units, via hitScale, keeps the cutoff easy to hit at any zoom.
  const cornerRoundMinRadius = 2 * hitScale;

  // Node tool should only "see" nodes belonging to the currently selected
  // object(s) — with 2+ objects on the canvas, an unselected object's nodes
  // must stay inactive so hovering/clicking near them can't select them by
  // accident. If nothing is selected yet (e.g. Node tool picked with no
  // prior selection), fall back to every object so the tool still works for
  // the common single-object case.
  const nodeableOutline: GlyphOutline = useMemo(() => {
    if (selectedObjectIds.length === 0) return outline;
    return { objects: outline.objects.filter((o) => selectedObjectIds.includes(o.id)) };
  }, [outline, selectedObjectIds]);
  const gridSize = 10; // snap increment — intentionally independent of the visual grid's display spacing (store.gridSize)

  const maybeSnap = useCallback(
    (p: Point) => (showGrid ? { x: Math.round(p.x / gridSize) * gridSize, y: Math.round(p.y / gridSize) * gridSize } : p),
    [showGrid]
  );

  /* ------------------------------------------------------------ PEN */
  const penPointerDown = useCallback(
    (p: Point) => {
      const working = cloneOutline(outline);
      const snapped = maybeSnap(p);

      if (drawingContourId) {
        const contour = findContour(working, drawingContourId);
        if (contour && contour.nodes.length > 0) {
          const first = contour.nodes[0];
          const last = contour.nodes[contour.nodes.length - 1];
          const canClose = penMode === "shape" && contour.nodes.length > 1 && length(subtract(first.point, p)) <= closeRadius;
          if (canClose) {
            contour.closed = true;
            baseOutlineRef.current = null;
            setDrawingContourId(null);
            clearSelection();
            commitOutline(activeChar, working);
            return;
          }

          // Affinity-style endpoint click: clicking the current endpoint converts
          // it to a corner in place instead of creating a coincident duplicate.
          // Only the outgoing handle is cleared, so the *next* segment drawn
          // from here starts straight — the incoming handle (which shapes the
          // segment already drawn into this point) is left untouched, so that
          // segment's curve never changes. Committed immediately so it's its
          // own undo step, matching every other single click of the pen tool.
          if (length(subtract(last.point, p)) <= hitRadius) {
            last.type = "corner";
            last.handleOut = null;
            baseOutlineRef.current = null;
            dragRef.current = null;
            commitOutline(activeChar, working);
            return;
          }

          const node: PathNode = { id: shortId("node"), point: snapped, handleIn: null, handleOut: null, type: "corner" };
          contour.nodes.push(node);
          baseOutlineRef.current = cloneOutline(working);
          dragRef.current = { mode: "pen-place", contourId: contour.id, nodeId: node.id };
          setLiveOutline(working);
          return;
        }
      }

      // Clicking an endpoint of an existing open path converts it to Corner
      // without starting a new path or adding a duplicate point.
      for (const obj of working.objects) {
        for (const contour of obj.contours) {
          if (contour.closed || contour.nodes.length === 0) continue;
          const contourFirst = contour.nodes[0];
          const contourLast = contour.nodes[contour.nodes.length - 1];
          const endpoints = contour.nodes.length === 1 ? [contourFirst] : [contourFirst, contourLast];
          const endpoint = endpoints.find((node) => length(subtract(node.point, p)) <= hitRadius);
          if (endpoint) {
            endpoint.type = "corner";
            // Only clear the handle that would steer the next segment drawn
            // onward from this point. The handle belonging to a segment
            // that's already drawn is left alone so its curve is unchanged.
            if (endpoint === contourLast) endpoint.handleOut = null;
            if (endpoint === contourFirst) endpoint.handleIn = null;
            commitOutline(activeChar, working);
            return;
          }
        }
      }

      // First node of a brand-new Pen/Line contour starts Symmetric (not
      // Corner) so it behaves consistently the moment a handle is dragged
      // out of it (see penPointerMove below, which already sets "symmetric"
      // on drag) — handles stay null/collapsed until actually dragged, so
      // this only changes the node's *type*, never its position or shape.
      const node: PathNode = { id: shortId("node"), point: snapped, handleIn: null, handleOut: null, type: "symmetric" };
      const contour: Contour = { id: shortId("contour"), nodes: [node], closed: false };
      const obj: VectorObject =
        penMode === "shape"
          ? { id: shortId("obj"), kind: "shape", contours: [contour] }
          : { id: shortId("obj"), kind: "line", contours: [contour], strokeWidth: lineWidth, cap: lineCap, join: "round" };
      working.objects.push(obj);
      baseOutlineRef.current = cloneOutline(working);
      dragRef.current = { mode: "pen-place", contourId: contour.id, nodeId: node.id };
      setDrawingContourId(contour.id);
      setLiveOutline(working);
    },
    [outline, drawingContourId, penMode, lineWidth, lineCap, closeRadius, hitRadius, maybeSnap, activeChar, commitOutline, setDrawingContourId, setLiveOutline, clearSelection]
  );

  const penPointerMove = useCallback(
    (p: Point, shiftKey: boolean) => {
      const drag = dragRef.current;
      const base = baseOutlineRef.current;
      if (!drag || drag.mode !== "pen-place" || !base) return;
      const working = cloneOutline(base);
      const node = findNode(working, drag.contourId, drag.nodeId);
      if (!node) return;
      const handlePoint = shiftKey ? snapAngle(node.point, p, 45) : p;
      if (length(subtract(handlePoint, node.point)) < 0.5) {
        node.handleIn = null; node.handleOut = null; node.type = "corner";
      } else {
        node.handleOut = handlePoint;
        node.handleIn = reflect(handlePoint, node.point);
        node.type = "symmetric";
      }
      setLiveOutline(working);
    },
    [setLiveOutline]
  );

  /* ---------------------------------------------------------- SHAPE */
  // Rectangle / Ellipse / Polygon tool: click-drag out a bounding box on
  // the canvas; releasing commits it as a normal filled "shape" object
  // (same kind the Pen tool produces), so it's immediately editable with
  // the Node tool like anything else. Shift constrains the drag to a
  // square / circle / regular polygon, matching standard vector-tool feel.
  const shapePointerDown = useCallback(
    (p: Point) => {
      const snapped = maybeSnap(p);
      baseOutlineRef.current = cloneOutline(outline);
      dragRef.current = { mode: "shape-draw", start: snapped, objectId: shortId("obj") };
      setLiveOutline(outline);
    },
    [outline, maybeSnap, setLiveOutline]
  );

  const shapePointerMove = useCallback(
    (p: Point, shiftKey: boolean) => {
      const drag = dragRef.current;
      const base = baseOutlineRef.current;
      if (!drag || drag.mode !== "shape-draw" || !base) return;
      const snapped = maybeSnap(p);
      const contour = buildShapeContour(shapeKind, drag.start, snapped, shiftKey);
      const working = cloneOutline(base);
      if (contour) {
        const obj: VectorObject = { id: drag.objectId, kind: "shape", contours: [contour] };
        working.objects.push(obj);
      }
      setLiveOutline(working);
    },
    [shapeKind, maybeSnap, setLiveOutline]
  );

  /* ----------------------------------------------------------- NODE */
  const nodePointerDown = useCallback(
    (p: Point, shiftKey: boolean, altKey: boolean, cmdKey: boolean) => {
      // Figma-style corner-round handle: clicking+dragging the inset icon
      // itself (no Cmd needed) rounds a sharp corner, or re-radii/un-rounds
      // one that's already rounded. Checked first since the icon sits off
      // to the side of the vertex, not on top of it, so it never competes
      // with a normal node-point hit.
      const handleHit = findCornerHandleAt(nodeableOutline, p, cornerHandleInset, cornerHandleHitRadius);
      if (handleHit) {
        if (!handleHit.rounded) {
          const cornerNode = findNode(outline, handleHit.contourId, handleHit.nodeId);
          if (cornerNode) {
            const dir = cornerHandleDirection(outline, { contourId: handleHit.contourId, nodeId: handleHit.nodeId });
            if (dir) {
              baseOutlineRef.current = cloneOutline(outline);
              dragRef.current = { mode: "round-corner", contourId: handleHit.contourId, nodeId: handleHit.nodeId, cornerPoint: { ...cornerNode.point }, dir };
              return;
            }
          }
        } else {
          const unrounded = unroundCorner(outline, { contourId: handleHit.contourId, nodeId: handleHit.nodeId });
          if (unrounded) {
            const dir = cornerHandleDirection(unrounded.outline, { contourId: unrounded.contourId, nodeId: unrounded.nodeId });
            if (dir) {
              baseOutlineRef.current = unrounded.outline;
              dragRef.current = {
                mode: "round-corner",
                contourId: unrounded.contourId,
                nodeId: unrounded.nodeId,
                cornerPoint: unrounded.cornerPoint,
                dir,
              };
              setLiveOutline(unrounded.outline);
              return;
            }
          }
        }
      }

      const hit = hitTestOutline(nodeableOutline, p, hitRadius);

      if (hit && hit.part === "point") {
        // Cmd/Ctrl+drag directly on a sharp corner rounds it instead of
        // moving/multi-selecting — the corner's neighbors stay put and two
        // new nodes appear, joined by a bezier fillet whose radius tracks
        // the drag distance (see nodePointerMove and nodeOps.roundCorner).
        // Only applies to true corners (no handles yet); a node that's
        // already smooth/symmetric, or already rounded, keeps the normal
        // shift-click multi-select behavior below.
        const hitNode = findNode(outline, hit.contourId, hit.nodeId);
        if (cmdKey && hitNode && hitNode.type === "corner" && !hitNode.handleIn && !hitNode.handleOut) {
          const dir = cornerHandleDirection(outline, { contourId: hit.contourId, nodeId: hit.nodeId });
          if (dir) {
            baseOutlineRef.current = cloneOutline(outline);
            dragRef.current = { mode: "round-corner", contourId: hit.contourId, nodeId: hit.nodeId, cornerPoint: { ...hitNode.point }, dir };
            return;
          }
        }

        // Cmd/Ctrl+drag one of an already-rounded corner's two fillet nodes
        // reverses the gesture above: collapse the pair back into a single
        // sharp corner at its reconstructed position, then drive the same
        // round-corner drag from there — so dragging back to that corner
        // restores the sharp point, and dragging elsewhere re-fillets it.
        if (cmdKey && hitNode) {
          const unrounded = unroundCorner(outline, { contourId: hit.contourId, nodeId: hit.nodeId });
          if (unrounded) {
            const dir = cornerHandleDirection(unrounded.outline, { contourId: unrounded.contourId, nodeId: unrounded.nodeId });
            if (dir) {
              baseOutlineRef.current = unrounded.outline;
              dragRef.current = {
                mode: "round-corner",
                contourId: unrounded.contourId,
                nodeId: unrounded.nodeId,
                cornerPoint: unrounded.cornerPoint,
                dir,
              };
              setLiveOutline(unrounded.outline);
              return;
            }
          }
        }

        const ref: NodeRef = { contourId: hit.contourId, nodeId: hit.nodeId };
        let nextSelection: NodeRef[];
        if (shiftKey) {
          toggleNodeSelection(ref);
          const already = selectedNodes.some((r) => refKey(r) === refKey(ref));
          nextSelection = already ? selectedNodes.filter((r) => refKey(r) !== refKey(ref)) : [...selectedNodes, ref];
        } else if (selectedNodes.some((r) => refKey(r) === refKey(ref))) {
          nextSelection = selectedNodes;
        } else {
          nextSelection = [ref];
          selectNodes(nextSelection);
        }
        baseOutlineRef.current = cloneOutline(outline);
        dragRef.current = { mode: "move-selection", refs: nextSelection, origin: p };
        return;
      }

      if (hit && (hit.part === "handleIn" || hit.part === "handleOut")) {
        const node = findNode(outline, hit.contourId, hit.nodeId);
        if (!node) return;
        setSelectedHandle({ contourId: hit.contourId, nodeId: hit.nodeId, part: hit.part } as HandleRef);
        baseOutlineRef.current = cloneOutline(outline);
        const xTargets: number[] = [node.point.x];
        const yTargets: number[] = [node.point.y];
        for (const obj of nodeableOutline.objects) {
          for (const contour of obj.contours) {
            for (const other of contour.nodes) {
              if (other.id === node.id) continue;
              xTargets.push(other.point.x);
              yTargets.push(other.point.y);
            }
          }
        }
        dragRef.current = {
          mode: "move-handle",
          contourId: hit.contourId,
          nodeId: hit.nodeId,
          part: hit.part,
          nodeType: node.type,
          xTargets,
          yTargets,
        };
        return;
      }

      // Cmd/Ctrl + drag on a segment -> bend into a Bézier curve.
      const segHit = hitTestSegments(nodeableOutline, p, segmentRadius * 1.6);
      if (cmdKey && segHit) {
        baseOutlineRef.current = cloneOutline(outline);
        dragRef.current = { mode: "curve", contourId: segHit.contourId, fromIndex: segHit.fromIndex, t: segHit.t };
        return;
      }
      // Alt+click a segment -> insert a node.
      if (altKey && segHit) {
        // In-place refinement of existing ink, not new ink — skip the live
        // Auto Spacing re-center (see commitOutline's skipAutoSpacing doc).
        commitOutline(activeChar, insertNodeOnSegment(outline, { contourId: segHit.contourId, fromIndex: segHit.fromIndex }, segHit.t), { skipAutoSpacing: true });
        return;
      }

      if (!shiftKey) clearSelection();
      dragRef.current = { mode: "marquee", origin: p, additive: shiftKey };
      const initialRect = { x: p.x, y: p.y, w: 0, h: 0 };
      marqueeRectRef.current = initialRect;
      setMarqueeRect(initialRect);
    },
    [outline, nodeableOutline, hitRadius, segmentRadius, cornerHandleInset, cornerHandleHitRadius, selectedNodes, selectNodes, toggleNodeSelection, clearSelection, setSelectedHandle, activeChar, commitOutline, setLiveOutline]
  );

  const nodePointerMove = useCallback(
    (p: Point, shiftKey: boolean, altKey: boolean) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.mode === "marquee") {
        const rect = rectFrom(drag.origin, p);
        marqueeRectRef.current = rect;
        setMarqueeRect(rect);
        return;
      }
      const base = baseOutlineRef.current;
      if (!base) return;

      if (drag.mode === "move-selection") {
        const rawDelta = subtract(p, drag.origin);
        setLiveOutline(moveNodesBy(base, drag.refs, shiftKey ? axisLock(rawDelta) : rawDelta));
        return;
      }
      if (drag.mode === "curve") {
        setLiveOutline(bendSegment(base, { contourId: drag.contourId, fromIndex: drag.fromIndex }, drag.t, p));
        return;
      }
      if (drag.mode === "round-corner") {
        // Project the raw pointer delta onto the corner's fixed bisector
        // axis (drag.dir, captured at drag-start) instead of using the
        // cursor's plain distance from the corner. Plain distance grew the
        // radius even when the drag wandered off-axis (turning the corner
        // into an unrelated shape) and made a full 0-radius revert require
        // landing the cursor on the exact corner pixel. A signed projection
        // fixes both: only movement along the handle's real axis counts,
        // and dragging back past the corner clamps cleanly to 0 via
        // roundCorner's minRadius cutoff below.
        const radius = Math.max(0, dot(subtract(p, drag.cornerPoint), drag.dir));
        setRoundCornerLabel({ point: p, radius });
        setLiveOutline(roundCorner(base, { contourId: drag.contourId, nodeId: drag.nodeId }, radius, cornerRoundMinRadius));
        return;
      }
      if (drag.mode === "move-handle") {
        const working = cloneOutline(base);
        const node = findNode(working, drag.contourId, drag.nodeId);
        if (!node) return;
        let draggedPoint = shiftKey ? snapAngle(node.point, p, 45) : p;
        // Soft alignment snap (skipped once Shift's 45°-angle snap is
        // already driving the handle, so the two don't fight each other):
        // pull the handle onto its own anchor's x/y, or onto any other
        // on-curve node's x/y, whenever it's already within a few screen
        // pixels — same feel as the Select tool's guide snapping, applied
        // here to handles specifically per FontLab-style node editing.
        if (snapEnabled && !shiftKey) {
          const tolerance = HANDLE_SNAP_TOLERANCE_PX * hitScale;
          const snapped = snapHandlePoint(draggedPoint, drag.xTargets, drag.yTargets, tolerance);
          draggedPoint = snapped.point;
          setHandleSnapGuide(
            snapped.snappedX !== null || snapped.snappedY !== null
              ? { point: draggedPoint, x: snapped.snappedX, y: snapped.snappedY }
              : null
          );
        } else {
          setHandleSnapGuide(null);
        }
        const breakConstraint = altKey;
        if (drag.part === "handleOut") {
          node.handleOut = draggedPoint;
          if (!breakConstraint) {
            if (drag.nodeType === "symmetric") node.handleIn = reflect(draggedPoint, node.point);
            else if (drag.nodeType === "smooth" && node.handleIn) node.handleIn = reflectDirection(draggedPoint, node.point, length(subtract(node.handleIn, node.point)));
          }
        } else {
          node.handleIn = draggedPoint;
          if (!breakConstraint) {
            if (drag.nodeType === "symmetric") node.handleOut = reflect(draggedPoint, node.point);
            else if (drag.nodeType === "smooth" && node.handleOut) node.handleOut = reflectDirection(draggedPoint, node.point, length(subtract(node.handleOut, node.point)));
          }
        }
        setLiveOutline(working);
      }
    },
    [setLiveOutline, snapEnabled, hitScale, cornerRoundMinRadius]
  );

  const finishMarquee = useCallback((drag: Extract<NonNullable<DragState>, { mode: "marquee" }>) => {
    const rect = marqueeRectRef.current;
    if (rect && (rect.w > 1 || rect.h > 1)) {
      const found: NodeRef[] = [];
      for (const obj of nodeableOutline.objects) for (const contour of obj.contours) for (const node of contour.nodes) {
        if (pointInRect(node.point, rect)) found.push({ contourId: contour.id, nodeId: node.id });
      }
      selectNodes(found, drag.additive);
    }
    marqueeRectRef.current = null;
    setMarqueeRect(null);
  }, [nodeableOutline, selectNodes]);

  const cycleNodeType = useCallback(
    (contourId: string, nodeId: string) => {
      const node = findNode(outline, contourId, nodeId);
      if (!node) return;
      const next = NODE_TYPE_ORDER[(NODE_TYPE_ORDER.indexOf(node.type) + 1) % NODE_TYPE_ORDER.length];
      // In-place refinement of existing ink — skip the live Auto Spacing
      // re-center (see commitOutline's skipAutoSpacing doc).
      commitOutline(activeChar, retypeNode(outline, contourId, nodeId, next), { skipAutoSpacing: true });
    },
    [outline, activeChar, commitOutline]
  );

  const insertNodeAt = useCallback(
    (p: Point) => {
      const segHit = hitTestSegments(nodeableOutline, p, segmentRadius * 1.8);
      if (segHit) commitOutline(activeChar, insertNodeOnSegment(outline, { contourId: segHit.contourId, fromIndex: segHit.fromIndex }, segHit.t), { skipAutoSpacing: true });
    },
    [outline, nodeableOutline, segmentRadius, activeChar, commitOutline]
  );

  const deleteSelectedNodes = useCallback(() => {
    if (selectedNodes.length === 0) return;
    commitOutline(activeChar, deleteNodes(outline, selectedNodes), { skipAutoSpacing: true });
    clearSelection();
  }, [selectedNodes, outline, activeChar, commitOutline, clearSelection]);

  const nudgeNodes = useCallback(
    (dx: number, dy: number) => {
      if (selectedNodes.length === 0) return;
      commitOutline(activeChar, moveNodesBy(outline, selectedNodes, { x: dx, y: dy }), { skipAutoSpacing: true });
    },
    [selectedNodes, outline, activeChar, commitOutline]
  );

  /* --------------------------------------------------------- PUBLIC */
  const pointerDown = useCallback(
    (p: Point, shiftKey: boolean, altKey: boolean, cmdKey: boolean) => {
      if (tool === "pen") penPointerDown(p);
      else if (tool === "node") nodePointerDown(p, shiftKey, altKey, cmdKey);
      else if (tool === "shape") shapePointerDown(p);
    },
    [tool, penPointerDown, nodePointerDown, shapePointerDown]
  );
  const pointerMove = useCallback(
    (p: Point, shiftKey: boolean, altKey: boolean) => {
      if (tool === "pen") penPointerMove(p, shiftKey);
      else if (tool === "node") nodePointerMove(p, shiftKey, altKey);
      else if (tool === "shape") shapePointerMove(p, shiftKey);
    },
    [tool, penPointerMove, nodePointerMove, shapePointerMove]
  );
  const pointerUp = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    setRoundCornerLabel(null);
    setHandleSnapGuide(null);
    if (drag.mode === "marquee") {
      finishMarquee(drag);
      dragRef.current = null;
      baseOutlineRef.current = null;
      return;
    }
    dragRef.current = null;
    if (drag.mode === "pen-place") {
      // Each node the pen tool places (click, or click-drag to pull out
      // handles) is committed here as its own undo step, so Undo removes
      // exactly the node just created instead of leaving it uncommitted
      // until the whole contour is finished (which used to make Undo
      // either do nothing or remove the entire path in one go).
      if (liveOutline) commitOutline(activeChar, liveOutline);
      baseOutlineRef.current = null;
      return;
    }
    if (drag.mode === "shape-draw") {
      // A drag too small to register never added an object to liveOutline,
      // so nothing is committed and the canvas just falls back to the
      // outline it already had — no accidental empty/degenerate shape.
      const added = liveOutline?.objects.some((o) => o.id === drag.objectId) ?? false;
      if (added && liveOutline) {
        commitOutline(activeChar, liveOutline);
        // Stays on the Shape tool (matching Pencil and Brush) instead of
        // hopping to Select — drawing several rectangles/ellipses/polygons
        // in a row is the common case, and re-picking the tool after every
        // single shape got in the way of that.
      } else {
        // Click without a real drag: nothing was added, so just clear the
        // no-op liveOutline snapshot instead of leaving a stale copy around.
        setLiveOutline(null);
      }
      baseOutlineRef.current = null;
      return;
    }
    // Reached for move-selection, curve/segment-bend, round-corner, and
    // move-handle drags — all in-place refinements of ink that's already on
    // the canvas. Skip the live Auto Spacing re-center here (see
    // commitOutline's skipAutoSpacing doc): without this, finishing e.g. a
    // corner-round drag nudges the outline's bounding box just enough to
    // re-trigger sidebearing centering, which visibly shifts the whole
    // glyph sideways the instant the mouse is released — moving the
    // corner-round handle out from under the cursor and making it look like
    // it can no longer be grabbed to fine-tune the radius further.
    if (liveOutline) commitOutline(activeChar, liveOutline, { skipAutoSpacing: true });
    baseOutlineRef.current = null;
  }, [liveOutline, activeChar, commitOutline, finishMarquee, setLiveOutline]);

  const finishOpenContour = useCallback(() => {
    if (!drawingContourId) return;
    const hadLiveEdit = useAppStore.getState().liveOutline !== null;
    const latest = useAppStore.getState().liveOutline ?? outline;
    const working = cloneOutline(latest);
    // Auto Close Shape (Pen tool, Shape mode only — a "line" object is an
    // intentional open centerline per architecture and must never be
    // force-closed). Only points/handles already drawn are used; nothing is
    // added or moved, so the outline's actual node data is unchanged.
    let didClose = false;
    if (penAutoClose && penMode === "shape") {
      const contour = findContour(working, drawingContourId);
      if (contour && contour.nodes.length > 2 && !contour.closed) {
        contour.closed = true;
        didClose = true;
      }
    }
    setDrawingContourId(null);
    dragRef.current = null;
    baseOutlineRef.current = null;
    // Every node placed by the pen tool is already committed to history
    // the moment it's placed (see pointerUp), so finishing the contour
    // only needs its own undo step when it actually changes something —
    // auto-closing the shape, or finalizing an edit still in progress
    // (e.g. Escape pressed mid handle-drag) — otherwise skip the commit
    // so Finish/Escape doesn't add a redundant no-op undo step.
    if (didClose || hadLiveEdit) {
      commitOutline(activeChar, working);
    } else {
      setLiveOutline(null);
    }
  }, [drawingContourId, outline, activeChar, commitOutline, setDrawingContourId, penAutoClose, penMode, setLiveOutline]);

  const isCurrentEndpoint = useCallback((p: Point) => {
    if (!drawingContourId) return false;
    const contour = findContour(outline, drawingContourId);
    if (!contour || contour.nodes.length === 0) return false;
    const last = contour.nodes[contour.nodes.length - 1];
    return length(subtract(last.point, p)) <= hitRadius;
  }, [drawingContourId, outline, hitRadius]);

  return {
    outline, nodeableOutline, selectedNodes, selectedHandle, drawingContourId, marqueeRect, roundCornerLabel, handleSnapGuide,
    pointerDown, pointerMove, pointerUp, cycleNodeType, insertNodeAt,
    deleteSelectedNodes, nudgeNodes, finishOpenContour, isCurrentEndpoint,
    findObjectOfContour: (cid: string) => findObjectOfContour(outline, cid),
  };
}
