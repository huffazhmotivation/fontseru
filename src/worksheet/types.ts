import type { VectorObject } from "@/types/geometry";
import type { PxBounds } from "@/trace/imageTrace";

/**
 * Everything in a template is expressed in an abstract, resolution- and
 * paper-size-independent "template space" (see each template file for its
 * concrete page size). A photographed/scanned worksheet gets mapped back
 * into this space via a homography computed from the four corner fiducial
 * markers (see `src/worksheet/geometry.ts` + `src/worksheet/fiducials.ts`);
 * an SVG worksheet already lives in a directly comparable coordinate space
 * (see `src/worksheet/detectSvgWorksheet.ts`), so no homography is needed.
 */
export interface TemplatePoint {
  x: number;
  y: number;
}

export interface TemplateRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One printable cell: a fixed slot on the page mapped to exactly one target glyph. */
export interface WorksheetCellSpec {
  /** Stable 0-based index — this IS the "marker ID" for the cell. Never OCR'd, always geometric/positional and fixed by the template. */
  id: number;
  /** Target glyph character this cell always maps to, in this template. */
  char: string;
  /** Full cell slot, template space. */
  rect: TemplateRect;
  /** Where the user's actual drawn/written shape is expected, template space — inset from `rect` so grid lines/labels never get traced as ink. */
  contentRect: TemplateRect;
}

/** A small solid square used to verify a candidate homography actually belongs to this template (not just any 4 dark blobs), before trusting any cell data it implies. */
export interface ValidationMark {
  x: number;
  y: number;
  size: number;
  /** Whether this spot is expected to be printed ink (true) or blank paper (false) on a genuine worksheet. */
  expectInk: boolean;
}

export interface WorksheetTemplate {
  id: string;
  label: string;
  /** Template-space page size. Unitless — only ratios and relative positions matter. */
  page: { width: number; height: number };
  /** The four bullseye corner markers used to compute the perspective-correcting homography for photographed/scanned imports. `size` is each marker's outer square side, template space. */
  fiducials: { tl: TemplatePoint; tr: TemplatePoint; bl: TemplatePoint; br: TemplatePoint; size: number };
  /** Extra spot-checks sampled after the homography is computed, so a random photo that happens to contain 4 dark corner blobs doesn't get misread as a worksheet. */
  validationMarks: ValidationMark[];
  cells: WorksheetCellSpec[];
  /**
   * SVG worksheets identify cells via a `<rect>` (or any element with
   * numeric x/y/width/height) carrying this attribute, placed as a direct
   * child of the root `<svg>` (root coordinate space — see
   * detectSvgWorksheet.ts for why). Value = the cell's `id` as a string.
   * e.g. `data-fontseru-cell="0"`.
   */
  svgCellAttr: string;
}

export type WorksheetCellStatus = "detected" | "missing" | "low-confidence";

export interface WorksheetCellResult {
  cellId: number;
  char: string;
  status: WorksheetCellStatus;
  /** Traced/imported shape for this cell, in its own local coordinate space (not shared across cells) — fine, since it's only ever consumed via fitTracedObjectsToGlyph, which normalizes from `objects`' own bounds. Empty when status is "missing". */
  objects: VectorObject[];
  bounds: PxBounds | null;
}

export interface WorksheetDetectionResult {
  templateId: string;
  templateLabel: string;
  source: "raster" | "svg";
  /** 0..1 — how confident the detector is this file really is this template. Callers should treat anything below a "not a worksheet" threshold as no match at all (see detectWorksheet.ts). */
  confidence: number;
  cells: WorksheetCellResult[];
}
