import { despeckleBinary, loadImageFile, objectsBoundsPx, traceBinaryImage } from "@/trace/imageTrace";
import { listWorksheetTemplates } from "./registry";
import { computeHomography, applyHomography, sampleLuminanceBilinear, type Homography } from "./geometry";
import { findFiducialCandidates, pickPageCorners } from "./fiducials";
import type { TemplatePoint, WorksheetCellResult, WorksheetDetectionResult, WorksheetTemplate } from "./types";

/** Longest source-image side used for both fiducial search and cell sampling — one working resolution keeps the homography and the pixels it samples from in agreement (no separate low-res "search" pass to rescale afterwards). */
const WORK_MAX_DIM = 1400;

/** Longest side of each cell's own warped output canvas. */
const CELL_OUT_MAX = 220;

const INK_THRESHOLD = 130;
const MIN_CELL_INK_RATIO = 0.004;

function drawToWorkingCanvas(img: HTMLImageElement): { canvas: HTMLCanvasElement; imgd: ImageData } {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, WORK_MAX_DIM / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const imgd = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { canvas, imgd };
}

function sampleMarkInk(source: ImageData, H: Homography, mark: { x: number; y: number; size: number }): boolean {
  const half = mark.size / 2;
  let inkCount = 0;
  let total = 0;
  const steps = 5;
  for (let iy = 0; iy < steps; iy++) {
    for (let ix = 0; ix < steps; ix++) {
      const tx = mark.x - half + (ix / (steps - 1)) * mark.size;
      const ty = mark.y - half + (iy / (steps - 1)) * mark.size;
      const p = applyHomography(H, { x: tx, y: ty });
      const lum = sampleLuminanceBilinear(source, p.x, p.y);
      total++;
      if (lum < INK_THRESHOLD) inkCount++;
    }
  }
  return total > 0 && inkCount / total > 0.5;
}

/** Warps one cell's content rectangle (template space) into its own small binarized output canvas, sampling back through the source photo via the homography. */
function warpCellToBinaryImage(
  source: ImageData,
  H: Homography,
  contentRect: { x: number; y: number; width: number; height: number }
): { imgd: ImageData; inkRatio: number } {
  const scale = CELL_OUT_MAX / Math.max(contentRect.width, contentRect.height);
  const outW = Math.max(8, Math.round(contentRect.width * scale));
  const outH = Math.max(8, Math.round(contentRect.height * scale));
  const out = new ImageData(outW, outH);
  let inkCount = 0;

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const tx = contentRect.x + ((ox + 0.5) / outW) * contentRect.width;
      const ty = contentRect.y + ((oy + 0.5) / outH) * contentRect.height;
      const p = applyHomography(H, { x: tx, y: ty });
      const lum = sampleLuminanceBilinear(source, p.x, p.y);
      const isInk = lum < INK_THRESHOLD;
      if (isInk) inkCount++;
      const idx = (oy * outW + ox) * 4;
      const v = isInk ? 0 : 255;
      out.data[idx] = v;
      out.data[idx + 1] = v;
      out.data[idx + 2] = v;
      out.data[idx + 3] = 255;
    }
  }

  return { imgd: out, inkRatio: inkCount / (outW * outH) };
}

function tryTemplate(template: WorksheetTemplate, source: ImageData): WorksheetDetectionResult | null {
  const candidates = findFiducialCandidates(source);
  const corners = pickPageCorners(candidates);
  if (!corners) return null;

  const templateCorners: TemplatePoint[] = [template.fiducials.tl, template.fiducials.tr, template.fiducials.bl, template.fiducials.br];
  const imageCorners: TemplatePoint[] = [corners.tl, corners.tr, corners.bl, corners.br];
  const H = computeHomography(templateCorners, imageCorners);
  if (!H) return null;

  const validations = template.validationMarks.map((mark) => sampleMarkInk(source, H, mark) === mark.expectInk);
  const validRatio = validations.filter(Boolean).length / Math.max(1, validations.length);
  if (validRatio < 1) return null; // not this template (or not a worksheet at all) — let the caller fall back to manual mode

  const cells: WorksheetCellResult[] = template.cells.map((cellSpec) => {
    const { imgd, inkRatio } = warpCellToBinaryImage(source, H, cellSpec.contentRect);
    if (inkRatio < MIN_CELL_INK_RATIO) {
      return { cellId: cellSpec.id, char: cellSpec.char, status: "missing", objects: [], bounds: null };
    }
    despeckleBinary(imgd, 3);
    const objects = traceBinaryImage(imgd, "medium");
    if (objects.length === 0) {
      return { cellId: cellSpec.id, char: cellSpec.char, status: "missing", objects: [], bounds: null };
    }
    return { cellId: cellSpec.id, char: cellSpec.char, status: "detected", objects, bounds: objectsBoundsPx(objects) };
  });

  return { templateId: template.id, templateLabel: template.label, source: "raster", confidence: validRatio, cells };
}

/**
 * Attempts to recognize `file` as a photographed/scanned FontSeru
 * worksheet and, if so, traces every filled-in cell. Returns null for any
 * non-worksheet image (or one where recognition isn't confident) — callers
 * must treat null exactly like "not a worksheet" and fall back to the
 * regular manual Trace Image flow, unchanged.
 */
export async function detectRasterWorksheet(file: File): Promise<WorksheetDetectionResult | null> {
  const img = await loadImageFile(file);
  const { imgd } = drawToWorkingCanvas(img);

  for (const template of listWorksheetTemplates()) {
    const result = tryTemplate(template, imgd);
    if (result) return result;
  }
  return null;
}
