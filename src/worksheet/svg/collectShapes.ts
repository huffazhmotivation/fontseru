import {
  DRAWABLE_TAGS,
  SKIP_SUBTREE_TAGS,
  isHiddenElement,
  multiplyMatrix,
  parseTransformAttr,
  parsePathData,
  shapeElementToPathD,
  transformRawNode,
  type Matrix,
  type RawNode,
} from "@/trace/svgImport";

export interface SvgShapeBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SvgShape {
  tag: string;
  fill: string | null;
  stroke: string | null;
  subpaths: RawNode[][];
  bounds: SvgShapeBounds;
}

function getStyleProp(el: Element, prop: string): string | null {
  const style = el.getAttribute("style");
  if (style) {
    const m = style.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
    if (m) return m[1].trim();
  }
  return el.getAttribute(prop);
}

function boundsOf(subpaths: RawNode[][]): SvgShapeBounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sp of subpaths) {
    for (const n of sp) {
      if (n.point.x < minX) minX = n.point.x;
      if (n.point.x > maxX) maxX = n.point.x;
      if (n.point.y < minY) minY = n.point.y;
      if (n.point.y > maxY) maxY = n.point.y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Flattens every drawable element under `root` into world-space shapes,
 * composing ancestor transforms exactly like `walkSvgTree` does — but,
 * unlike that helper, also keeps each shape's own fill/stroke so the
 * worksheet detector can tell an ink shape from one of its own
 * guide/marker shapes by *appearance*, without depending on any custom
 * attribute surviving a re-export through a design tool.
 */
export function collectSvgShapes(root: Element, rootMatrix: Matrix): SvgShape[] {
  const out: SvgShape[] = [];

  function walk(el: Element, matrix: Matrix) {
    if (isHiddenElement(el)) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP_SUBTREE_TAGS.has(tag)) return;
    const local = multiplyMatrix(matrix, parseTransformAttr(el.getAttribute("transform")));

    if (DRAWABLE_TAGS.has(tag)) {
      const d = shapeElementToPathD(el);
      if (d) {
        const subpaths = parsePathData(d).map((sp) => sp.map((n) => transformRawNode(n, local)));
        const bounds = boundsOf(subpaths);
        if (bounds) {
          out.push({ tag, fill: getStyleProp(el, "fill"), stroke: getStyleProp(el, "stroke"), subpaths, bounds });
        }
      }
    }
    for (const child of Array.from(el.children)) walk(child, local);
  }

  walk(root, rootMatrix);
  return out;
}
