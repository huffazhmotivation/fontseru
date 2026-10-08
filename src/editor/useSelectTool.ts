import { useCallback, useMemo, useRef, useState } from "react";
import type { GlyphOutline, Point, VectorObject } from "@/types/geometry";
import { useAppStore } from "@/glyph/store";
import type { Affine, TransformPreview } from "./transformPreview";
import {
  objectsBounds,
  pointHitsObject,
  scaleObject,
  translateObject,
  rotateObject,
  skewObject,
  boundsIntersectRect,
  objectBounds,
  cloneObjectWithNewIds,
  type Bounds,
} from "./objectOps";
import { subtract } from "@/utils/geometry";
import { shortId } from "@/utils/id";

export type ResizeHandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type SkewHandleId = "skew-x-top" | "skew-x-bottom" | "skew-y-left" | "skew-y-right";
export type HandleId = ResizeHandleId | SkewHandleId | "rotate";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Handle centers in font-unit space (Y-up). rotateOffset is in font units. */
export function handlePositions(b: Bounds, rotateOffset: number, skewOffset = rotateOffset * 0.56): Record<HandleId, Point> {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return {
    nw: { x: b.minX, y: b.maxY },
    n: { x: cx, y: b.maxY },
    ne: { x: b.maxX, y: b.maxY },
    e: { x: b.maxX, y: cy },
    se: { x: b.maxX, y: b.minY },
    s: { x: cx, y: b.minY },
    sw: { x: b.minX, y: b.minY },
    w: { x: b.minX, y: cy },
    rotate: { x: cx, y: b.maxY + rotateOffset },
    "skew-x-top": { x: cx, y: b.maxY + skewOffset },
    "skew-x-bottom": { x: cx, y: b.minY - skewOffset },
    "skew-y-left": { x: b.minX - skewOffset, y: cy },
    "skew-y-right": { x: b.maxX + skewOffset, y: cy },
  };
}

function anchorForHandle(b: Bounds, h: ResizeHandleId): Point {
  switch (h) {
    case "nw": return { x: b.maxX, y: b.minY };
    case "ne": return { x: b.minX, y: b.minY };
    case "se": return { x: b.minX, y: b.maxY };
    case "sw": return { x: b.maxX, y: b.maxY };
    case "n": return { x: (b.minX + b.maxX) / 2, y: b.minY };
    case "s": return { x: (b.minX + b.maxX) / 2, y: b.maxY };
    case "e": return { x: b.minX, y: (b.minY + b.maxY) / 2 };
    case "w": return { x: b.maxX, y: (b.minY + b.maxY) / 2 };
    default: return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }
}

type DragState =
  | { mode: "move"; origin: Point; ids: string[] }
  | { mode: "resize"; handle: ResizeHandleId; anchor: Point; base: Bounds }
  | { mode: "rotate"; center: Point; startAngle: number }
  | { mode: "skew"; handle: SkewHandleId; origin: Point; anchor: Point; extent: number; baseShear: number }
  | { mode: "marquee"; origin: Point; additive: boolean }
  | null;

function isResizeHandle(handle: HandleId): handle is ResizeHandleId {
  return ["nw", "n", "ne", "e", "se", "s", "sw", "w"].includes(handle);
}

function isSkewHandle(handle: HandleId): handle is SkewHandleId {
  return handle.startsWith("skew-");
}

