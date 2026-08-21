import { GLYPH_GROUPS } from "@/glyph/defaultGlyphs";
import type { WorksheetCellSpec, WorksheetTemplate } from "../types";

/**
 * "FontSeru Classic A4" — one glyph per cell, A-Z / a-z / 0-9, 10 columns x
 * 7 rows (70 slots, 62 used — the remaining 8 stay reserved/unused so the
 * grid math is a clean rectangle). Punctuation/symbols intentionally left
 * out of this first template to keep the printed sheet compact; add a
 * second template (e.g. "FontSeru Punctuation A4") the same way once one's
 * needed — see registry.ts.
 *
 * Everything below is expressed in an abstract "template space" of
 * PAGE_W x PAGE_H units — not millimeters or pixels. A photographed copy
 * of the printed sheet gets mapped back into this exact space via the four
 * corner fiducial markers before any cell is read (see
 * detectRasterWorksheet.ts), so only the *ratios* below matter, not any
 * particular print size.
 */

const PAGE_W = 1000;
const PAGE_H = 1414; // ~A4 portrait ratio

const COLS = 10;
const ROWS = 7;

const GRID_LEFT = 40;
const GRID_TOP = 140; // leaves room for a title/instructions header above the grid
const GRID_RIGHT = 960;
const GRID_BOTTOM = 1260; // leaves margin below the grid for the footer/signature area

const CELL_W = (GRID_RIGHT - GRID_LEFT) / COLS;
const CELL_H = (GRID_BOTTOM - GRID_TOP) / ROWS;

/** Inset from a cell's outer slot to where the user's actual writing is expected — keeps grid lines/printed labels out of the traced shape. */
const CONTENT_PADDING = 10;

/** Ordered target chars this template prints one cell per: Uppercase, Lowercase, Numbers — reuses the app's own GLYPH_GROUPS so this template's order can never drift from the rest of the app's glyph ordering/data model. */
const CHAR_ORDER: string[] = (() => {
  const byId = new Map(GLYPH_GROUPS.map((g) => [g.id, g.chars] as const));
  return [...(byId.get("upper") ?? []), ...(byId.get("lower") ?? []), ...(byId.get("digits") ?? [])];
})();

function buildGridCells(): WorksheetCellSpec[] {
  const cells: WorksheetCellSpec[] = [];
  for (let i = 0; i < CHAR_ORDER.length; i++) {
    const row = Math.floor(i / COLS);
    const col = i % COLS;
    if (row >= ROWS) break; // safety: never overflow the printed grid, even if CHAR_ORDER grows later
    const rect = { x: GRID_LEFT + col * CELL_W, y: GRID_TOP + row * CELL_H, width: CELL_W, height: CELL_H };
    const contentRect = {
      x: rect.x + CONTENT_PADDING,
      y: rect.y + CONTENT_PADDING,
      width: rect.width - CONTENT_PADDING * 2,
      height: rect.height - CONTENT_PADDING * 2,
    };
    cells.push({ id: i, char: CHAR_ORDER[i], rect, contentRect });
  }
  return cells;
}

const FIDUCIAL_MARGIN = 55;
const FIDUCIAL_SIZE = 40;

export const FONTSERU_CLASSIC_A4: WorksheetTemplate = {
  id: "fontseru-classic-a4",
  label: "FontSeru Classic A4 (A-Z, a-z, 0-9)",
  page: { width: PAGE_W, height: PAGE_H },
  fiducials: {
    tl: { x: FIDUCIAL_MARGIN, y: FIDUCIAL_MARGIN },
    tr: { x: PAGE_W - FIDUCIAL_MARGIN, y: FIDUCIAL_MARGIN },
    bl: { x: FIDUCIAL_MARGIN, y: PAGE_H - FIDUCIAL_MARGIN },
    br: { x: PAGE_W - FIDUCIAL_MARGIN, y: PAGE_H - FIDUCIAL_MARGIN },
    size: FIDUCIAL_SIZE,
  },
  // Two spot-checks sampled after the homography is solved: a solid square
  // printed at the header's center (must read as ink) and a blank spot just
  // above the grid (must read as paper). A random photo that happens to
  // contain 4 dark corner-ish blobs will almost never also satisfy both of
  // these, so this is what actually gates "is this a FontSeru worksheet"
  // rather than the fiducials alone.
  validationMarks: [
    { x: PAGE_W / 2, y: 90, size: 26, expectInk: true },
    { x: PAGE_W / 2, y: 120, size: 16, expectInk: false },
  ],
  cells: buildGridCells(),
  svgCellAttr: "data-fontseru-cell",
};
