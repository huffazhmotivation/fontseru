import type { WorksheetCellSlot, WorksheetTemplate } from "@/worksheet/types";
import { registerWorksheetTemplate } from "./registry";

// Mirrors src/glyph/defaultGlyphs.ts exactly, so every default FontSeru
// glyph has a worksheet cell — if that file's character sets ever change,
// update these to match (there's no runtime coupling between the two,
// since a worksheet template describes a *printable sheet*, which has to
// stay stable once printed, independent of live glyph-map edits).
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const LOWER = "abcdefghijklmnopqrstuvwxyz".split("");
const DIGITS = "0123456789".split("");
const PUNCT = ".,:;!?'\"-–—()[]{}/\\@#&*_%".split("");
const SYMBOLS = "+=<>~^$€£¥§©®™°|".split("");

// A3 landscape — bigger sheet than A4 gives every page comfortable room
// even with 13 columns across, keeping the ~26mm writing box size that
// tested well, rather than shrinking cells to cram more onto A4.
const PAGE_MM = { width: 420, height: 297 };

const COLUMNS = 13;
const CELL_WIDTH_MM = 26.3;
const CELL_HEIGHT_MM = 30;
const LABEL_HEIGHT_MM = 4.2;
const LABEL_GAP_MM = 1.8;
const GAP_X_MM = 4;
const GAP_Y_MM = 4;
const ORIGIN_X_MM = 15;
const ORIGIN_Y_MM = 26;
const FIDUCIAL_SIZE_MM = 8;
const FIDUCIAL_MARGIN_MM = 12;
const PAGE_MARKER_SIZE_MM = 5;
const PAGE_MARKER_Y_MM = 20;

function mmToU(mm: number) { return mm / PAGE_MM.width; }
function mmToV(mm: number) { return mm / PAGE_MM.height; }

function sharedGrid(rows: number) {
  return {
    columns: COLUMNS,
    rows,
    originX: mmToU(ORIGIN_X_MM),
    originY: mmToV(ORIGIN_Y_MM),
    cellWidth: mmToU(CELL_WIDTH_MM),
    cellHeight: mmToV(CELL_HEIGHT_MM),
    labelHeight: mmToV(LABEL_HEIGHT_MM),
    labelGap: mmToV(LABEL_GAP_MM),
    gapX: mmToU(GAP_X_MM),
    gapY: mmToV(GAP_Y_MM),
    guideLines: [
      { fractionY: 0.14, dashed: true },
      { fractionY: 0.46, dashed: true },
      { fractionY: 0.8, dashed: false },
    ],
    // Higher raster resolution per cell = more source pixels for imagetracer
    // to fit against, so curves and thin strokes come out closer to what was
    // actually drawn instead of losing detail to a coarser sampling grid.
    cellRasterSize: 340,
    writeInset: 0.06,
  };
}

function sharedFiducials(): WorksheetTemplate["fiducials"] {
  const sizeX = mmToU(FIDUCIAL_SIZE_MM);
  const sizeY = mmToV(FIDUCIAL_SIZE_MM);
  const mX = mmToU(FIDUCIAL_MARGIN_MM);
  const mY = mmToV(FIDUCIAL_MARGIN_MM);
  return [
    { id: 1, x: mX, y: mY, sizeX, sizeY },
    { id: 2, x: 1 - mX, y: mY, sizeX, sizeY },
    { id: 3, x: 1 - mX, y: 1 - mY, sizeX, sizeY },
    { id: 4, x: mX, y: 1 - mY, sizeX, sizeY },
  ];
}

// All 3 pages share identical corner-fiducial geometry and grid
// origin/cell size — this small extra marker (1/2/3 dots) is the only
// thing that tells them apart, the same non-OCR, marker-based way as
// everything else.
function pageMarker(dotCount: number) {
  return { x: 0.5, y: mmToV(PAGE_MARKER_Y_MM), sizeX: mmToU(PAGE_MARKER_SIZE_MM), sizeY: mmToV(PAGE_MARKER_SIZE_MM), dotCount };
}

function buildSlots(chars: string[]): WorksheetCellSlot[] {
  return chars.map((char, index) => ({
    index,
    char,
    row: Math.floor(index / COLUMNS),
    col: index % COLUMNS,
  }));
}

function rowsFor(count: number): number {
  return Math.max(1, Math.ceil(count / COLUMNS));
}

// Page 1 of 3 — A-Z + 0-9 (36 glyphs).
export const FONTSERU_ALL_GLYPHS_P1: WorksheetTemplate = {
  id: "fontseru-all-glyphs-v1-p1",
  name: "FontSeru — Halaman 1/3 (A-Z, 0-9)",
  version: "3.0.0",
  svgTemplateAttr: "fontseru-all-glyphs-v1-p1",
  pageSizeMm: PAGE_MM,
  fiducials: sharedFiducials(),
  grid: sharedGrid(rowsFor(UPPER.length + DIGITS.length)),
  slots: buildSlots([...UPPER, ...DIGITS]),
  pageMarker: pageMarker(1),
};

// Page 2 of 3 — a-z (26 glyphs, fills 13x2 exactly).
export const FONTSERU_ALL_GLYPHS_P2: WorksheetTemplate = {
  id: "fontseru-all-glyphs-v1-p2",
  name: "FontSeru — Halaman 2/3 (a-z)",
  version: "3.0.0",
  svgTemplateAttr: "fontseru-all-glyphs-v1-p2",
  pageSizeMm: PAGE_MM,
  fiducials: sharedFiducials(),
  grid: sharedGrid(rowsFor(LOWER.length)),
  slots: buildSlots(LOWER),
  pageMarker: pageMarker(2),
};

// Page 3 of 3 — punctuation + symbols (41 glyphs).
export const FONTSERU_ALL_GLYPHS_P3: WorksheetTemplate = {
  id: "fontseru-all-glyphs-v1-p3",
  name: "FontSeru — Halaman 3/3 (Punctuation & Symbols)",
  version: "3.0.0",
  svgTemplateAttr: "fontseru-all-glyphs-v1-p3",
  pageSizeMm: PAGE_MM,
  fiducials: sharedFiducials(),
  grid: sharedGrid(rowsFor(PUNCT.length + SYMBOLS.length)),
  slots: buildSlots([...PUNCT, ...SYMBOLS]),
  pageMarker: pageMarker(3),
};

registerWorksheetTemplate(FONTSERU_ALL_GLYPHS_P1);
registerWorksheetTemplate(FONTSERU_ALL_GLYPHS_P2);
registerWorksheetTemplate(FONTSERU_ALL_GLYPHS_P3);
