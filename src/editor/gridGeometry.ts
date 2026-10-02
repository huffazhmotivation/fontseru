/**
 * Guideline-grid geometry — one source of truth for every grid shape.
 *
 * Everything here lives in FONT space (Y-up). The canvas draws the grid as
 * an SVG <pattern> whose tile is described by `gridPatternSpec`, and the
 * Pixel brush snaps/fills cells using `gridCellAt` / `gridCellCenter` /
 * `gridCellPolygon`. Both read the same lattice definitions below, so a
 * painted cell always sits exactly on the visible guide lines.
 *
 * `size` is the grid "pitch" in font units:
 *   - square    cell edge
 *   - triangle  edge of an equilateral triangle
 *   - hexagon   flat-to-flat width of a (pointy-top) hexagon
 *   - circle    diameter of touching circles laid out on a square lattice
 *   - octagon   flat-to-flat width of the octagon in the 4.8.8 mosaic
 *               (octagons + the small diamonds between them)
 */
export type GridShape = "square" | "triangle" | "hexagon" | "octagon" | "circle";

export const GRID_SHAPES: ReadonlyArray<{ id: GridShape; label: string }> = [
  { id: "square", label: "Kotak" },
  { id: "triangle", label: "Segitiga" },
  { id: "hexagon", label: "Hexagon" },
  { id: "octagon", label: "Poligon" },
  { id: "circle", label: "Lingkaran" },
];

export const GRID_SIZE_MIN = 2;
export const GRID_SIZE_MAX = 400;

export function normalizeGridShape(v: unknown): GridShape {
  return v === "triangle" || v === "hexagon" || v === "octagon" || v === "circle" ? v : "square";
}

const SQRT3 = Math.sqrt(3);
const SQRT2 = Math.SQRT2;

export interface Pt {
  x: number;
  y: number;
}

export interface GridCell {
  /** Stable identity of the cell within its shape/size lattice. */
  key: string;
  center: Pt;
  polygon: Pt[];
}

/* ------------------------------------------------------------------ *
 * Pattern tile (for rendering)
 * ------------------------------------------------------------------ */

export interface GridPatternSpec {
  width: number;
  height: number;
  /** SVG path data, in tile space. Edges that sit on the tile border are
   *  drawn on BOTH borders so the clipped half-strokes join into one line. */
  d: string;
}

const n = (v: number) => +v.toFixed(4);

export function gridPatternSpec(shape: GridShape, size: number): GridPatternSpec {
  const g = size;
  switch (shape) {
    case "triangle": {
      const r = (g * SQRT3) / 2;
      const h = 2 * r;
      return {
        width: g,
        height: h,
        d: `M0 0H${n(g)}M0 ${n(r)}H${n(g)}M0 ${n(h)}H${n(g)}M0 0L${n(g)} ${n(h)}M${n(g)} 0L0 ${n(h)}`,
      };
    }
    case "hexagon": {
      const a = g / SQRT3; // hex edge length
      const h = 3 * a;
      return {
        width: g,
        height: h,
        d:
          `M${n(g / 2)} 0L${n(g)} ${n(a / 2)}L${n(g)} ${n(1.5 * a)}L${n(g / 2)} ${n(2 * a)}` +
          `L0 ${n(1.5 * a)}L0 ${n(a / 2)}Z` +
          `M${n(g / 2)} ${n(2 * a)}V${n(h)}`,
      };
    }
    case "circle": {
      const r = g / 2;
      return {
        width: g,
        height: g,
        d: `M0 ${n(r)}A${n(r)} ${n(r)} 0 1 0 ${n(g)} ${n(r)}A${n(r)} ${n(r)} 0 1 0 0 ${n(r)}Z`,
      };
    }
    case "octagon": {
      const c = octagonCorner(g);
      return {
        width: g,
        height: g,
        d:
          `M${n(c)} 0H${n(g - c)}L${n(g)} ${n(c)}V${n(g - c)}L${n(g - c)} ${n(g)}H${n(c)}` +
          `L0 ${n(g - c)}V${n(c)}Z`,
      };
    }
    default:
      return {
        width: g,
        height: g,
        d: `M0 0H${n(g)}M0 ${n(g)}H${n(g)}M0 0V${n(g)}M${n(g)} 0V${n(g)}`,
      };
  }
}

/** Length cut off each octagon corner: a = p·(2−√2)/2 for flat-to-flat width p. */
function octagonCorner(p: number): number {
  return (p * (2 - SQRT2)) / 2;
}

/* ------------------------------------------------------------------ *
 * Cell lookup (for the Pixel brush)
 * ------------------------------------------------------------------ */

export function gridCellAt(shape: GridShape, size: number, p: Pt): GridCell {
  switch (shape) {
    case "triangle":
      return triangleCell(size, p);
    case "hexagon":
      return hexagonCell(size, p);
    case "octagon":
      return octagonCell(size, p);
    case "circle":
      return circleCell(size, p);
    default:
      return squareCell(size, Math.floor(p.x / size), Math.floor(p.y / size));
  }
}

