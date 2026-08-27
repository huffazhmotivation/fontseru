import type { Contour, Point, PathNode } from "@/types/geometry";
import { shortId } from "@/utils/id";

/**
 * Kinds of primitive the Shape tool can draw. Kept separate from
 * `ObjectKind` (types/geometry.ts) on purpose — a drawn rectangle/ellipse/
 * polygon is still just a normal `"shape"` VectorObject once it lands in
 * the outline; this only describes *how the tool currently drags out* the
 * next one.
 */
export type ShapeKind = "rectangle" | "ellipse" | "polygon";

/** Below this size (font units) a drag is treated as an accidental click,
 * not an intentional shape — mirrors the marquee/segment-hit tolerances
 * used elsewhere in the editor. */
const MIN_SHAPE_SIZE = 4;

/** Bezier control-point ratio for approximating a quarter-circle arc. */
const KAPPA = 0.5522847498;

/** Regular polygon vertex count for the "polygon" shape kind — a triangle,
 * per the tool's own icon/label. */
const POLYGON_SIDES = 3;

interface Box { minX: number; minY: number; w: number; h: number; }

/** Turns the two drag points into an axis-aligned box. When `square` is
 * true (Shift held), the box is forced to equal width/height — a square
 * for the rectangle tool, a circle for the ellipse tool, a regular
 * (non-stretched) polygon for the polygon tool — anchored at the drag's
 * starting corner, matching standard vector-tool Shift behavior. */
function normalizeBox(a: Point, b: Point, square: boolean): Box {
  let w = b.x - a.x;
  let h = b.y - a.y;
  if (square) {
    const size = Math.max(Math.abs(w), Math.abs(h));
    w = (w < 0 ? -1 : 1) * size;
    h = (h < 0 ? -1 : 1) * size;
  }
  return { minX: Math.min(a.x, a.x + w), minY: Math.min(a.y, a.y + h), w: Math.abs(w), h: Math.abs(h) };
}

function cornerNode(point: Point): PathNode {
  return { id: shortId("node"), point, handleIn: null, handleOut: null, type: "corner" };
}

function rectangleContour(box: Box): Contour {
  const { minX, minY, w, h } = box;
  const nodes = [
    cornerNode({ x: minX, y: minY }),
    cornerNode({ x: minX + w, y: minY }),
    cornerNode({ x: minX + w, y: minY + h }),
    cornerNode({ x: minX, y: minY + h }),
  ];
  return { id: shortId("contour"), nodes, closed: true };
}

function ellipseContour(box: Box): Contour {
  const cx = box.minX + box.w / 2;
  const cy = box.minY + box.h / 2;
  const rx = box.w / 2;
  const ry = box.h / 2;
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;

  // Four on-curve points at east/north/west/south, each with symmetric
  // handles along its tangent — the standard 4-cubic circle/ellipse
  // approximation.
  const east: PathNode = {
    id: shortId("node"), point: { x: cx + rx, y: cy }, type: "smooth",
    handleOut: { x: cx + rx, y: cy + ky }, handleIn: { x: cx + rx, y: cy - ky },
  };
  const north: PathNode = {
    id: shortId("node"), point: { x: cx, y: cy + ry }, type: "smooth",
    handleOut: { x: cx - kx, y: cy + ry }, handleIn: { x: cx + kx, y: cy + ry },
  };
  const west: PathNode = {
    id: shortId("node"), point: { x: cx - rx, y: cy }, type: "smooth",
    handleOut: { x: cx - rx, y: cy - ky }, handleIn: { x: cx - rx, y: cy + ky },
  };
  const south: PathNode = {
    id: shortId("node"), point: { x: cx, y: cy - ry }, type: "smooth",
    handleOut: { x: cx + kx, y: cy - ry }, handleIn: { x: cx - kx, y: cy - ry },
  };
  return { id: shortId("contour"), nodes: [east, north, west, south], closed: true };
}

/** Regular `sides`-gon inscribed in `box`, apex pointing straight up. */
function polygonContour(box: Box, sides: number): Contour {
  const cx = box.minX + box.w / 2;
  const cy = box.minY + box.h / 2;
  const rx = box.w / 2;
  const ry = box.h / 2;
  const nodes: PathNode[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = Math.PI / 2 + (i * 2 * Math.PI) / sides;
    nodes.push(cornerNode({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }));
  }
  return { id: shortId("contour"), nodes, closed: true };
}

/**
 * Builds the contour for a Shape-tool drag from point `a` to point `b`.
 * Returns null if the drag is too small to count as an intentional shape
 * (e.g. a stray click) — callers should treat that as "nothing to add".
 */
export function buildShapeContour(kind: ShapeKind, a: Point, b: Point, constrainToRegular: boolean): Contour | null {
  const box = normalizeBox(a, b, constrainToRegular);
  if (box.w < MIN_SHAPE_SIZE || box.h < MIN_SHAPE_SIZE) return null;
  if (kind === "rectangle") return rectangleContour(box);
  if (kind === "ellipse") return ellipseContour(box);
  return polygonContour(box, POLYGON_SIDES);
}
