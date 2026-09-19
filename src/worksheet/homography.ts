import type { Point } from "@/types/geometry";

/**
 * Maps the unit square (u,v in [0,1]) onto an arbitrary quadrilateral via a
 * projective transform (Paul Heckbert's closed-form "square-to-quad"
 * mapping). This is exactly what's needed to rectify a photographed page:
 * the worksheet's 4 corner fiducials are, by template design, the corners
 * of the unit square in page-normalized space — whatever quad their
 * *photographed* pixel positions form is the result of the page's
 * rotation, scale, crop offset, and (for small angles) perspective. One
 * mapping built from those 4 correspondences corrects all of it at once
 * for any point on the page, including every glyph cell.
 *
 * `quad` must be ordered [u=0,v=0], [u=1,v=0], [u=1,v=1], [u=0,v=1]
 * (i.e. TL, TR, BR, BL of the source photo).
 */
export function squareToQuad(quad: [Point, Point, Point, Point]): (u: number, v: number) => Point {
  const [p0, p1, p2, p3] = quad;

  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  let g: number;
  let h: number;
  const denom = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    // Source quad is already a parallelogram (pure affine — no perspective term).
    g = 0;
    h = 0;
  } else if (Math.abs(denom) < 1e-9) {
    g = 0;
    h = 0;
  } else {
    g = (dx3 * dy2 - dx2 * dy3) / denom;
    h = (dx1 * dy3 - dx3 * dy1) / denom;
  }

  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + h * p3.x;
  const c = p0.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + h * p3.y;
  const f = p0.y;

  return (u: number, v: number): Point => {
    const w = g * u + h * v + 1;
    const safeW = Math.abs(w) < 1e-9 ? (w < 0 ? -1e-9 : 1e-9) : w;
    return {
      x: (a * u + b * v + c) / safeW,
      y: (d * u + e * v + f) / safeW,
    };
  };
}

/**
 * Wraps `squareToQuad` so callers can keep working in the same
 * PAGE-normalized coordinates the grid math already uses everywhere
 * (`WorksheetGridSpec.originX/cellWidth/...`, all `mm / pageWidthMm`
 * fractions measured from the physical page edge) instead of having to
 * think in `squareToQuad`'s own [0,1] domain.
 *
 * That domain isn't the same thing: `squareToQuad`'s u=0/v=0 and u=1/v=1
 * land exactly on the quad's own corner points — here, the 4 detected
 * fiducial *centers* — and those centers sit inset from the physical page
 * edges by the template's fiducial margin (e.g. ~12mm), not at the page's
 * literal (0,0)/(1,1) corners. Feeding a page-edge-relative fraction
 * (like a cell's `originX`) straight into `squareToQuad` therefore lands
 * on the wrong point — off by exactly that margin, scaled by the page/quad
 * size ratio — which silently drags every writing-box crop window off of
 * the box it's meant to capture, cropping whatever glyph was drawn there.
 * Renormalizing against the template's own fiducial positions (which are
 * already known in that same page-fraction space) corrects this for any
 * margin/page-size combination, not just today's constants.
 */
export function pageFractionToSource(
  orderedCorners: [Point, Point, Point, Point],
  /** The 4 fiducial specs in the same [TL, TR, BR, BL] order as `orderedCorners`, giving each corner's *center* position in page-fraction space. */
  fiducialSpecs: readonly [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }]
): (u: number, v: number) => Point {
  const quad = squareToQuad(orderedCorners);
  const [tl, tr, , bl] = fiducialSpecs;
  const spanU = tr.x - tl.x;
  const spanV = bl.y - tl.y;
  return (u: number, v: number): Point => {
    const qu = spanU !== 0 ? (u - tl.x) / spanU : u;
    const qv = spanV !== 0 ? (v - tl.y) / spanV : v;
    return quad(qu, qv);
  };
}
