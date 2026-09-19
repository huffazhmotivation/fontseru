import type { Contour, VectorObject } from "@/types/geometry";
import { shortId } from "@/utils/id";
import { objectsBoundsPx } from "@/trace/imageTrace";
import { resolveViewportMatrix, type RawNode } from "@/trace/svgImport";
import { pageFractionToSource } from "@/worksheet/homography";
import { getWorksheetTemplates } from "@/worksheet/templates/registry";
import type { WorksheetCellResult, WorksheetCellSlot, WorksheetDetectionResult, WorksheetTemplate } from "@/worksheet/types";
import { collectSvgShapes, type SvgShape, type SvgShapeBounds } from "./collectShapes";
import { isNearWhiteOrNone, parseColor, luminance } from "./color";
import { detectVectorMarkers, pickCornerMarkers, type DetectedVectorMarker } from "./vectorMarkers";

/**
 * Same marker-based philosophy as the raster/photo pipeline
 * (`raster/detectRasterWorksheet.ts`), applied to vector geometry
 * instead of pixels: find the 4 corner fiducials + optional page marker
 * by their *shape* (solid square + N enclosed light dots), build a page
 * transform from them, then bucket every remaining vector shape into
 * whichever cell it geometrically falls inside. A cell's own printed
 * guide-box outline and ID-tag dots are recognized and excluded by
 * appearance (their own known fill/size), exactly mirroring how the
 * raster pipeline's inset crop + border-clear keep those out of a traced
 * photo. None of this depends on `data-fontseru-*` attributes surviving
 * a round-trip through a design tool — only the visible marker shapes
 * need to still be there, and design tools don't touch those.
 */

function boundsCenter(b: SvgShapeBounds) { return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; }

/**
 * A shape counts as our own guide/decoration (box border, baseline,
 * x-height/cap-height lines) — never real ink — when both its fill and
 * its stroke are "invisible-ish": no fill (or white/none), and no stroke
 * or a very pale one. Real handwriting content always has either a solid
 * dark fill or a solid dark stroke, so this never excludes actual ink,
 * regardless of the shape's size — which matters now that guide lines
 * are thin strokes rather than a single box-sized rect.
 */
function isDecorationShape(shape: SvgShape): boolean {
  if (!isNearWhiteOrNone(shape.fill)) return false;
  if (shape.stroke == null) return true;
  const s = shape.stroke.trim().toLowerCase();
  if (s === "none" || s === "transparent") return true;
  const c = parseColor(s);
  if (!c) return false;
  return luminance(c) > 200;
}

function shapesToVectorObject(shapes: SvgShape[]): VectorObject | null {
  const contours: Contour[] = [];
  for (const shape of shapes) {
    for (const sp of shape.subpaths) {
      if (sp.length < 2) continue;
      contours.push({
        id: shortId("ws_c"),
        closed: true,
        nodes: sp.map((n: RawNode) => ({ id: shortId("tn"), point: n.point, handleIn: n.handleIn, handleOut: n.handleOut, type: "corner" as const })),
      });
    }
  }
  if (!contours.length) return null;
  return { id: shortId("ws_obj"), kind: "shape", contours };
}

