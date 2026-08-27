import type { WorksheetTemplate } from "@/worksheet/types";

const registry = new Map<string, WorksheetTemplate>();

/** Registers (or replaces) a worksheet template. Call this once, at module load, from the template's own file — see `fontSeruBasicLatin.ts` for the pattern new templates should follow. */
export function registerWorksheetTemplate(template: WorksheetTemplate): void {
  registry.set(template.id, template);
}

export function getWorksheetTemplate(id: string): WorksheetTemplate | undefined {
  return registry.get(id);
}

export function getWorksheetTemplates(): WorksheetTemplate[] {
  return Array.from(registry.values());
}
