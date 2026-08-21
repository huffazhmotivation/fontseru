import type { WorksheetDetectionResult } from "./types";
import { detectRasterWorksheet } from "./detectRasterWorksheet";
import { detectSvgWorksheet } from "./detectSvgWorksheet";

export type { WorksheetDetectionResult, WorksheetCellResult, WorksheetCellStatus, WorksheetTemplate } from "./types";
export { listWorksheetTemplates, getWorksheetTemplate } from "./registry";

/**
 * Single entry point the Trace Image overlay calls for every imported
 * image/SVG file. Resolves to `null` whenever the file isn't a recognized
 * FontSeru worksheet (including on any internal detection error) — the
 * caller must treat `null` exactly like "not a worksheet" and continue with
 * the existing manual Trace Image / Import SVG flow, completely unchanged.
 */
export async function detectWorksheet(file: File, kind: "raster" | "svg"): Promise<WorksheetDetectionResult | null> {
  try {
    return kind === "svg" ? await detectSvgWorksheet(file) : await detectRasterWorksheet(file);
  } catch {
    // Detection must never be able to break the existing Trace Image flow —
    // any unexpected failure here just means "treat as not a worksheet".
    return null;
  }
}