function extractCellsForTemplate(
  template: WorksheetTemplate,
  shapes: SvgShape[],
  markerShapeSet: Set<SvgShape>,
  pageToSource: (u: number, v: number) => { x: number; y: number }
): WorksheetDetectionResult {
  const { grid } = template;
  const cells: WorksheetCellResult[] = [];
  let detectedCount = 0;

  for (const gridSlot of template.slots as WorksheetCellSlot[]) {
    const rowTop = grid.originY + gridSlot.row * (grid.labelHeight + grid.labelGap + grid.cellHeight + grid.gapY);
    const x0 = grid.originX + gridSlot.col * (grid.cellWidth + grid.gapX);
    const x1 = x0 + grid.cellWidth;
    const boxV0 = rowTop + grid.labelHeight + grid.labelGap;
    const boxV1 = boxV0 + grid.cellHeight;
    const insetFrac = grid.writeInset ?? 0.06;
    const insetX = grid.cellWidth * insetFrac;
    const insetY = grid.cellHeight * insetFrac;

    const writeCorners = [
      pageToSource(x0 + insetX, boxV0 + insetY),
      pageToSource(x1 - insetX, boxV0 + insetY),
      pageToSource(x1 - insetX, boxV1 - insetY),
      pageToSource(x0 + insetX, boxV1 - insetY),
    ];
    const wMinX = Math.min(...writeCorners.map((p) => p.x));
    const wMaxX = Math.max(...writeCorners.map((p) => p.x));
    const wMinY = Math.min(...writeCorners.map((p) => p.y));
    const wMaxY = Math.max(...writeCorners.map((p) => p.y));

    const inkShapes = shapes.filter((shape) => {
      if (markerShapeSet.has(shape)) return false;
      if (isDecorationShape(shape)) return false;
      const c = boundsCenter(shape.bounds);
      return c.x >= wMinX && c.x <= wMaxX && c.y >= wMinY && c.y <= wMaxY;
    });

    const obj = inkShapes.length ? shapesToVectorObject(inkShapes) : null;
    if (!obj) {
      cells.push({ slot: gridSlot, status: "missing", objects: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } });
      continue;
    }
    const bounds = objectsBoundsPx([obj]) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    cells.push({ slot: gridSlot, status: "detected", objects: [obj], bounds });
    detectedCount++;
  }

  const confidence = template.slots.length > 0 ? detectedCount / template.slots.length : 0;
  return { template, cells, confidence, warnings: [] };
}

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

  const { matrix: rootMatrix } = resolveViewportMatrix(root, false);
  const shapes = collectSvgShapes(root, rootMatrix);
  if (shapes.length === 0) return null;

  const markers = detectVectorMarkers(shapes);
  const corners = pickCornerMarkers(markers);
  if (!corners) return null; // Not a recognizable FontSeru worksheet — caller falls back to the ordinary manual "Import SVG" flow.

  const pageMarkerCandidates = markers.filter((m) => !corners.includes(m));
  const markerShapeSet = new Set<SvgShape>();
  // Best-effort: also exclude the marker squares' own dot children from
  // ever being mistaken for ink (they're tiny and near page corners, so
  // this rarely matters, but it's free correctness).
  for (const s of shapes) {
    for (const c of corners) if (s.bounds === c.bounds) markerShapeSet.add(s);
    for (const c of pageMarkerCandidates) if (s.bounds === c.bounds) markerShapeSet.add(s);
  }

  let best: WorksheetDetectionResult | null = null;
  for (const template of getWorksheetTemplates()) {
    const orderedCorners = orderCornersForTemplate(corners, template);
    if (!orderedCorners) continue;
    // Only gate on the page marker when the file actually has extra
    // marker-shaped candidates beyond the 4 corners to check against —
    // a worksheet made before this disambiguation marker existed (or one
    // where it didn't survive re-export) has none at all, and should
    // still be matched by which template's cells actually contain ink,
    // not silently rejected.
    if (template.pageMarker && pageMarkerCandidates.length > 0) {
      const match = pageMarkerCandidates.find((c) => c.id === template.pageMarker!.dotCount);
      if (!match) continue;
    }
    const pageToSource = pageFractionToSource(orderedCorners, template.fiducials);
    const result = extractCellsForTemplate(template, shapes, markerShapeSet, pageToSource);
    const detected = result.cells.filter((c) => c.status === "detected").length;
    const bestDetected = best ? best.cells.filter((c) => c.status === "detected").length : -1;
    if (detected > bestDetected) best = result;
  }

  if (!best) return null;
  const detectedFraction = best.cells.filter((c) => c.status === "detected").length / Math.max(1, best.cells.length);
  if (detectedFraction <= 0) return null; // Marker geometry matched but not a single cell had any ink — treat as not-a-filled-worksheet, fall back to manual.
  return best;
}

function orderCornersForTemplate(corners: DetectedVectorMarker[], template: WorksheetTemplate): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] | null {
  const byId = new Map(corners.map((c) => [c.id, c]));
  const order: Array<{ x: number; y: number }> = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const out: Array<{ x: number; y: number }> = [];
  for (const corner of order) {
    const spec = template.fiducials.find((f) => Math.round(f.x) === corner.x && Math.round(f.y) === corner.y);
    if (!spec) return null;
    const found = byId.get(spec.id);
    if (!found) return null;
    out.push(found.center);
  }
  return out as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
}
