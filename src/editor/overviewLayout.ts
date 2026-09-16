import {
  OVERVIEW_BASE_TILE_PX,
  clampOverviewSpacing,
  clampOverviewZoom,
} from "@/types/glyphView";

/**
 * Pure grid-layout + virtualization math for the Multi Glyph Canvas.
 *
 * No React, no store, no glyph data — it takes a COUNT and a viewport and
 * hands back geometry. That keeps the renderer thin and makes the wrap /
 * virtual-window behaviour independently testable.
 *
 * Coordinate space here is CSS pixels of the canvas surface, with the
 * grid's own origin at the top-left of the (unscrolled) content. The
 * renderer subtracts the scroll offset when it paints. Glyph outlines
 * themselves stay in font units and are mapped into a tile by
 * `glyphTileTransform` below, so no glyph geometry is ever duplicated or
 * rewritten for this view.
 */

export interface OverviewLayout {
  /** Edge length of one glyph tile (the square the outline is drawn in). */
  tilePx: number;
  /** Gap between adjacent tiles, both axes. */
  gapPx: number;
  /** Height reserved under each tile for its name label. */
  labelPx: number;
  /** Outer padding around the whole grid. */
  padPx: number;
  cellW: number;
  cellH: number;
  cols: number;
  rows: number;
  count: number;
  contentW: number;
  contentH: number;
}

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverviewLayoutOptions {
  count: number;
  /** Visible canvas width in CSS pixels. */
  viewW: number;
  /** Overview zoom, percent. */
  zoom: number;
  /** Spacing slider value (percent of tile size). */
  spacing: number;
}

export function computeOverviewLayout({
  count,
  viewW,
  zoom,
  spacing,
}: OverviewLayoutOptions): OverviewLayout {
  const z = clampOverviewZoom(zoom) / 100;
  const tilePx = Math.max(24, OVERVIEW_BASE_TILE_PX * z);
  const gapPx = Math.round(tilePx * (clampOverviewSpacing(spacing) / 100));
  // Label shrinks with the tile but never below legibility, and never
  // grows so tall it eats the tile at large zoom.
  const labelPx = Math.round(Math.min(20, Math.max(11, tilePx * 0.14)));
  const padPx = Math.round(Math.min(28, Math.max(10, tilePx * 0.12)));

  const cellW = tilePx + gapPx;
  const cellH = tilePx + labelPx + gapPx;

  const usable = Math.max(0, viewW - padPx * 2 + gapPx);
  // Glyphs flow horizontally and wrap to the next row as soon as the
  // canvas runs out of width — so the column count follows the canvas
  // size AND the zoom level, exactly like FontLab's overview.
  const cols = Math.max(1, Math.floor(usable / cellW) || 1);
  const rows = count > 0 ? Math.ceil(count / cols) : 0;

  return {
    tilePx,
    gapPx,
    labelPx,
    padPx,
    cellW,
    cellH,
    cols,
    rows,
    count,
    contentW: padPx * 2 + Math.max(0, cols * cellW - gapPx),
    contentH: padPx * 2 + Math.max(0, rows * cellH - gapPx),
  };
}

/** Top-left rect of tile `index` in content space (scroll not applied). */
export function tileRect(layout: OverviewLayout, index: number): TileRect {
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  return {
    x: layout.padPx + col * layout.cellW,
    y: layout.padPx + row * layout.cellH,
    w: layout.tilePx,
    h: layout.tilePx,
  };
}

/** The tile's full cell including its label strip — used for hit-testing
 *  and marquee intersection so clicking the label selects the glyph. */
export function cellRect(layout: OverviewLayout, index: number): TileRect {
  const r = tileRect(layout, index);
  return { x: r.x, y: r.y, w: layout.tilePx, h: layout.tilePx + layout.labelPx };
}

/**
 * VIRTUAL RENDERING: the half-open index range `[start, end)` that can
 * possibly be visible for a given scroll offset, plus `overscanRows`
 * rows of slack above and below so a fast scroll never flashes blank.
 *
 * This is what keeps a font with thousands of glyphs cheap — the
 * renderer only ever builds path elements for the couple of dozen tiles
 * inside this window, never for the whole collection.
 */