export function gridCellCenter(shape: GridShape, size: number, p: Pt): Pt {
  if (shape === "square") {
    return { x: (Math.floor(p.x / size) + 0.5) * size, y: (Math.floor(p.y / size) + 0.5) * size };
  }
  return gridCellAt(shape, size, p).center;
}

function circleCell(g: number, p: Pt): GridCell {
  const cx = Math.floor(p.x / g);
  const cy = Math.floor(p.y / g);
  const center = { x: (cx + 0.5) * g, y: (cy + 0.5) * g };
  const polygon: Pt[] = [];
  const N = 28;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    polygon.push({ x: center.x + (g / 2) * Math.cos(a), y: center.y + (g / 2) * Math.sin(a) });
  }
  return { key: `c${cx},${cy}`, center, polygon };
}

function squareCell(g: number, cx: number, cy: number): GridCell {
  const x0 = cx * g;
  const y0 = cy * g;
  return {
    key: `s${cx},${cy}`,
    center: { x: x0 + g / 2, y: y0 + g / 2 },
    polygon: [
      { x: x0, y: y0 },
      { x: x0 + g, y: y0 },
      { x: x0 + g, y: y0 + g },
      { x: x0, y: y0 + g },
    ],
  };
}

// Triangle lattice: basis a=(g,0), b=(g/2, r), r = g·√3/2. A point maps to
// skew coords (u, v); each unit parallelogram splits into an "up" triangle
// (fu+fv<1) and a "down" triangle.
function triangleCell(g: number, p: Pt): GridCell {
  const r = (g * SQRT3) / 2;
  const v = p.y / r;
  const u = p.x / g - v / 2;
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  const up = u - iu + (v - iv) < 1;
  const L = (m: number, k: number): Pt => ({ x: m * g + (k * g) / 2, y: k * r });
  const polygon = up
    ? [L(iu, iv), L(iu + 1, iv), L(iu, iv + 1)]
    : [L(iu + 1, iv), L(iu + 1, iv + 1), L(iu, iv + 1)];
  return {
    key: `t${iu},${iv},${up ? 0 : 1}`,
    center: {
      x: (polygon[0].x + polygon[1].x + polygon[2].x) / 3,
      y: (polygon[0].y + polygon[1].y + polygon[2].y) / 3,
    },
    polygon,
  };
}

// Pointy-top hex lattice, hex (0,0) centred at (g/2, a) with a = g/√3.
function hexagonCell(g: number, p: Pt): GridCell {
  const a = g / SQRT3;
  const x0 = g / 2;
  const y0 = a;
  const px = p.x - x0;
  const py = p.y - y0;
  const qf = ((SQRT3 / 3) * px - py / 3) / a;
  const rf = ((2 / 3) * py) / a;
  // cube rounding
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(-qf - rf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - (-qf - rf));
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  const cx = x0 + g * (q + r / 2);
  const cy = y0 + 1.5 * a * r;
  const polygon: Pt[] = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i - 30);
    polygon.push({ x: cx + a * Math.cos(ang), y: cy + a * Math.sin(ang) });
  }
  return { key: `h${q},${r}`, center: { x: cx, y: cy }, polygon };
}

// 4.8.8 mosaic: octagons centred at ((i+½)p, (j+½)p), diamonds at (i·p, j·p).
function octagonCell(p: number, pt: Pt): GridCell {
  const c = octagonCorner(p);
  const ix = Math.floor(pt.x / p);
  const iy = Math.floor(pt.y / p);
  const cx = (ix + 0.5) * p;
  const cy = (iy + 0.5) * p;
  const dx = pt.x - cx;
  const dy = pt.y - cy;
  if (Math.abs(dx) + Math.abs(dy) <= p - c) {
    const h = p / 2;
    return {
      key: `o${ix},${iy}`,
      center: { x: cx, y: cy },
      polygon: [
        { x: cx - h + c, y: cy - h },
        { x: cx + h - c, y: cy - h },
        { x: cx + h, y: cy - h + c },
        { x: cx + h, y: cy + h - c },
        { x: cx + h - c, y: cy + h },
        { x: cx - h + c, y: cy + h },
        { x: cx - h, y: cy + h - c },
        { x: cx - h, y: cy - h + c },
      ],
    };
  }
  const kx = Math.round(pt.x / p);
  const ky = Math.round(pt.y / p);
  const mx = kx * p;
  const my = ky * p;
  return {
    key: `d${kx},${ky}`,
    center: { x: mx, y: my },
    polygon: [
      { x: mx, y: my - c },
      { x: mx + c, y: my },
      { x: mx, y: my + c },
      { x: mx - c, y: my },
    ],
  };
}

/**
 * Every grid cell touched by the polyline `pts` (consecutive samples are
 * interpolated finely enough that no cell is skipped), in first-visit order.
 */
export function gridCellsAlong(shape: GridShape, size: number, pts: ReadonlyArray<Pt>): GridCell[] {
  const seen = new Set<string>();
  const out: GridCell[] = [];
  const add = (p: Pt) => {
    const cell = gridCellAt(shape, size, p);
    if (seen.has(cell.key)) return;
    seen.add(cell.key);
    out.push(cell);
  };
  if (!pts.length) return out;
  add(pts[0]);
  const step = Math.max(size * 0.15, 0.5);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / step));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      add({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}
