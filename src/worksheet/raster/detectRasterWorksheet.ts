import { despeckleBinary, loadImageFile, objectsBoundsPx, traceBinaryImage } from "@/trace/imageTrace";
import { getWorksheetTemplates } from "@/worksheet/templates/registry";
import { pageFractionToSource } from "@/worksheet/homography";
import type { WorksheetCellResult, WorksheetDetectionResult, WorksheetGridSpec, WorksheetTemplate } from "@/worksheet/types";
import { detectFiducials, orderFiducialsForTemplate, decodeDotCountFromRaster } from "./fiducials";
import { luminanceGrid } from "./binaryOps";
import { clearBinaryImageDataBorder, grayToBinaryImageData, rectifyRegionToGray } from "./rectify";

/** Caps the working resolution for fiducial search + rectification — large enough to keep the small page marker legible, small enough to stay fast for a full-page photo. */
const MAX_SOURCE_DIMENSION = 2600;
/** Ink islands smaller than this (px, in the cell's own raster space) are scrubbed before tracing — same purpose as `DESPECKLE_MIN_AREA` in imageTrace.ts, scaled up alongside `cellRasterSize` (340px) so the noise floor stays the same relative size instead of effectively loosening as resolution increases. */
const CELL_DESPECKLE_MIN_AREA = 10;
/**
 * How far inward (as a fraction of the writing box's own width/height) the
 * cropped/rectified raster is pulled in from the *printed* box border, so
 * the border itself is never part of the pixels considered at all.
 * Kept small now — the guide lines *inside* the box (baseline/x-height/
 * cap-height) are handled separately and more reliably below, so this
 * inset only needs to cover the outer border, not fight for margin
 * against letterforms drawn close to the box edge.
 */
const DEFAULT_WRITE_INSET = 0.025;
/** Second line of defense: after binarizing the (already inset) writing-box raster, clear this many border pixels back to background before despeckle/trace — catches any residual border/smudge right at the crop edge regardless of inset. */
const BORDER_CLEAR_PX = 3;
/**
 * How many raster pixels wide the scanned band is around each internal
 * guide line (baseline/x-height/cap-height). Sized generously relative to
 * the printed line's own stroke width so JPEG blur/misalignment can't
 * leave a sliver behind.
 */
const GUIDE_LINE_ERASE_PX = 5;

/**
 * Bounds the auto-detected global ink threshold to a sane range. Without
 * this, a page with almost no real ink anywhere (e.g. the user only wrote
 * in 1–2 boxes) could let Otsu land on a near-arbitrary value, since a
 * histogram with barely any dark population gives it very little to
 * separate. Real pencil/pen ink under normal lighting sits well inside
 * this range; printed guide lines and paper texture never do.
 */
const GLOBAL_THRESHOLD_MIN = 70;
const GLOBAL_THRESHOLD_MAX = 210;

/**
 * Luminance (0–255) above which a pixel inside a guide-line band is still
 * considered "pale enough to plausibly be the printed guide line" and gets
 * erased before thresholding. Deliberately a fixed, independent cutoff
 * rather than derived from the page's global ink threshold: a printed
 * guide line (`GUIDE_COLOR` = #e6e9e2 in renderTemplateSvg.ts, ~231
 * luminance) can still read meaningfully darker in a locally shadowed
 * corner of an unevenly-lit photo even when the rest of the page is fine —
 * exactly the situation where the global threshold (calibrated from the
 * whole page, and clamped so it can't drift too low) might otherwise
 * accept it as ink. Kept comfortably below the guide line's own printed
 * color but well above genuinely dark pencil/pen ink, so real handwriting
 * — including strokes that intentionally touch the line, as the worksheet
 * is designed for — is never at risk: this only ever removes pixels inside
 * a band we already know is a printed guide line by grid geometry.
 */
