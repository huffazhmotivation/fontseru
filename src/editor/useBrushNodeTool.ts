import { useCallback, useMemo, useRef, useState } from "react";
import type { PathNode, Point, VectorObject } from "@/types/geometry";
import { useAppStore } from "@/glyph/store";
import { shortId } from "@/utils/id";
import { reflect, subtract, length } from "@/utils/geometry";
import { brushOutlineContours } from "@/brushes/strokeToOutline";

/**
 * Brush tool, Node draw mode (see BrushDrawMode in glyph/store.ts).
 *
 * This is the Pen-tool gesture — click to place a corner anchor, click-drag
 * to pull a symmetric curve handle out of it, click back on the first
 * anchor to close the path — but the committed result is a real "brush"
 * object built from the CURRENT brush preset/size/taper/texture, exactly
 * like a freehand stroke from useBrushTool. It is intentionally a separate,
 * self-contained hook rather than a reuse of useGlyphEditor's Pen-tool
 * machinery: the Pen tool's `penMode` ("shape" | "line") is user-facing
 * state of its own, and this must never be able to change what the actual
 * Pen tool does the next time it's picked.
 */
export function useBrushNodeTool(hitScale: number) {
  const brush = useAppStore((s) => s.brush);
  const brushCap = useAppStore((s) => s.brushCap);

  // The in-progress path. Kept in a ref (for synchronous read/write across
  // pointer events, matching every other tool in this file) plus a bit of
  // React state so the canvas can re-render the live preview as nodes and
  // handles change.
  const nodesRef = useRef<PathNode[]>([]);
  const [liveNodes, setLiveNodes] = useState<PathNode[]>([]);
  const draggingIndexRef = useRef<number | null>(null);
  // True while the pointer is down on/near the FIRST anchor to close the
  // path — see the pointerDown/pointerMove/pointerUp comments below for why
  // closing is a drag gesture (shape the last segment's curve) rather than
  // something that commits instantly on pointerDown.
  const closingRef = useRef(false);
  // Mirrors `closingRef` as React state, purely so the Monoline live preview
  // can draw the closing segment while the first anchor's handle is being
  // dragged (the ref alone doesn't trigger a re-render).
  const [isClosing, setIsClosing] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  // The glyph this in-progress path belongs to. In Multi Glyph mode the
  // active glyph can change between clicks (each cell is a live canvas), so
  // the path must be committed to the glyph it was STARTED on — never to
  // whichever glyph happens to be active at commit time, and never by
  // reading a `glyph`/`activeChar` captured in a stale render closure.
  const pathCharRef = useRef<string | null>(null);

  const hitRadius = 10 * hitScale;
  const closeRadius = 14 * hitScale;
  const dragThreshold = 1.5 * hitScale;

  const buildObject = useCallback(
    (nodes: PathNode[], closed: boolean, id: string): VectorObject => ({
      id,
      kind: "brush",
      contours: [{ id: `${id}-contour`, nodes: nodes.map((n) => ({ ...n })), closed }],
      strokeWidth: brush.size,
      cap: brush.type === "monoline" ? brushCap : "round",
      join: "round",
      brushType: brush.type,
      brushSettings: { ...brush, gridSnap: undefined },
    }),
    [brush, brushCap]
  );

  const reset = useCallback(() => {
    nodesRef.current = [];
    draggingIndexRef.current = null;
    closingRef.current = false;
    pathCharRef.current = null;
    setIsClosing(false);
    setLiveNodes([]);
    setIsDrawing(false);
  }, []);

  const finish = useCallback(
    (closed: boolean) => {
      const nodes = nodesRef.current;
      const char = pathCharRef.current;
      // Read the target glyph fresh from the store (not from a render
      // closure) so this is correct in Multi Glyph mode too, right after a
      // synchronous active-glyph switch.
      const st = useAppStore.getState();
      const glyph = char ? st.glyphs[char] : undefined;
      if (nodes.length < 2 || !char || !glyph) {
        reset();
        return;
      }
      const obj = buildObject(nodes, closed, shortId("obj"));
      st.commitOutline(char, { objects: [...glyph.outline.objects, obj] });
      reset();
    },
    [reset, buildObject]
  );

  const pointerDown = useCallback(
    (p: Point) => {
      // Multi Glyph mode: pointing into a different glyph's cell while a
      // path is still open on another one finishes that path (open, exactly
      // as drawn) on ITS glyph, then starts a fresh path here. Without this
      // the new click would be appended to the old glyph's node list.
      const currentChar = useAppStore.getState().activeChar;
      if (nodesRef.current.length > 0 && pathCharRef.current !== currentChar) {
        finish(false);
      }
      const nodes = nodesRef.current;
      if (nodes.length > 0) {
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        // Click back near the first anchor (2+ nodes already placed) starts
        // closing the path. Like every other anchor, this is a drag
        // gesture — pointerMove below shapes the closing segment's curve by
        // dragging out the first anchor's incoming handle, and the loop
        // only actually commits on pointerUp. Committing immediately here
        // (on pointerDown) was the bug: it made the very last segment of a
        // closed shape impossible to curve, unlike every other segment.
        if (nodes.length > 1 && length(subtract(first.point, p)) <= closeRadius) {
          closingRef.current = true;
          setIsClosing(true);
          draggingIndexRef.current = null;
          return;
        }
        // Click again on the current endpoint: convert it to a plain corner
        // (drop its outgoing handle) instead of adding a coincident node —
        // this is how you end a curved run with a straight segment next.
        if (length(subtract(last.point, p)) <= hitRadius) {
          last.type = "corner";
          last.handleOut = null;
          draggingIndexRef.current = null;
          setLiveNodes([...nodes]);
          return;
        }
        const node: PathNode = { id: shortId("node"), point: p, handleIn: null, handleOut: null, type: "corner" };
        nodes.push(node);
        draggingIndexRef.current = nodes.length - 1;
        setLiveNodes([...nodes]);
        return;
      }
      // First anchor of a brand-new path.
      const node: PathNode = { id: shortId("node"), point: p, handleIn: null, handleOut: null, type: "corner" };
      nodesRef.current = [node];
      pathCharRef.current = currentChar;
      draggingIndexRef.current = 0;
      setIsDrawing(true);
      setLiveNodes([node]);
    },
    [hitRadius, closeRadius, finish]
  );

  const pointerMove = useCallback(
    (p: Point) => {
      const nodes = nodesRef.current;
      if (closingRef.current) {
        // Shaping the closing segment: drag out the first anchor's
        // incoming handle (mirrored onto its outgoing handle only if it
        // didn't already have one of its own, so the path's very first
        // segment isn't reshaped by closing the last one).
        const first = nodes[0];
        if (!first) return;
        if (length(subtract(p, first.point)) < dragThreshold) {
          first.handleIn = null;
        } else {
          first.handleIn = p;
          if (!first.handleOut) first.handleOut = reflect(p, first.point);
        }
        setLiveNodes([...nodes]);
        return;
      }
      const idx = draggingIndexRef.current;
      if (idx == null) return;
      const node = nodes[idx];
      if (!node) return;
      // Dragging far enough from the anchor pulls out a symmetric curve
      // handle (reflected on the opposite side, Illustrator/Pen-tool
      // style); staying within the threshold keeps/returns it to a corner.
      if (length(subtract(p, node.point)) < dragThreshold) {
        node.handleIn = null;
        node.handleOut = null;
        node.type = "corner";
      } else {
        node.handleOut = p;
        node.handleIn = reflect(p, node.point);
        node.type = "symmetric";
      }
      setLiveNodes([...nodes]);
    },
    [dragThreshold]
  );

  const pointerUp = useCallback(() => {
    if (closingRef.current) {
      closingRef.current = false;
      setIsClosing(false);
      finish(true);
      return;
    }
    // A drag session always ends at pointerUp, regardless of how many
    // anchors have been placed so far — the next pointerMove (mouse now up,
    // just hovering toward the next click) must NOT keep reshaping the
    // handle of whichever anchor was last dragged.
    draggingIndexRef.current = null;
  }, [finish]);

  /** Double-click / Enter: finish the path open, exactly as drawn. */
  const finishOpen = useCallback(() => finish(false), [finish]);

  /** Escape: finish an open path if there's enough of one to keep, otherwise
   * discard the in-progress gesture entirely. */
  const escape = useCallback(() => {
    if (nodesRef.current.length >= 2) finish(false);
    else reset();
  }, [finish, reset]);

  const cancel = useCallback(() => reset(), [reset]);

  /** Live silhouette for the VARIABLE-width brushes: the path drawn so far,
   * handed straight to `brushOutlineContours` — the exact function every
   * committed variable brush object (freehand or Node) is rendered with in
   * ObjectsLayer/export — so preview and result share one code path.
   *
   * Monoline is deliberately NOT handled here (returns []): its committed
   * result is not an outline at all, it's the native SVG stroke of the
   * centerline (see ObjectShape/getGlyphPaths). Running it through
   * `brushOutlineContours` for the live preview flattened + RDP-simplified
   * the curve and rebuilt it as a polygon, so curves, joins and caps looked
   * subtly different while drawing than after finishing. Monoline uses
   * `previewStrokeObject` below instead. */
  const previewOutline = useMemo(() => {
    if (brush.type === "monoline") return [];
    if (liveNodes.length < 2) return [];
    const obj = buildObject(liveNodes, false, "brush-node-preview");
    return brushOutlineContours(obj);
  }, [liveNodes, buildObject, brush.type]);

  /** Live Monoline preview: the SAME object shape that gets committed
   * (same strokeWidth / cap / round join / centerline), so the canvas can
   * paint it with the exact same native stroke as a committed monoline —
   * pixel-identical to the final result. While the closing click is being
   * dragged it's previewed closed, so the last segment's curve is visible
   * too, just like the finished shape. */
  const previewStrokeObject = useMemo<VectorObject | null>(() => {
    if (brush.type !== "monoline") return null;
    if (liveNodes.length < 2) return null;
    return buildObject(liveNodes, isClosing, "brush-node-preview");
  }, [liveNodes, buildObject, brush.type, isClosing]);

  return {
    pointerDown,
    pointerMove,
    pointerUp,
    finishOpen,
    escape,
    cancel,
    isDrawing,
    liveNodes,
    previewOutline,
    previewStrokeObject,
  };
}
