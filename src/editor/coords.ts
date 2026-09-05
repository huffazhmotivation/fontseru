import type { Point } from "@/types/geometry";

/** Converts a mouse/pointer client position into font-unit space (Y-up, baseline=0). */
export function clientToFontPoint(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  ascender: number
): Point {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  // A degenerate/non-invertible CTM (e.g. queried mid-layout, before the
  // frame has a real size yet — more prone to happen in Safari, which can
  // fire pointer/resize events in a different order than Chrome/Firefox)
  // can produce NaN here. Guarding at the source keeps that NaN from ever
  // reaching a drawn point and, downstream, an SVG path's `d` attribute.
  let svgP: DOMPoint;
  try {
    svgP = pt.matrixTransform(ctm.inverse());
  } catch {
    return { x: 0, y: 0 };
  }
  if (!Number.isFinite(svgP.x) || !Number.isFinite(svgP.y)) return { x: 0, y: 0 };
  return { x: svgP.x, y: ascender - svgP.y };
}