const GUIDE_LINE_PALE_CUTOFF = 200;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Which raster rows (in a cell's own inset raster space) fall inside one of
 * the template's known guide-line bands — precomputed once per grid/size
 * combination instead of recomputed per cell.
 */
function guideLineRowMask(size: number, grid: WorksheetGridSpec, insetFrac: number): Uint8Array {
  const mask = new Uint8Array(size);
  const lines = grid.guideLines ?? [];
  const denom = 1 - 2 * insetFrac;
  if (denom <= 0) return mask;
  for (const line of lines) {
    const t = (line.fractionY - insetFrac) / denom;
    if (t < 0 || t > 1) continue; // falls within the already-cropped-out margin.
    const centerRow = Math.round(t * (size - 1));
    const r0 = Math.max(0, centerRow - GUIDE_LINE_ERASE_PX);
    const r1 = Math.min(size - 1, centerRow + GUIDE_LINE_ERASE_PX);
    for (let y = r0; y <= r1; y++) mask[y] = 1;
  }
  return mask;
}

/**
 * Deterministically blanks the known guide-line bands back to white before
 * thresholding, but only pixels inside them that are actually pale
 * (`> cutoff`) — never a genuinely dark pixel, even one sitting exactly on
 * a guide line. A worksheet's guide lines exist precisely so the user
 * aligns strokes to touch them (cap-height serifs, x-height crossbars,
 * every letter's baseline foot), so blanking the whole band regardless of
 * content used to cut exactly that ink away, breaking letters into
 * disconnected fragments that despeckle then discarded.
 *
 * `cutoff` is deliberately independent of (and typically lower than) the
 * shared ink `threshold` used everywhere else: the *global* threshold has
 * to stay strict enough not to swallow faint printed lines across the
 * whole page on average, but a photo's lighting is never perfectly even —
 * a guide line sitting in a slightly shadowed part of the page can still
 * read darker locally than that global cutoff, which is exactly the "pale
 * line misread as ink" failure this function exists to catch. Erasure
 * only ever touches a band we *know* is a printed guide line by grid
 * geometry, so even a generous cutoff here can't remove real handwriting
 * from anywhere else in the cell — only right on top of the line itself,
 * and only the paler of what's there.
 */
function eraseGuideLineBands(gray: Uint8ClampedArray, size: number, rowMask: Uint8Array, cutoff: number) {
  for (let y = 0; y < size; y++) {
    if (!rowMask[y]) continue;
    const rowStart = y * size;
    for (let x = 0; x < size; x++) {
      const p = rowStart + x;
      if (gray[p] > cutoff) gray[p] = 255;
    }
  }
}

/** Otsu's method computed from a pre-built histogram rather than a raw sample array — lets `computeGlobalInkThreshold` accumulate counts across every cell without ever materializing one giant combined pixel array. */
function otsuFromHistogram(hist: Float64Array): number {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return 128;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

/**
 * Picks ONE ink/paper threshold for the whole page instead of letting each
 * cell calibrate its own via Otsu. Per-cell Otsu sounds appealing — it
 * looked like it should adapt to lighting — but in practice it was the
 * actual source of both symptoms reported against it: a cell with only a
 * little ink (or ink concentrated in one area, e.g. a bold top stroke)
 * gets its own tiny, skewed histogram, and Otsu happily carves that into
 * two groups regardless — sometimes picking a threshold so strict that
 * only the darkest few pixels of a letter (often just where pen pressure
 * was heaviest, near the top) survive while the rest of the same stroke,
 * genuinely dark ink but a shade lighter, falls on the "paper" side and
 * disappears (letters cut off); sometimes the opposite, where a faint
 * printed guide line or paper shadow becomes "ink" simply for being the
 * relatively darkest thing in an otherwise empty box.
 *
 * A single global threshold, computed once from every writing box on the
 * page combined, still adapts to *this specific photo's* lighting/exposure
 * (a dim photo and a bright one get different thresholds) but is anchored
 * by the full page's real ink population instead of one cell's sparse,
 * unreliable sample — so the same absolute darkness counts as "ink"
 * everywhere, and a genuinely dark pixel is never excluded just because
 * the box it happens to sit in was otherwise faint or empty.
 */
function computeGlobalInkThreshold(cellGrays: Uint8ClampedArray[], rowMask: Uint8Array, size: number): number {
  const hist = new Float64Array(256);
  for (const gray of cellGrays) {
    for (let y = 0; y < size; y++) {
      if (rowMask[y]) continue; // guide-line rows would otherwise dump a large pale mass into the histogram and drag the split toward "everything's paper".
      const rowStart = y * size;
      for (let x = 0; x < size; x++) hist[gray[rowStart + x]]++;
    }
  }
  return clamp(otsuFromHistogram(hist), GLOBAL_THRESHOLD_MIN, GLOBAL_THRESHOLD_MAX);
}

async function loadSourceGray(file: File): Promise<{ gray: Uint8ClampedArray; width: number; height: number }> {
  const img = await loadImageFile(file);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, MAX_SOURCE_DIMENSION / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D tidak didukung di browser ini.");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const imgd = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { gray: luminanceGrid(imgd), width: canvas.width, height: canvas.height };
}

function tryTemplate(
  template: WorksheetTemplate,
  gray: Uint8ClampedArray,
  width: number,
  height: number
): WorksheetDetectionResult | null {
  const detected = detectFiducials(gray, width, height);
  if (!detected) return null;
  const orderedCorners = orderFiducialsForTemplate(detected, template.fiducials);
  if (!orderedCorners) return null;

  const pageToSource = pageFractionToSource(orderedCorners, template.fiducials);

  // Page 1 and page 2 share identical corner-fiducial geometry, so the 4
  // corners alone can't tell them apart — the small page marker resolves
  // that. Only a confident, valid mismatch rejects the template; if the
  // marker itself didn't decode cleanly, detected-cell-count below still
  // resolves which template actually fits.
  if (template.pageMarker) {
    const pm = template.pageMarker;
    const half = 0.5;
    const markerRaster = rectifyRegionToGray(
      gray, width, height, pageToSource,
      pm.x - pm.sizeX * half, pm.y - pm.sizeY * half, pm.x + pm.sizeX * half, pm.y + pm.sizeY * half,
      96
    );
    const decodedPage = decodeDotCountFromRaster(markerRaster.gray, markerRaster.width, markerRaster.height);
    if (decodedPage >= 1 && decodedPage <= 4 && decodedPage !== pm.dotCount) return null;
  }

  const { grid } = template;
  const insetFrac = grid.writeInset ?? DEFAULT_WRITE_INSET;
  const rowMask = guideLineRowMask(grid.cellRasterSize, grid, insetFrac);

  // Pass 1: rectify every cell's writing box up front (no thresholding
  // yet) so their combined pixels can calibrate one shared ink threshold —
  // see `computeGlobalInkThreshold` for why a single page-wide threshold
  // beats each cell guessing independently.
  const cellRasters = template.slots.map((gridSlot) => {
    const rowTop = grid.originY + gridSlot.row * (grid.labelHeight + grid.labelGap + grid.cellHeight + grid.gapY);
    const x0 = grid.originX + gridSlot.col * (grid.cellWidth + grid.gapX);
    const x1 = x0 + grid.cellWidth;
    const boxV0 = rowTop + grid.labelHeight + grid.labelGap;
    const boxV1 = boxV0 + grid.cellHeight;
    const insetX = grid.cellWidth * insetFrac;
    const insetY = grid.cellHeight * insetFrac;
    return rectifyRegionToGray(
      gray, width, height, pageToSource,
      x0 + insetX, boxV0 + insetY, x1 - insetX, boxV1 - insetY,
      grid.cellRasterSize
    );
  });

  const threshold = computeGlobalInkThreshold(
    cellRasters.map((r) => r.gray),
    rowMask,
    grid.cellRasterSize
  );

  const cells: WorksheetCellResult[] = [];

  // Pass 2: every cell's character comes purely from its grid position —
  // no per-cell code to read at all. See `templates/fontSeruBasicLatin.ts`.
  template.slots.forEach((gridSlot, i) => {
    const cellRaster = cellRasters[i];
    eraseGuideLineBands(cellRaster.gray, cellRaster.width, rowMask, GUIDE_LINE_PALE_CUTOFF);
    const binaryImgd = grayToBinaryImageData(cellRaster.gray, cellRaster.width, cellRaster.height, threshold);
    clearBinaryImageDataBorder(binaryImgd, BORDER_CLEAR_PX);
    despeckleBinary(binaryImgd, CELL_DESPECKLE_MIN_AREA);
    // "high" gives imagetracer the tightest curve-fit tolerance, so the
    // traced outline hugs the actual binarized ink as closely as possible
    // instead of smoothing/rounding it toward a coarser approximation.
    const objects = traceBinaryImage(binaryImgd, "high");

    if (objects.length === 0) {
      cells.push({ slot: gridSlot, status: "missing", objects: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } });
      return;
    }
    const bounds = objectsBoundsPx(objects) ?? { minX: 0, minY: 0, maxX: cellRaster.width, maxY: cellRaster.height };
    cells.push({ slot: gridSlot, status: "detected", objects, bounds });
  });

  const detectedCount = cells.filter((c) => c.status === "detected").length;
  const confidence = template.slots.length > 0 ? detectedCount / template.slots.length : 0;
  return { template, cells, confidence, warnings: [] };
}

/** Minimum fraction of cells that must have produced a real traced shape before we treat the file as a genuine worksheet. Below this, the caller falls back to the ordinary manual Trace Image flow untouched. */
const MIN_DETECTED_FRACTION = 0.15;

export async function detectRasterWorksheet(file: File): Promise<WorksheetDetectionResult | null> {
  const { gray, width, height } = await loadSourceGray(file);

  let best: WorksheetDetectionResult | null = null;
  for (const template of getWorksheetTemplates()) {
    const result = tryTemplate(template, gray, width, height);
    if (result && (!best || result.confidence > best.confidence)) best = result;
  }
  if (!best || best.confidence < MIN_DETECTED_FRACTION) return null;
  return best;
}
