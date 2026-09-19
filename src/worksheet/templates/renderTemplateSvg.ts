import type { WorksheetTemplate } from "@/worksheet/types";

const DEFAULT_PAGE_MM = { width: 420, height: 297 };
/** Pale color used for every guide element (box border, baseline lines) — chosen to sit safely below any real ink's contrast, so detection's decoration check (and the raster pipeline's own auto-threshold) never mistakes it for handwriting. */
const GUIDE_COLOR = "#e6e9e2";

/** A handful of default glyphs (&, <, >, ") are literal XML metacharacters — inserting them into SVG text content unescaped produces a broken file that won't even parse. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fiducialMarkup(pageW: number, pageH: number, x: number, y: number, sizeX: number, sizeY: number, id: number): string {
  const px = x * pageW, py = y * pageH;
  const w = sizeX * pageW, h = sizeY * pageH;
  const halfW = w / 2, halfH = h / 2;
  const dotRx = w * 0.09, dotRy = h * 0.09;
  const dots: string[] = [];
  const spacing = w * 0.22;
  const startX = px - ((id - 1) * spacing) / 2;
  for (let i = 0; i < id; i++) {
    dots.push(`<ellipse cx="${startX + i * spacing}" cy="${py}" rx="${dotRx}" ry="${dotRy}" fill="#fff" />`);
  }
  return `<g><rect x="${px - halfW}" y="${py - halfH}" width="${w}" height="${h}" fill="#111" />${dots.join("")}</g>`;
}

function cellMarkup(template: WorksheetTemplate, pageW: number, pageH: number, slot: { index: number; char: string; row: number; col: number }): string {
  const { grid } = template;
  const cx0 = (grid.originX + slot.col * (grid.cellWidth + grid.gapX)) * pageW;
  const rowTop = grid.originY + slot.row * (grid.labelHeight + grid.labelGap + grid.cellHeight + grid.gapY);
  const labelY0 = rowTop * pageH;
  const labelH = grid.labelHeight * pageH;
  const boxY0 = (rowTop + grid.labelHeight + grid.labelGap) * pageH;
  const boxH = grid.cellHeight * pageH;
  const cw = grid.cellWidth * pageW;

  const guideLines = (grid.guideLines ?? [])
    .map((g) => {
      const y = boxY0 + g.fractionY * boxH;
      const dash = g.dashed ? ` stroke-dasharray="2.2,1.6"` : "";
      return `<line x1="${cx0}" y1="${y}" x2="${cx0 + cw}" y2="${y}" stroke="${GUIDE_COLOR}" stroke-width="0.5"${dash} />`;
    })
    .join("\n      ");

  return `<g>
    <text x="${cx0 + cw / 2}" y="${labelY0 + labelH * 0.85}" font-size="${labelH * 0.75}" text-anchor="middle" fill="#9aa196" font-family="ui-monospace, monospace" font-weight="600">${escapeXml(slot.char)}</text>
    <rect x="${cx0}" y="${boxY0}" width="${cw}" height="${boxH}" fill="none" stroke="${GUIDE_COLOR}" stroke-width="0.6" rx="3" />
    <g>
      ${guideLines}
    </g>
  </g>`;
}

/**
 * Builds a printable practice-sheet SVG for a template — a plain
 * human-readable letter label above each box (detection never reads it),
 * a clean writing box with baseline/x-height/cap-height guide lines, and
 * no dot-code tag of any kind: which glyph a box represents comes
 * entirely from its position in the grid.
 */
export function renderWorksheetTemplateSvg(template: WorksheetTemplate): string {
  const page = template.pageSizeMm ?? DEFAULT_PAGE_MM;
  const fiducials = template.fiducials
    .map((f) => fiducialMarkup(page.width, page.height, f.x, f.y, f.sizeX, f.sizeY, f.id))
    .join("\n");
  const cells = template.slots.map((slot) => cellMarkup(template, page.width, page.height, slot)).join("\n");
  const pageMarker = template.pageMarker
    ? fiducialMarkup(page.width, page.height, template.pageMarker.x, template.pageMarker.y, template.pageMarker.sizeX, template.pageMarker.sizeY, template.pageMarker.dotCount)
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}" width="${page.width}mm" height="${page.height}mm" data-fontseru-template="${escapeXml(template.svgTemplateAttr)}">
  <rect x="0" y="0" width="${page.width}" height="${page.height}" fill="#fff" />
  <text x="${page.width / 2}" y="12" font-size="6" text-anchor="middle" fill="#12160f" font-family="sans-serif" font-weight="700">${escapeXml(template.name)}</text>
  <text x="${page.width / 2}" y="17.5" font-size="3" text-anchor="middle" fill="#8a938d" font-family="sans-serif">Tulis satu huruf per kotak, sejajarkan dengan garis baseline.</text>
  ${fiducials}
  ${pageMarker}
  ${cells}
</svg>`;
}
