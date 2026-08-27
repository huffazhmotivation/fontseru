import type { VectorObject } from "@/types/geometry";

/**
 * Worksheet Import — Auto Glyph Mapping
 * ======================================
 * This module is fully additive: it never changes the existing Trace Image
 * data model (VectorObject / GlyphOutline / Contour) or glyph ordering. A
 * detected worksheet is just a bulk producer of the exact same
 * `{ objects: VectorObject[] }` shape that manual tracing / SVG import
 * already produce per letter — so committing a cell to a glyph reuses
 * `fitTracedObjectsToGlyph` + `commitTracedGlyphOutline` completely
 * unchanged (see `src/components/TraceImage/WorksheetReviewPanel.tsx`).
 *
 * Identification is marker/ID based, never OCR:
 *  - 4 corner fiducial markers (solid squares, each carrying a small
 *    orientation id 1..4) resolve rotation/scale/crop/mild perspective via
 *    a projective (square→quad) transform.
 *  - Every cell additionally carries its own small binary ID tag baked in
 *    at a fixed position, decoded straight from the rectified cell raster
 *    (no shape/letter recognition involved) as a defensive cross-check
 *    against the grid position derived from the fiducials.
 */

/** A single slot in the worksheet grid: which glyph character it fills. */
export interface WorksheetCellSlot {
  /** Stable numeric id, 0-based, also encoded in-print as the cell's binary ID tag. */
  index: number;
  /** Target glyph character (matches `Glyph.char` / `GlyphMap` key). */
  char: string;
  /** Row-major grid position within the template. */
  row: number;
  col: number;
}

/** One of the 4 page corner fiducial markers, in template (page-normalized 0..1) space. Uses separate x/y extents so the printed marker is a true physical square even on a non-square page (e.g. A4). */
export interface WorksheetFiducialSpec {
  /** 1 = top-left, 2 = top-right, 3 = bottom-right, 4 = bottom-left. Encoded as inner dot count on print, decoded from the photo to resolve orientation regardless of how the page was rotated when photographed. */
  id: 1 | 2 | 3 | 4;
  /** Center position in normalized page space (0..1, 0..1). */
  x: number;
  y: number;
  /** Marker half-extents in normalized page space (independent per axis so the printed square stays physically square on a non-square page). */
  sizeX: number;
  sizeY: number;
}

/**
 * Small print-only typography guide lines drawn inside each writing box
 * (baseline, x-height, cap-height) so letterforms line up consistently —
 * purely visual reference, always rendered in a pale color that sits
 * safely below any real ink's contrast (see `svg/detectSvgWorksheet.ts`'s
 * decoration check and the raster pipeline's own auto-threshold), so
 * they're never mistaken for handwriting.
 */
export interface WorksheetGuideLine {
  /** 0 = top of the writing box, 1 = bottom. */
  fractionY: number;
  dashed?: boolean;
}

export interface WorksheetGridSpec {
  columns: number;
  rows: number;
  /** Top-left of the grid, normalized page space. */
  originX: number;
  originY: number;
  /** Writing box size only — this area is 100% free of any marker/label ink. */
  cellWidth: number;
  cellHeight: number;
  /** Strip reserved above each writing box for the printed (human-readable only) letter label. */
  labelHeight: number;
  /** Gap between the label strip and the writing box below it. */
  labelGap: number;
  gapX: number;
  /** Gap between one row's writing box and the next row's label strip. */
  gapY: number;
  /** Optional baseline/x-height/cap-height reference lines drawn inside every writing box. */
  guideLines?: WorksheetGuideLine[];
  /** Output raster resolution used to rectify each writing box before tracing (px, square). */
  cellRasterSize: number;
  /** Fraction of the writing box's own width/height to crop inward from its printed border before tracing (0..0.2). Keeps the guide box border itself from ever being picked up as ink. Defaults to a safe value if omitted. */
  writeInset?: number;
}

/** Optional physical page size (mm) — used only for print-accurate SVG rendering; detection itself works at any page aspect ratio since the fiducial quad already encodes it. */
export interface WorksheetPageSizeMm {
  width: number;
  height: number;
}

/**
 * A worksheet template: everything needed to detect + decode one physical
 * (or SVG) FontSeru worksheet layout. New templates/glyph sets register
 * themselves into the registry (`src/worksheet/templates/registry.ts`)
 * without touching detection code — that's the "modular" requirement.
 * A worksheet that needs more cells than fit comfortably on one page
 * (e.g. bigger writing boxes) simply registers as several independent
 * templates, one per physical sheet — see `fontSeruBasicLatin.ts`.
 */
export interface WorksheetTemplate {
  id: string;
  name: string;
  version: string;
  fiducials: [WorksheetFiducialSpec, WorksheetFiducialSpec, WorksheetFiducialSpec, WorksheetFiducialSpec];
  grid: WorksheetGridSpec;
  slots: WorksheetCellSlot[];
  /** For SVG worksheets: the root-element attribute name that identifies this template, e.g. `data-fontseru-template="fontseru-basic-latin-v1-p1"`. Informational only now — detection no longer depends on this attribute surviving (see `svg/detectSvgWorksheet.ts`), since re-exporting an edited worksheet through a design tool (Illustrator/Affinity/Figma) commonly strips custom `data-*` attributes even though the visual marker shapes remain intact. */
  svgTemplateAttr: string;
  /** Physical page size for print-accurate SVG rendering (optional; defaults to A4 portrait in the renderer). */
  pageSizeMm?: WorksheetPageSizeMm;
  /**
   * A 5th small marker (same "solid square + N enclosed dots" scheme as
   * the 4 corner fiducials) placed away from any page corner, used only
   * to tell templates apart when they'd otherwise share identical corner
   * geometry (e.g. this family's page 1 and page 2 use the same grid
   * origin/cell size so a photo/SVG of either page produces the same
   * 4-corner quad — this marker's dot count is the tiebreaker). Optional;
   * templates that don't need disambiguation can omit it.
   */
  pageMarker?: { x: number; y: number; sizeX: number; sizeY: number; dotCount: number };
}

export type WorksheetCellStatus = "detected" | "missing";

export interface PxBoundsLike {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface WorksheetCellResult {
  slot: WorksheetCellSlot;
  status: WorksheetCellStatus;
  /** Traced/extracted shapes, in the same raw pixel-space (Y-down) convention `fitTracedObjectsToGlyph` already expects. Empty when status is "missing". */
  objects: VectorObject[];
  bounds: PxBoundsLike;
}

export interface WorksheetDetectionResult {
  template: WorksheetTemplate;
  cells: WorksheetCellResult[];
  /** Confidence 0..1 the source file really is this template (fiducial match quality). */
  confidence: number;
  warnings: string[];
}

export class WorksheetDetectionError extends Error {}
