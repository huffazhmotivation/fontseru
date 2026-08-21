import type { WorksheetTemplate } from "./types";
import { FONTSERU_CLASSIC_A4 } from "./templates/fontseruClassicA4";

/**
 * All templates the detector will try to match an imported file against.
 * To add a new worksheet layout or glyph set later: build a new
 * `WorksheetTemplate` (see fontseruClassicA4.ts for a fully-commented
 * example + the `buildGridCells` helper it uses) and add it here. Nothing
 * else in the app needs to change — detection, tracing, and the review UI
 * are all template-agnostic.
 */
const TEMPLATES: WorksheetTemplate[] = [FONTSERU_CLASSIC_A4];

export function listWorksheetTemplates(): WorksheetTemplate[] {
  return TEMPLATES;
}

export function getWorksheetTemplate(id: string): WorksheetTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
