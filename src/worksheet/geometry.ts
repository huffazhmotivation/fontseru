import type { TemplatePoint } from "./types";

/** Row-major 3x3 projective matrix, h[8] normalized to 1. */
export type Homography = number[]; // length 9

/** Solves an NxN linear system via Gaussian elimination with partial pivoting. Mutates nothing outside its own copies. Returns null if the system is singular (degenerate point configuration). */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivotRow][col])) pivotRow = r;
    }
    if (Math.abs(M[pivotRow][col]) < 1e-9) return null;
    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }

  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Exact homography mapping each `src[i]` to `dst[i]` (4 point
 * correspondences, the minimum that fully determines a projective
 * transform — used here for src = template-space fiducial centers,
 * dst = their detected centers in the photographed image, so the result
 * maps template space -> image space). Returns null if the 4 points are
 * degenerate (near-collinear, or detection collapsed two corners together).
 */
export function computeHomography(src: TemplatePoint[], dst: TemplatePoint[]): Homography | null {
  if (src.length !== 4 || dst.length !== 4) return null;

  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }

  const h = solveLinearSystem(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyHomography(H: Homography, p: TemplatePoint): TemplatePoint {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  if (Math.abs(w) < 1e-9) return { x: 0, y: 0 };
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  };
}

/** Analytic inverse of a 3x3 projective matrix, for going image space -> template space when needed. */
export function invertHomography(H: Homography): Homography | null {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H2 = -(a * f - c * d);
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-9) return null;
  const inv = [A, D, G, B, E, H2, C, F, I].map((v) => v / det);
  return inv;
}

export interface RGBASource {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Bilinear-sampled luminance (0-255) at a possibly-fractional pixel coordinate; out-of-bounds reads as white (255) so warped regions never pick up garbage at the edges. */
export function sampleLuminanceBilinear(src: RGBASource, x: number, y: number): number {
  if (x < 0 || y < 0 || x > src.width - 1 || y > src.height - 1) return 255;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(src.width - 1, x0 + 1);
  const y1 = Math.min(src.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;

  const lum = (px: number, py: number) => {
    const idx = (py * src.width + px) * 4;
    const r = src.data[idx];
    const g = src.data[idx + 1];
    const bch = src.data[idx + 2];
    const a = src.data[idx + 3];
    const v = 0.299 * r + 0.587 * g + 0.114 * bch;
    // Treat transparent pixels as paper-white, same convention imageTrace.ts's binarize() uses.
    return a > 32 ? v : 255;
  };

  const top = lum(x0, y0) * (1 - tx) + lum(x1, y0) * tx;
  const bottom = lum(x0, y1) * (1 - tx) + lum(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}
