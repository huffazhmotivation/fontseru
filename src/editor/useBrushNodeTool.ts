import { useCallback, useRef, useState } from "react";
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
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const commitOutline = useAppStore((s) => s.commitOutline);

  // The in-progress path. Kept in a ref (for synchronous read/write across
  // pointer events, matching every other tool in this file) plus a bit of
  // React state so the canvas can re-render the live preview as nodes and
  // handles change.
  const nodesRef = useRef<PathNode[]>([]);
  const [liveNodes, setLiveNodes] = useState<PathNode[]>([]);
  const draggingIndexRef = useRef<number | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

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
    setLiveNodes([]);
    setIsDrawing(false);
  }, []);

  const finish = useCallback(
    (closed: boolean) => {
      const nodes = nodesRef.current;
      if (nodes.length < 2 || !glyph) {
        reset();
        return;
      }
      const obj = buildObject(nodes, closed, shortId("obj"));
      commitOutline(activeChar, { objects: [...glyph.outline.objects, obj] });
      reset();
    },
    [glyph, activeChar, commitOutline, reset, buildObject]
  );

  const pointerDown = useCallback(
    (p: Point) => {
      const nodes = nodesRef.current;
      if (nodes.length > 0) {
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        // Click back near the first anchor (2+ nodes already placed) closes
        // the path into a loop and commits it, Pen-tool style.
        if (nodes.length > 1 && length(subtract(first.point, p)) <= closeRadius) {
          finish(true);
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
      draggingIndexRef.current = 0;
      setIsDrawing(true);
      setLiveNodes([node]);
    },
    [finish, hitRadius, closeRadius]
  );

  const pointerMove = useCallback(
    (p: Point) => {
      const idx = draggingIndexRef.current;
      if (idx == null) return;
      const nodes = nodesRef.current;
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
    // A drag session always ends at pointerUp, regardless of how many
    // anchors have been placed so far — the next pointerMove (mouse now up,
    // just hovering toward the next click) must NOT keep reshaping the
    // handle of whichever anchor was last dragged.
    draggingIndexRef.current = null;
  }, []);

  /** Double-click / Enter: finish the path open, exactly as drawn. */
  const finishOpen = useCallback(() => finish(false), [finish]);

  /** Escape: finish an open path if there's enough of one to keep, otherwise
   * discard the in-progress gesture entirely. */
  const escape = useCallback(() => {
    if (nodesRef.current.length >= 2) finish(false);
    else reset();
  }, [finish, reset]);

  const cancel = useCallback(() => reset(), [reset]);

  /** Live variable-width outline (the true brush silhouette) for the path
   * drawn so far. Built by handing a same-shaped object straight to
   * `brushOutlineContours` — the exact function every committed brush
   * object (freehand or Node) is rendered with in ObjectsLayer/export —
   * instead of a separate hand-rolled flatten+expand pipeline. That parallel
   * pipeline was the bug: it diverged from the real renderer just enough
   * (missing the RDP polyline simplification and the corner/join handling
   * `brushOutlineContours` applies) to make the live preview look broken —
   * a bare node/handle skeleton with no filled stroke — while the committed
   * result, going through the real renderer, came out correctly. Preview
   * and result now literally share one code path, so they can't diverge. */
  const previewOutline = (() => {
    if (liveNodes.length < 2) return [];
    const obj = buildObject(liveNodes, false, "brush-node-preview");
    return brushOutlineContours(obj);
  })();

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
  };
}
