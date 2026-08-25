import "@/worksheet/templates/fontSeruBasicLatin"; // side-effect: registers the default template.
import { detectRasterWorksheet } from "@/worksheet/raster/detectRasterWorksheet";
import { detectSvgWorksheet } from "@/worksheet/svg/detectSvgWorksheet";
import type { WorksheetDetectionResult } from "@/worksheet/types";

const IMAGE_TYPE_RE = /^image\/(png|jpe?g)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g)$/i;
const SVG_TYPE_RE = /^image\/svg\+xml$/i;
const SVG_EXT_RE = /\.svg$/i;

function isImageFile(file: File): boolean {
  return IMAGE_TYPE_RE.test(file.type) || IMAGE_EXT_RE.test(file.name);
}
function isSvgFile(file: File): boolean {
  return SVG_TYPE_RE.test(file.type) || SVG_EXT_RE.test(file.name);
}

/**
 * Best-effort worksheet detection for a file the user just dropped/picked
 * into Trace Image. Returns `null` whenever the file isn't confidently a
 * recognized FontSeru worksheet — callers must treat that as "fall back to
 * the existing manual Trace Image / Import SVG flow, unchanged", never as
 * an error to surface.
 */
export async function detectWorksheet(file: File): Promise<WorksheetDetectionResult | null> {
  try {
    if (isSvgFile(file)) return await detectSvgWorksheet(file);
    if (isImageFile(file)) return await detectRasterWorksheet(file);
  } catch {
    return null;
  }
  return null;
}