function rectFrom(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Soft-snap tolerance in screen pixels — kept small and gentle so it never
 * fights the pointer; converted to font units via hitScale at call time. */
const SNAP_TOLERANCE_PX = 8;

/**
 * Nudges a proposed set of edge positions (e.g. an object's min/max on one
 * axis) toward the nearest value in `targets` (guide-line positions in font
 * units) when within `tolerance` units of it. Returns the correction to add
 * to that axis's delta, or 0 when nothing is close enough — this is what
 * keeps the snap soft/non-forcing instead of a hard magnetic lock.
 */
function snapCorrection(edges: number[], targets: number[], tolerance: number): number {
  let correction = 0;
  let bestDist = tolerance;
  for (const edge of edges) {
    for (const target of targets) {
      const dist = Math.abs(target - edge);
      if (dist < bestDist) {
        bestDist = dist;
        correction = target - edge;
      }
    }
  }
  return correction;
}

/** Snaps a single point's x/y independently toward the nearest guide within
 * tolerance on each axis — used while resizing/scaling, where the dragged
 * handle position itself (not a delta) determines the new bounds. */
function snapPoint(p: Point, xTargets: number[], yTargets: number[], tolerance: number): Point {
  let x = p.x;
  let y = p.y;
  let bestDx = tolerance;
  for (const t of xTargets) {
    const d = Math.abs(t - x);
    if (d < bestDx) { bestDx = d; x = t; }
  }
  let bestDy = tolerance;
  for (const t of yTargets) {
    const d = Math.abs(t - y);
    if (d < bestDy) { bestDy = d; y = t; }
  }
  return { x, y };
}


/** A group is a selection unit without becoming a new geometry container. */
function selectionUnitIds(outline: GlyphOutline, objectId: string): string[] {
  const hit = outline.objects.find((o) => o.id === objectId);
  if (!hit?.groupId) return [objectId];
  return outline.objects.filter((o) => o.groupId === hit.groupId).map((o) => o.id);
}

function expandGroupsInSelection(outline: GlyphOutline, ids: string[]): string[] {
  const out = new Set(ids);
  for (const id of ids) {
    for (const member of selectionUnitIds(outline, id)) out.add(member);
  }
  return [...out];
}

/**
 * Stamps fresh-id copies of the objects whose ids are in `ids`, preserving
 * group relationships (each source group maps to one new group id). Used by
 * the Cmd/Ctrl + drag "duplicate on drag" gesture, both when the modifier is
 * held at press time and when it's pressed part-way through a move drag.
 */
function duplicateObjects(objects: VectorObject[], ids: string[]): VectorObject[] {
  const groupMap = new Map<string, string>();
  const wanted = new Set(ids);
  return objects
    .filter((o) => wanted.has(o.id))
    .map((o) => {
      const clone = cloneObjectWithNewIds(o);
      if (o.groupId) {
        let nextGroup = groupMap.get(o.groupId);
        if (!nextGroup) {
          nextGroup = shortId("group");
          groupMap.set(o.groupId, nextGroup);
        }
        clone.groupId = nextGroup;
      } else {
        delete clone.groupId;
      }
      return clone;
    });
}

const EMPTY_OUTLINE: GlyphOutline = { objects: [] };

/** hitScale = font units per screen pixel (1/scale); used for hit tolerances. */
export function useSelectTool(hitScale: number) {
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const liveOutline = useAppStore((s) => s.liveOutline);
  const selectedObjectIds = useAppStore((s) => s.selectedObjectIds);
  const selectObjects = useAppStore((s) => s.selectObjects);
  const clearObjectSelection = useAppStore((s) => s.clearObjectSelection);
  const commitOutline = useAppStore((s) => s.commitOutline);
  const setLiveOutline = useAppStore((s) => s.setLiveOutline);
  const setSelectionSkewState = useAppStore((s) => s.setSelectionSkewState);
  const selectionSkewAngle = useAppStore((s) => s.selectionSkewAngle);
  const selectionSkewHandle = useAppStore((s) => s.selectionSkewHandle);
  const strokeWidthLocked = useAppStore((s) => s.strokeWidthLocked);
  const sketchMode = useAppStore((s) => s.sketchMode);
  const snapEnabled = useAppStore((s) => s.snapEnabled);
  const metrics = useAppStore((s) => s.metrics);

  const dragRef = useRef<DragState>(null);
  const baseRef = useRef<GlyphOutline | null>(null);
  // True once a Cmd/Ctrl+drag has already stamped its duplicate for the
  // current gesture, so pressing/holding the modifier during a move never
  // stamps a second copy.
  const dupStampedRef = useRef(false);
  const [marqueeRect, setMarqueeRect] = useState<Rect | null>(null);
  // Mirror of marqueeRect for pointerUp: the last pointer-move is flushed
  // synchronously right before pointerUp, so the state value in pointerUp's
  // closure would still be one frame behind.
  const marqueeRectRef = useRef<Rect | null>(null);
  const setMarquee = useCallback((rect: Rect | null) => {
    marqueeRectRef.current = rect;
    setMarqueeRect(rect);
  }, []);
  // See transformPreview.ts — lets the canvas render dragged objects from
  // their stable base identity plus an SVG transform.
  const [dragPreview, setDragPreview] = useState<TransformPreview | null>(null);
  const [hoverHandle, setHoverHandle] = useState<HandleId | null>(null);
  const hoverHandleRef = useRef<HandleId | null>(null);

  const updateHoverHandle = useCallback((next: HandleId | null) => {
    // Chrome can deliver pointermove considerably faster than React can paint.
    // Avoid turning every hover sample into a React render when the cursor is
    // still over the same handle (the common case over dense artwork).
    if (hoverHandleRef.current === next) return;
    hoverHandleRef.current = next;
    setHoverHandle(next);
  }, []);

  const outline: GlyphOutline = liveOutline ?? glyph?.outline ?? EMPTY_OUTLINE;
  // Flattening every selected object is not free — only redo it when the
  // outline or selection actually changed (also keeps `bounds` identity
  // stable so findHandle/pointerDown aren't recreated every render).
  const bounds = useMemo(() => objectsBounds(outline, selectedObjectIds), [outline, selectedObjectIds]);
  const selectedSet = useMemo(() => new Set(selectedObjectIds), [selectedObjectIds]);
  const handleTol = 9 * hitScale;
  const rotateOffset = 26 * hitScale;
  const skewOffset = 14 * hitScale;
  const snapTolerance = SNAP_TOLERANCE_PX * hitScale;
  // Snap targets mirror the guide lines actually drawn on canvas: the
  // horizontal metric guides (baseline always visible; the rest gated by
  // "Guides") plus the glyph's own vertical LSB/advance-width guides — never
  // the grid, per how this feature was asked for.
  const glyphLsb = glyph?.lsb;
  const glyphAdvance = glyph?.advanceWidth;
  const horizontalSnapTargets = useMemo(
    () => (snapEnabled ? [metrics.ascender, metrics.capHeight, metrics.xHeight, metrics.baseline, metrics.descender] : []),
    [snapEnabled, metrics.ascender, metrics.capHeight, metrics.xHeight, metrics.baseline, metrics.descender]
  );
  const verticalSnapTargets = useMemo(
    () => (snapEnabled && glyphLsb != null && glyphAdvance != null ? [glyphLsb, glyphAdvance] : []),
    [snapEnabled, glyphLsb, glyphAdvance]
  );

  const findHandle = useCallback(
    (p: Point): HandleId | null => {
      if (!bounds) return null;
      const hp = handlePositions(bounds, rotateOffset, skewOffset);
      let best: HandleId | null = null;
      let bestD = handleTol;
      (Object.keys(hp) as HandleId[]).forEach((id) => {
        const d = Math.hypot(hp[id].x - p.x, hp[id].y - p.y);
        if (d <= bestD) { best = id; bestD = d; }
      });
      return best;
    },
    [bounds, handleTol, rotateOffset, skewOffset]
  );

  const pointerDown = useCallback(
    (p: Point, shiftKey: boolean, metaKey = false) => {
      // Fresh gesture: no duplicate stamped yet (may be set below or mid-drag).
      dupStampedRef.current = false;
      // 1. handle on the current selection?
      const handle = findHandle(p);
      if (handle && bounds) {
        // Transforms below are pure (translateObject/scaleObject/... return
        // new objects), so the base can be referenced instead of deep-cloned.
        baseRef.current = outline;
        if (handle === "rotate") {
          const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
          dragRef.current = { mode: "rotate", center, startAngle: Math.atan2(p.y - center.y, p.x - center.x) };
        } else if (isSkewHandle(handle)) {
          const horizontal = handle === "skew-x-top" || handle === "skew-x-bottom";
          const topOrRight = handle === "skew-x-top" || handle === "skew-y-right";
          const anchor = horizontal
            ? { x: 0, y: topOrRight ? bounds.minY : bounds.maxY }
            : { x: topOrRight ? bounds.minX : bounds.maxX, y: 0 };
          const extent = horizontal
            ? ((topOrRight ? bounds.maxY : bounds.minY) - anchor.y || 1)
            : ((topOrRight ? bounds.maxX : bounds.minX) - anchor.x || 1);
          const sameSkewAxis = selectionSkewHandle === handle;
          const baseShear = sameSkewAxis ? Math.tan((selectionSkewAngle * Math.PI) / 180) : 0;
          dragRef.current = { mode: "skew", handle, origin: p, anchor, extent, baseShear };
          setSelectionSkewState(sameSkewAxis ? selectionSkewAngle : 0, handle);
        } else if (isResizeHandle(handle)) {
          dragRef.current = { mode: "resize", handle, anchor: anchorForHandle(bounds, handle), base: bounds };
        }
        return;
      }

      // 2. clicked an object?
      const tol = 6 * hitScale;
      let hitId: string | null = null;
      for (let i = outline.objects.length - 1; i >= 0; i--) {
        if (pointHitsObject(outline.objects[i], p, tol)) { hitId = outline.objects[i].id; break; }
      }
      if (hitId) {
        const unitIds = selectionUnitIds(outline, hitId);

        // Cmd/Ctrl + click-drag on an object: stamp a copy in place and drag
        // that copy, leaving the original(s) untouched — the classic
        // "modifier + drag to duplicate" gesture from vector editors.
        //
        // If the clicked object is part of the current multi-selection, the
        // WHOLE selection is duplicated and dragged together; if it's outside
        // the selection, only the clicked object (its group unit) duplicates.
        if (metaKey) {
          const clickedInSelection = unitIds.some((id) => selectedObjectIds.includes(id));
          const sourceIds = clickedInSelection
            ? expandGroupsInSelection(outline, selectedObjectIds)
            : unitIds;
          const duplicates = duplicateObjects(outline.objects, sourceIds);
          const withDuplicates: GlyphOutline = { objects: [...outline.objects, ...duplicates] };
          baseRef.current = withDuplicates;
          setLiveOutline(withDuplicates);
          const dupIds = duplicates.map((d) => d.id);
          selectObjects(dupIds);
          dragRef.current = { mode: "move", origin: p, ids: dupIds };
          dupStampedRef.current = true;
          return;
        }

        let dragIds = unitIds;
        const selectedSet = new Set(selectedObjectIds);
        if (shiftKey) {
          const allSelected = unitIds.every((id) => selectedSet.has(id));
          selectObjects(unitIds, true);
          const unitSet = new Set(unitIds);
          dragIds = allSelected
            ? selectedObjectIds.filter((id) => !unitSet.has(id))
            : [...new Set([...selectedObjectIds, ...unitIds])];
        } else if (!unitIds.every((id) => selectedSet.has(id))) {
          selectObjects(unitIds);
        } else {
          dragIds = selectedObjectIds;
        }
        baseRef.current = outline;
        if (dragIds.length > 0) dragRef.current = { mode: "move", origin: p, ids: dragIds };
        return;
      }

      // 3. empty space -> marquee
      if (!shiftKey) clearObjectSelection();
      dragRef.current = { mode: "marquee", origin: p, additive: shiftKey };
      setMarquee({ x: p.x, y: p.y, w: 0, h: 0 });
    },
    [findHandle, bounds, outline, hitScale, selectedObjectIds, selectObjects, clearObjectSelection, setSelectionSkewState, selectionSkewAngle, selectionSkewHandle, setLiveOutline, setMarquee]
  );

  const pointerMove = useCallback(
    (p: Point, shiftKey: boolean, pointerType?: string, metaKey = false) => {
      const drag = dragRef.current;
      if (!drag) {
        updateHoverHandle(findHandle(p));
        return;
      }
      if (drag.mode === "marquee") {
        setMarquee(rectFrom(drag.origin, p));
        return;
      }
      let base = baseRef.current;
      if (!base) return;

      if (drag.mode === "move") {
        let moveIds = drag.ids;
        const moveOrigin = drag.origin;
        // Cmd/Ctrl pressed AFTER the move drag already started ("klik dulu
        // baru Cmd"): stamp duplicates of the objects being moved, at their
        // original positions, then continue dragging the copies — leaving the
        // originals where they were. Done once per gesture.
        if (metaKey && !dupStampedRef.current) {
          dupStampedRef.current = true;
          const duplicates = duplicateObjects(base.objects, moveIds);
          const withDuplicates: GlyphOutline = { objects: [...base.objects, ...duplicates] };
          baseRef.current = withDuplicates;
          base = baseRef.current;
          moveIds = duplicates.map((dp) => dp.id);
          selectObjects(moveIds);
          dragRef.current = { mode: "move", origin: moveOrigin, ids: moveIds };
        }
        let d = subtract(p, moveOrigin);
        if (shiftKey) d = Math.abs(d.x) >= Math.abs(d.y) ? { x: d.x, y: 0 } : { x: 0, y: d.y };
        if (!shiftKey && (horizontalSnapTargets.length || verticalSnapTargets.length)) {
          const movingBounds = objectsBounds(base, moveIds);
          if (movingBounds) {
            d = {
              x: d.x + snapCorrection([movingBounds.minX + d.x, movingBounds.maxX + d.x], verticalSnapTargets, snapTolerance),
              y: d.y + snapCorrection([movingBounds.minY + d.y, movingBounds.maxY + d.y], horizontalSnapTargets, snapTolerance),
            };
          }
        }
        const moveSet = new Set(moveIds);
        const objects = base.objects.map((o) =>
          moveSet.has(o.id) ? translateObject(o, d.x, d.y) : o
        );
        setLiveOutline({ objects });
        setDragPreview({ kind: "move", baseObjects: base.objects, ids: moveSet, matrix: [1, 0, 0, 1, d.x, d.y] });
        return;
      }

      if (drag.mode === "resize") {
        const b = drag.base;
        const anchor = drag.anchor;
        const horiz = drag.handle !== "n" && drag.handle !== "s";
        const vert = drag.handle !== "e" && drag.handle !== "w";
        const snappedP = horizontalSnapTargets.length || verticalSnapTargets.length
          ? snapPoint(p, horiz ? verticalSnapTargets : [], vert ? horizontalSnapTargets : [], snapTolerance)
          : p;
        const w0 = b.maxX - b.minX || 1;
        const h0 = b.maxY - b.minY || 1;
        let sx = horiz ? (snappedP.x - anchor.x) / (handleSign(drag.handle, "x") * w0 || 1) : 1;
        let sy = vert ? (snappedP.y - anchor.y) / (handleSign(drag.handle, "y") * h0 || 1) : 1;
        if (!horiz) sx = 1;
        if (!vert) sy = 1;
        // Desktop: Shift locks proportions. Sketch Mode + touch (1-finger
        // drag) has no Shift key available, so it locks automatically —
        // scoped to this resize branch only, so pan/move/skew gestures are
        // completely unaffected.
        const lockAspect = shiftKey || (sketchMode && pointerType === "touch");
        if (lockAspect && horiz && vert) { const s = Math.max(Math.abs(sx), Math.abs(sy)); sx = Math.sign(sx) * s; sy = Math.sign(sy) * s; }
        sx = clampScale(sx);
        sy = clampScale(sy);
        const objects = base.objects.map((o) =>
          selectedSet.has(o.id) ? scaleObject(o, anchor, sx, sy, strokeWidthLocked) : o
        );
        setLiveOutline({ objects });
        setDragPreview({
          kind: "resize",
          baseObjects: base.objects,
          ids: selectedSet,
          matrix: [sx, 0, 0, sy, anchor.x * (1 - sx), anchor.y * (1 - sy)],
        });
        return;
      }

      if (drag.mode === "skew") {
        const horizontal = drag.handle === "skew-x-top" || drag.handle === "skew-x-bottom";
        let amount = horizontal ? (p.x - drag.origin.x) / drag.extent : (p.y - drag.origin.y) / drag.extent;
        // Shift gives a restrained 15°-style step, useful for intentional italic/oblique edits.
        if (shiftKey) {
          const step = Math.tan(Math.PI / 12);
          amount = Math.round(amount / step) * step;
        }
        // Preserve the existing per-drag safety clamp.
        amount = Math.max(-3, Math.min(3, amount));
        const totalShear = drag.baseShear + amount;
        setSelectionSkewState((Math.atan(totalShear) * 180) / Math.PI, drag.handle);
        const shX = horizontal ? amount : 0;
        const shY = horizontal ? 0 : amount;
        const objects = base.objects.map((o) =>
          selectedSet.has(o.id)
            ? skewObject(o, drag.anchor, shX, shY)
            : o
        );
        setLiveOutline({ objects });
        setDragPreview({
          kind: "skew",
          baseObjects: base.objects,
          ids: selectedSet,
          matrix: [1, shY, shX, 1, -shX * drag.anchor.y, -shY * drag.anchor.x],
        });
        return;
      }

      if (drag.mode === "rotate") {
        let angle = Math.atan2(p.y - drag.center.y, p.x - drag.center.x) - drag.startAngle;
        if (shiftKey) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
        const objects = base.objects.map((o) =>
          selectedSet.has(o.id) ? rotateObject(o, drag.center, angle) : o
        );
        setLiveOutline({ objects });
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const { x: cx, y: cy } = drag.center;
        const matrix: Affine = [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos];
        setDragPreview({ kind: "rotate", baseObjects: base.objects, ids: selectedSet, matrix });
      }
    },
    [findHandle, selectedSet, selectObjects, setLiveOutline, setSelectionSkewState, strokeWidthLocked, sketchMode, horizontalSnapTargets, verticalSnapTargets, snapTolerance, updateHoverHandle, setMarquee]
  );

  const pointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    dupStampedRef.current = false;
    if (!drag) return;
    setDragPreview(null);

    if (drag.mode === "marquee") {
      const rect = marqueeRectRef.current;
      if (rect && (rect.w > 2 || rect.h > 2)) {
        const found: string[] = [];
        for (const o of outline.objects) {
          if (boundsIntersectRect(objectBounds(o), rect.x, rect.y, rect.w, rect.h)) found.push(o.id);
        }
        selectObjects(expandGroupsInSelection(outline, found), drag.additive);
      }
      setMarquee(null);
      return;
    }
    // Reached for move, resize, rotate, and skew drags of an already-
    // existing selection — the exact same category useGlyphEditor.ts skips
    // Auto Spacing for (move-selection, handle-drag, corner-round): no new
    // ink is being drawn, an already-positioned object/glyph is just being
    // repositioned/transformed. Without this, dragging a shape to align it
    // to the baseline (or resizing/rotating it) nudges the outline's
    // bounding box just enough to re-trigger live sidebearing centering,
    // which visibly shifts the whole glyph sideways/vertically the instant
    // the mouse is released — undoing the very alignment the drag was
    // trying to make. Cmd/Ctrl+drag-to-duplicate also lands in "move" mode;
    // treated the same way, since the duplicate is existing ink being
    // repositioned, not a freshly hand-drawn stroke.
    // Read from the store, not this render's closure: the final coalesced
    // pointer-move is flushed synchronously right before pointerUp, and its
    // setLiveOutline hasn't re-rendered into `liveOutline` yet.
    const latest = useAppStore.getState().liveOutline;
    if (latest) commitOutline(activeChar, latest, { skipAutoSpacing: true });
    baseRef.current = null;
  }, [outline, selectObjects, activeChar, commitOutline, setMarquee]);

  /** Abandons the in-progress gesture without committing it (pointercancel). */
  const cancel = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    dupStampedRef.current = false;
    baseRef.current = null;
    setDragPreview(null);
    setMarquee(null);
    if (drag && drag.mode !== "marquee" && useAppStore.getState().liveOutline) setLiveOutline(null);
  }, [setLiveOutline, setMarquee]);

  /** Drops gesture bookkeeping only (no store writes) — for a tool switch
   *  mid-gesture, where the store's setTool already finalizes liveOutline. */
  const reset = useCallback(() => {
    dragRef.current = null;
    dupStampedRef.current = false;
    baseRef.current = null;
    setDragPreview(null);
    setMarquee(null);
  }, [setMarquee]);

  return useMemo(
    () => ({ pointerDown, pointerMove, pointerUp, cancel, reset, bounds, marqueeRect, hoverHandle, rotateOffset, skewOffset, dragPreview }),
    [pointerDown, pointerMove, pointerUp, cancel, reset, bounds, marqueeRect, hoverHandle, rotateOffset, skewOffset, dragPreview]
  );
}

function handleSign(h: ResizeHandleId, axis: "x" | "y"): number {
  if (axis === "x") return h.includes("e") ? 1 : h.includes("w") ? -1 : 1;
  return h.includes("n") ? 1 : h.includes("s") ? -1 : 1;
}
function clampScale(s: number): number {
  if (!isFinite(s)) return 1;
  if (Math.abs(s) < 0.02) return 0.02 * (s < 0 ? -1 : 1);
  return s;
}
