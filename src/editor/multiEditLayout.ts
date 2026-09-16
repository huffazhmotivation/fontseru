import { clampMultiColumns } from "@/types/glyphView";

/**
 * Layout math for the MULTI GLYPH EDIT CANVAS.
 *
 * The key difference from ./overviewLayout.ts (the read-only thumbnail
 * grid) is the coordinate space. The overview lays tiles out in CSS
 * PIXELS and then scales each glyph down into its tile — which is fine
 * for looking, but useless for drawing: a pointer position would have to
 * be un-scaled per tile, and every tool's hit tolerance would mean a
 * different number of font units in every cell.
 *
 * Here the whole canvas is ONE continuous plane measured in FONT UNITS.
 * Every glyph cell is a full em box (upm × (ascender − descender)) placed
 * at a whole-unit offset, and zoom is a single px-per-font-unit scale
 * applied to the SVG viewBox — exactly how GlyphCanvas already works.
 *
 * Consequences, all of them the point of doing it this way:
 *
 *  • A pointer position converts into a glyph's own font space with one
 *    subtraction, so the EXISTING tool hooks (useGlyphEditor, useBrushTool,
 *    usePencilTool, useSelectTool) can be driven unchanged. No second
 *    drawing engine, no per-cell coordinate hacks.
 *  • `hitScale` (font units per screen pixel) is one number for the whole
 *    surface, so a node grab, a snap tolerance and a brush size feel
 *    identical in every cell and identical to Single Mode.
 *  • Guides/metrics are drawn per cell from the SAME font-unit values
 *    (ascender, x-height, LSB, ruler guides…), so every glyph box carries
 *    its own ruler guides without storing anything per cell.
 *
 * World origin (0,0) is the top-left of cell 0 — i.e. the point where
 * cell 0's ascender line meets x = 0. World Y runs DOWN (SVG convention),
 * matching the Y-flip the rest of the editor already does around
 * `ascender`.
 */

export interface MultiEditLayout {
  /** Cell box size in font units (one em box per glyph). */
  cellW: number;
  cellH: number;
  /** Gaps between cells, font units. */
  gapX: number;
  gapY: number;
  /** Strip under each cell reserved for the glyph name label, font units. */
  labelH: number;
  /** Distance from one cell's origin to the next, both axes. */
  stepX: number;
  stepY: number;
  cols: number;
  rows: number;
  count: number;
  contentW: number;
  contentH: number;
}

export interface MultiEditLayoutOptions {
  count: number;
  /** Manual column count; 0 = auto. */
  columns: number;
  upm: number;
  /** ascender − descender. */
  totalH: number;
  /** Spacing slider, percent of cell size. */
  spacing: number;
}

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CellHit {
  index: number;
  /** Inside the glyph box itself (the drawable area). */
  inBox: boolean;
  /** Inside the name-label strip under the box. */
  inLabel: boolean;
}

/** A pleasant default column count: roughly square, capped so a big font
 *  doesn't produce a 60-wide row nobody can pan across. */
export function autoColumns(count: number): number {
  if (count <= 1) return 1;
  return Math.max(2, Math.min(16, Math.round(Math.sqrt(count * 1.7))));
}

export function computeMultiEditLayout({
  count,
  columns,
  upm,
  totalH,
  spacing,
}: MultiEditLayoutOptions): MultiEditLayout {
  const cellW = Math.max(1, upm);
  const cellH = Math.max(1, totalH);
  const manual = clampMultiColumns(columns);
  const cols = Math.max(1, Math.min(Math.max(1, count), manual > 0 ? manual : autoColumns(count)));
  const rows = count > 0 ? Math.ceil(count / cols) : 0;

  const spacingFrac = Math.max(0, spacing) / 100;
  // A minimum gap always remains even at spacing = 0: cells must stay
  // visually separable, because in this mode they are separate DRAWING
  // areas, not just separate pictures.
  const gapX = cellW * (0.09 + spacingFrac);
  const labelH = cellH * 0.11;
  const gapY = cellH * (0.09 + spacingFrac) + labelH;

  const stepX = cellW + gapX;
  const stepY = cellH + gapY;

  return {
    cellW,
    cellH,
    gapX,
    gapY,
    labelH,
    stepX,
    stepY,
    cols,
    rows,
    count,
    contentW: Math.max(0, cols * stepX - gapX),
    contentH: Math.max(0, rows * stepY - gapY),
  };
}

