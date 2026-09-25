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
  /** Cell box size in font units (one em box per glyph in grid mode; in
   *  flow mode this is a fallback/typical value only — use `cellWidthAt`
   *  for a cell's real width, since flow cells are each their own glyph's
   *  advance width). */
  cellW: number;
  cellH: number;
  /** Gaps between cells, font units. Unused (0) in flow mode — flow cells
   *  sit edge-to-edge like real typeset text; the advance width itself
   *  (lsb + ink + rsb) is what reads as "spacing" there. */
  gapX: number;
  gapY: number;
  /** Strip under each cell reserved for the glyph name label, font units. */
  labelH: number;
  /** Distance from one cell's origin to the next, both axes. Grid mode
   *  only — flow mode positions cells individually via `origins`. */
  stepX: number;
  stepY: number;
  cols: number;
  rows: number;
  count: number;
  contentW: number;
  contentH: number;
  /** "grid" (default, Multi Mode) lays cells out in a uniform columns ×
   *  rows grid, every cell the same em-box width. "flow" (Type Mode) lays
   *  cells out like running text: left-to-right in each glyph's own
   *  advance width, wrapping to a new row (new baseline) once a row would
   *  exceed the wrap width. See computeSentenceLayout. */
  kind: "grid" | "flow";
  /** flow mode only: cell `index`'s top-left world position. */
  origins?: { x: number; y: number }[];
  /** flow mode only: cell `index`'s width (its glyph's own advance width,
   *  never narrower than 1 unit so an empty/space glyph stays hit-testable). */
  widths?: number[];
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
    kind: "grid",
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

export interface SentenceLayoutOptions {
  /** The sentence's characters, in reading order (see
   *  glyph/testSentences.ts's charsForCategory — already deduplicated). */
  chars: string[];
  /** Current advance width (font units) for a char at a given index —
   *  the caller supplies this so it can fall back to
   *  defaultGlyphs.ts's standardGlyphMetrics for a glyph that hasn't been
   *  drawn yet. Reading LIVE glyph metrics (not a snapshot) is what makes
   *  the flow reflow in real time as the user draws: once a glyph gets an
   *  outline and auto-spacing gives it a real advance width, every glyph
   *  after it shifts to match on the very next layout recompute. */
  advanceWidthFor: (char: string, index: number) => number;
  upm: number;
  /** ascender − descender. */
  totalH: number;
  /** Spacing slider, percent of cell height (row gap only — flow cells
   *  have no horizontal gap of their own, see MultiEditLayout.gapX). */
  spacing: number;
  /** Max row width, font units, before wrapping to a new line/baseline. */
  wrapWidth: number;
}

/** Lays `chars` out like running text: left-to-right, each cell exactly
 *  its own glyph's advance width, wrapping to a new row once a row would
 *  exceed `wrapWidth`. One baseline per row, shared by every glyph on it —
 *  the point of Type Mode. */
export function computeSentenceLayout({
  chars,
  advanceWidthFor,
  upm,
  totalH,
  spacing,
  wrapWidth,
}: SentenceLayoutOptions): MultiEditLayout {
  const cellW = Math.max(1, upm);
  const cellH = Math.max(1, totalH);
  const spacingFrac = Math.max(0, spacing) / 100;
  const labelH = cellH * 0.11;
  const gapY = cellH * (0.09 + spacingFrac) + labelH;
  const stepY = cellH + gapY;
  const wrap = Math.max(cellW, wrapWidth);

  const origins: { x: number; y: number }[] = [];
  const widths: number[] = [];
  let cursorX = 0;
  let row = 0;
  let maxRowWidth = 0;
  for (let i = 0; i < chars.length; i++) {
    const w = Math.max(1, advanceWidthFor(chars[i], i));
    if (cursorX > 0 && cursorX + w > wrap) {
      maxRowWidth = Math.max(maxRowWidth, cursorX);
      row += 1;
      cursorX = 0;
    }
    origins.push({ x: cursorX, y: row * stepY });
    widths.push(w);
    cursorX += w;
  }
  maxRowWidth = Math.max(maxRowWidth, cursorX);
  const rows = chars.length > 0 ? row + 1 : 0;

  return {
    kind: "flow",
    cellW,
    cellH,
    gapX: 0,
    gapY,
    labelH,
    stepX: 0,
    stepY,
    cols: 0,
    rows,
    count: chars.length,
    contentW: maxRowWidth,
    contentH: Math.max(0, rows * stepY - gapY),
    origins,
    widths,
  };
}

/** flow mode: a cell's real width (its own glyph's advance width). grid
 *  mode: same uniform `cellW` every cell already used. */
export function cellWidthAt(layout: MultiEditLayout, index: number): number {
  if (layout.kind === "flow") return layout.widths?.[index] ?? layout.cellW;
  return layout.cellW;
}

/** Top-left corner of cell `index` in world space (ascender line, x = 0). */
export function cellOrigin(layout: MultiEditLayout, index: number): { x: number; y: number } {
  if (layout.kind === "flow") return layout.origins?.[index] ?? { x: 0, y: 0 };
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  return { x: col * layout.stepX, y: row * layout.stepY };
}

/** The cell's own drawable box, world space. */
export function cellBox(layout: MultiEditLayout, index: number): CellRect {
  const o = cellOrigin(layout, index);
  return { x: o.x, y: o.y, w: cellWidthAt(layout, index), h: layout.cellH };
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
  if (layout.kind === "flow") {
    // Flow cells are non-uniform width, so there's no O(1) column formula
    // — a linear scan is fine here: Type Mode sentences top out at a
    // couple hundred characters, and this only runs per pointer event.
    for (let index = 0; index < layout.count; index++) {
      const o = layout.origins![index];
      const w = layout.widths![index];
      const localX = x - o.x;
      const localY = y - o.y;
      const inBox = localX >= -pad && localX <= w + pad && localY >= -pad && localY <= layout.cellH + pad;
      const inLabel =
        !inBox && localX >= 0 && localX <= w && localY > layout.cellH && localY <= layout.cellH + layout.labelH;
      if (inBox || inLabel) return { index, inBox, inLabel };
    }
    return null;
  }
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
 *  or a marquee), plus `overscan` rows/cols (grid) or a font-unit margin
 *  (flow) of slack. Only these are ever turned into SVG — a 3,000-glyph
 *  font paints the same handful of cells a 30-glyph font does. */
export function visibleCellIndices(
  layout: MultiEditLayout,
  rect: { x: number; y: number; w: number; h: number },
  overscan = 1
): number[] {
  if (layout.count === 0) return [];
  if (layout.kind === "flow") {
    const pad = overscan * layout.cellW;
    const out: number[] = [];
    for (let index = 0; index < layout.count; index++) {
      const o = layout.origins![index];
      const w = layout.widths![index];
      if (
        o.x + w >= rect.x - pad &&
        o.x <= rect.x + rect.w + pad &&
        o.y + layout.cellH >= rect.y - pad &&
        o.y <= rect.y + rect.h + pad
      ) {
        out.push(index);
      }
    }
    return out;
  }
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