export function visibleIndexRange(
  layout: OverviewLayout,
  scrollY: number,
  viewH: number,
  overscanRows = 2
): { start: number; end: number } {
  if (layout.count === 0 || layout.rows === 0) return { start: 0, end: 0 };
  const firstRow = Math.max(
    0,
    Math.floor((scrollY - layout.padPx) / layout.cellH) - overscanRows
  );
  const lastRow = Math.min(
    layout.rows - 1,
    Math.floor((scrollY + viewH - layout.padPx) / layout.cellH) + overscanRows
  );
  if (lastRow < firstRow) return { start: 0, end: 0 };
  return {
    start: firstRow * layout.cols,
    end: Math.min(layout.count, (lastRow + 1) * layout.cols),
  };
}

/** Largest legal scroll offset for the current content/viewport pair. */
export function maxScrollY(layout: OverviewLayout, viewH: number): number {
  return Math.max(0, layout.contentH - viewH);
}

export function clampScrollY(layout: OverviewLayout, viewH: number, y: number): number {
  if (!Number.isFinite(y)) return 0;
  return Math.min(maxScrollY(layout, viewH), Math.max(0, y));
}

/** Index of the tile under a content-space point, or -1. */
export function indexAtPoint(layout: OverviewLayout, x: number, y: number): number {
  if (layout.count === 0) return -1;
  const col = Math.floor((x - layout.padPx) / layout.cellW);
  const row = Math.floor((y - layout.padPx) / layout.cellH);
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return -1;
  const index = row * layout.cols + col;
  if (index < 0 || index >= layout.count) return -1;
  // Reject the gap between cells so clicking empty space clears the
  // selection instead of selecting whichever tile is nearest.
  const cell = cellRect(layout, index);
  if (x > cell.x + cell.w || y > cell.y + cell.h) return -1;
  return index;
}

/** Every tile index whose cell intersects a content-space rectangle —
 *  the drag-rectangle (marquee) selection query. */
export function indicesInRect(
  layout: OverviewLayout,
  rect: { x: number; y: number; w: number; h: number }
): number[] {
  if (layout.count === 0) return [];
  const x0 = Math.min(rect.x, rect.x + rect.w);
  const x1 = Math.max(rect.x, rect.x + rect.w);
  const y0 = Math.min(rect.y, rect.y + rect.h);
  const y1 = Math.max(rect.y, rect.y + rect.h);

  const firstRow = Math.max(0, Math.floor((y0 - layout.padPx) / layout.cellH));
  const lastRow = Math.min(layout.rows - 1, Math.floor((y1 - layout.padPx) / layout.cellH));
  const firstCol = Math.max(0, Math.floor((x0 - layout.padPx) / layout.cellW));
  const lastCol = Math.min(layout.cols - 1, Math.floor((x1 - layout.padPx) / layout.cellW));

  const out: number[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) {
      const index = row * layout.cols + col;
      if (index < 0 || index >= layout.count) continue;
      const cell = cellRect(layout, index);
      if (cell.x > x1 || cell.x + cell.w < x0) continue;
      if (cell.y > y1 || cell.y + cell.h < y0) continue;
      out.push(index);
    }
  }
  return out;
}

/**
 * Maps a glyph's own font-unit space into one tile.
 *
 * `getGlyphPaths` (editor/glyphPaths.ts) already emits path data in the
 * app's shared Y-down render space — x in [0, advanceWidth], y in
 * [0, ascender - descender] measured down from the ascender. So a single
 * translate+scale is all that's needed; nothing about the outline data
 * is touched or recomputed for this view.
 *
 * The scale is the SAME for every tile (tile height / em height) so
 * glyphs stay visually comparable — which is the whole point of an
 * overview — except for an over-wide glyph (a long ligature or swash
 * whose advance exceeds the em), which is scaled down just enough to fit
 * its own tile rather than bleeding into its neighbours.
 */
export function glyphTileTransform(
  tile: TileRect,
  advanceWidth: number,
  totalHeight: number,
  inset = 0.1
): { scale: number; translateX: number; translateY: number } {
  const innerH = tile.h * (1 - inset * 2);
  const innerW = tile.w * (1 - inset * 2);
  const base = totalHeight > 0 ? innerH / totalHeight : 1;
  const advance = advanceWidth > 0 ? advanceWidth : totalHeight * 0.5;
  const scale = advance * base > innerW ? innerW / advance : base;
  return {
    scale,
    translateX: tile.x + (tile.w - advance * scale) / 2,
    translateY: tile.y + (tile.h - totalHeight * scale) / 2,
  };
}