/** Top-left corner of cell `index` in world space (ascender line, x = 0). */
export function cellOrigin(layout: MultiEditLayout, index: number): { x: number; y: number } {
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  return { x: col * layout.stepX, y: row * layout.stepY };
}

/** The cell's own drawable box, world space. */
export function cellBox(layout: MultiEditLayout, index: number): CellRect {
  const o = cellOrigin(layout, index);
  return { x: o.x, y: o.y, w: layout.cellW, h: layout.cellH };
}

/**
 * Which cell a world point falls in. `pad` widens the box so a stroke
 * begun a hair outside the frame still lands in the intended glyph — the
 * caller then LOCKS that cell for the rest of the gesture, which is what
 * lets a stroke legitimately run past a cell's edge without jumping to
 * the neighbouring glyph mid-drag.
 */
export function cellHitAtWorld(
  layout: MultiEditLayout,
  x: number,
  y: number,
  pad = 0
): CellHit | null {
  if (layout.count === 0) return null;
  const col = Math.floor(x / layout.stepX);
  const row = Math.floor(y / layout.stepY);
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return null;
  const index = row * layout.cols + col;
  if (index < 0 || index >= layout.count) return null;
  const localX = x - col * layout.stepX;
  const localY = y - row * layout.stepY;
  const inBox =
    localX >= -pad && localX <= layout.cellW + pad && localY >= -pad && localY <= layout.cellH + pad;
  const inLabel =
    !inBox &&
    localX >= 0 &&
    localX <= layout.cellW &&
    localY > layout.cellH &&
    localY <= layout.cellH + layout.labelH;
  if (!inBox && !inLabel) return null;
  return { index, inBox, inLabel };
}

/** Indices whose cells intersect a world-space rectangle (the viewport,
 *  or a marquee), plus `overscan` rows/cols of slack. Only these are ever
 *  turned into SVG — a 3,000-glyph font paints the same handful of cells
 *  a 30-glyph font does. */
export function visibleCellIndices(
  layout: MultiEditLayout,
  rect: { x: number; y: number; w: number; h: number },
  overscan = 1
): number[] {
  if (layout.count === 0) return [];
  const firstCol = Math.max(0, Math.floor(rect.x / layout.stepX) - overscan);
  const lastCol = Math.min(layout.cols - 1, Math.floor((rect.x + rect.w) / layout.stepX) + overscan);
  const firstRow = Math.max(0, Math.floor(rect.y / layout.stepY) - overscan);
  const lastRow = Math.min(layout.rows - 1, Math.floor((rect.y + rect.h) / layout.stepY) + overscan);

  const out: number[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) {
      const index = row * layout.cols + col;
      if (index >= 0 && index < layout.count) out.push(index);
    }
  }
  return out;
}

/**
 * World point → that cell's own glyph space (Y-up, baseline = 0) — the
 * exact coordinate space every existing tool hook already speaks.
 */
export function worldToGlyphPoint(
  layout: MultiEditLayout,
  index: number,
  world: { x: number; y: number },
  ascender: number
): { x: number; y: number } {
  const o = cellOrigin(layout, index);
  return { x: world.x - o.x, y: ascender - (world.y - o.y) };
}

/** Glyph space (Y-up) → world (Y-down). Inverse of worldToGlyphPoint. */
export function glyphPointToWorld(
  layout: MultiEditLayout,
  index: number,
  p: { x: number; y: number },
  ascender: number
): { x: number; y: number } {
  const o = cellOrigin(layout, index);
  return { x: o.x + p.x, y: o.y + (ascender - p.y) };
}
