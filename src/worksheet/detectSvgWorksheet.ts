import { objectsBoundsPx } from "@/trace/imageTrace";
import { importSvgFile } from "@/trace/svgImport";
import { listWorksheetTemplates } from "./registry";
import type { WorksheetCellResult, WorksheetDetectionResult, WorksheetTemplate } from "./types";

/** A template's SVG worksheet must find markers for at least this fraction of its declared cells to be recognized at all — guards against a coincidental single stray attribute in an unrelated file. */
const MIN_CELL_MATCH_RATIO = 0.6;

interface PxRect { minX: number; minY: number; maxX: number; maxY: number }

function parseLen(v: string | null): number | null {
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Mirrors svgImport.ts's own root-viewport resolution (viewBox -> pixel
 * canvas scale/offset) so a cell marker's raw x/y/width/height — read
 * directly from the SVG source, in root coordinate space — lands in the
 * exact same pixel space as the vector letters `importSvgFile` produces.
 * Deliberately root-only (no nested transforms): worksheet templates are
 * expected to place cell markers as direct children of the root <svg>,
 * documented on `WorksheetTemplate.svgCellAttr`.
 */
function resolveRootScale(root: Element): { sx: number; sy: number; ox: number; oy: number } {
  const viewBoxAttr = root.getAttribute("viewBox");
  const attrWidth = parseLen(root.getAttribute("width"));
  const attrHeight = parseLen(root.getAttribute("height"));
  if (viewBoxAttr) {
    const parts = viewBoxAttr.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
      const [minX, minY, vbW, vbH] = parts;
      const width = attrWidth ?? vbW;
      const height = attrHeight ?? vbH;
      const sx = width / vbW;
      const sy = height / vbH;
      return { sx, sy, ox: -minX * sx, oy: -minY * sy };
    }
  }
  return { sx: 1, sy: 1, ox: 0, oy: 0 };
}

function readCellBoxes(root: Element, attr: string, scale: { sx: number; sy: number; ox: number; oy: number }): Map<number, PxRect> {
  const boxes = new Map<number, PxRect>();
  const nodes = root.querySelectorAll(`[${attr}]`);
  nodes.forEach((el) => {
    const idAttr = el.getAttribute(attr);
    const id = idAttr != null ? Number(idAttr) : NaN;
    const x = parseLen(el.getAttribute("x"));
    const y = parseLen(el.getAttribute("y"));
    const w = parseLen(el.getAttribute("width"));
    const h = parseLen(el.getAttribute("height"));
    if (!Number.isFinite(id) || x == null || y == null || w == null || h == null) return;
    boxes.set(id, {
      minX: x * scale.sx + scale.ox,
      minY: y * scale.sy + scale.oy,
      maxX: (x + w) * scale.sx + scale.ox,
      maxY: (y + h) * scale.sy + scale.oy,
    });
  });
  return boxes;
}

/** Serializes a copy of `doc` with every cell-marker element removed, so those marker rects never themselves get picked up as vector "ink" by importSvgFile. */
function buildMarkerFreeSvgFile(doc: Document, attr: string, originalName: string): File {
  const clone = doc.cloneNode(true) as Document;
  clone.querySelectorAll(`[${attr}]`).forEach((el) => el.remove());
  const xml = new XMLSerializer().serializeToString(clone);
  return new File([xml], originalName, { type: "image/svg+xml" });
}

function pointIn(rect: PxRect, x: number, y: number): boolean {
  return x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
}

async function tryTemplate(template: WorksheetTemplate, doc: Document, root: Element, originalFile: File): Promise<WorksheetDetectionResult | null> {
  const scale = resolveRootScale(root);
  const boxes = readCellBoxes(root, template.svgCellAttr, scale);
  if (boxes.size === 0) return null;

  const matchRatio = boxes.size / template.cells.length;
  if (matchRatio < MIN_CELL_MATCH_RATIO) return null;

  const cleanedFile = buildMarkerFreeSvgFile(doc, template.svgCellAttr, originalFile.name);
  let imported;
  try {
    imported = await importSvgFile(cleanedFile);
  } catch {
    return null;
  }

  const cells: WorksheetCellResult[] = template.cells.map((cellSpec) => {
    const box = boxes.get(cellSpec.id);
    if (!box) return { cellId: cellSpec.id, char: cellSpec.char, status: "missing", objects: [], bounds: null };

    const matchedLetters = imported.letters.filter((letter) => {
      const cx = (letter.bounds.minX + letter.bounds.maxX) / 2;
      const cy = (letter.bounds.minY + letter.bounds.maxY) / 2;
      return pointIn(box, cx, cy);
    });
    if (matchedLetters.length === 0) {
      return { cellId: cellSpec.id, char: cellSpec.char, status: "missing", objects: [], bounds: null };
    }
    const objects = matchedLetters.flatMap((l) => l.objects);
    return { cellId: cellSpec.id, char: cellSpec.char, status: "detected", objects, bounds: objectsBoundsPx(objects) };
  });

  return { templateId: template.id, templateLabel: template.label, source: "svg", confidence: Math.min(1, matchRatio), cells };
}

/**
 * Attempts to recognize `file` as a FontSeru worksheet exported as SVG
 * (cells identified purely by explicit `data-fontseru-cell="<id>"` marker
 * attributes — never by character recognition). When cells already contain
 * vector paths, those are used directly; nothing is rasterized or re-traced.
 * Returns null for any ordinary SVG, so the caller falls back to the
 * existing plain "Import SVG" flow unchanged.
 */
export async function detectSvgWorksheet(file: File): Promise<WorksheetDetectionResult | null> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    return null;
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, "image/svg+xml");
  } catch {
    return null;
  }
  if (doc.querySelector("parsererror")) return null;

  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return null;

  const templates = listWorksheetTemplates();
  const hasAnyMarker = templates.some((t) => root.querySelector(`[${t.svgCellAttr}]`));
  if (!hasAnyMarker) return null; // cheap bail-out before the (more expensive) full vector import

  for (const template of templates) {
    const result = await tryTemplate(template, doc, root, file);
    if (result) return result;
  }
  return null;
}
