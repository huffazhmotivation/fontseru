import type { FontInfo, FontMetrics } from "@/types/font";
import type { Glyph, GlyphMap } from "@/types/glyph";
import { hasOutline } from "@/types/glyph";
import type { KerningPairs } from "@/types/kerning";
import { parseKerningKey } from "@/types/kerning";
import type { FeatureBuilderConfig } from "@/types/opentypeFeatures";
import type { Point } from "@/types/geometry";
import { isFilledObject } from "@/types/geometry";
import { flattenContour } from "@/editor/objectOps";
import { validateUnicodeMapping, type QAIssue, type QASeverity } from "@/utils/unicodeValidator";

export type { QAIssue, QASeverity };

export interface QAReport {
  issues: QAIssue[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  passCount: number;
  /** No blocking errors. Warnings/info can still exist — export is a judgment call, not gated. */
  readyToExport: boolean;
}

export interface FontQAInput {
  glyphs: GlyphMap;
  metrics: FontMetrics;
  info: FontInfo;
  kerningPairs: KerningPairs;
  featureConfig?: FeatureBuilderConfig;
}

function push(issues: QAIssue[], issue: QAIssue) {
  issues.push(issue);
}

// --- Metadata / name table -------------------------------------------------

const POSTSCRIPT_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const VERSION_RE = /^\d+\.\d{3}$/;

function checkMetadata(info: FontInfo, issues: QAIssue[]) {
  if (!info.familyName?.trim()) {
    push(issues, { id: "meta.family-name", severity: "error", title: "Nama family kosong", message: "Family Name wajib diisi — dipakai sebagai nama utama font di semua sistem." });
  }
  if (info.familyName && info.familyName.length > 31) {
    push(issues, { id: "meta.family-name-length", severity: "warning", title: "Nama family kepanjangan", message: `Family Name ${info.familyName.length} karakter — nama table legacy (platform Macintosh) memotong di 31 karakter, bisa kepotong aneh di software lama.` });
  }

  const ps = info.postscriptName ?? "";
  if (!ps.trim()) {
    push(issues, { id: "meta.postscript-name", severity: "error", title: "PostScript Name kosong", message: "PostScript Name wajib diisi dan harus unik per style." });
  } else if (!POSTSCRIPT_NAME_RE.test(ps) || ps.length > 63) {
    push(issues, { id: "meta.postscript-name", severity: "error", title: "PostScript Name tidak valid", message: `"${ps}" melanggar aturan OpenType: hanya boleh huruf/angka ASCII, titik, underscore, dan strip, tanpa spasi, maksimal 63 karakter. Ini persis jenis hal yang diperiksa ketat oleh review Monotype.` });
  } else {
    push(issues, { id: "meta.postscript-name", severity: "pass", title: "PostScript Name valid", message: `"${ps}" memenuhi format yang disyaratkan OpenType.` });
  }

  if (info.version && !VERSION_RE.test(info.version.trim())) {
    push(issues, { id: "meta.version-format", severity: "warning", title: "Format versi tidak standar", message: `"${info.version}" sebaiknya mengikuti format "Version X.YYY" (mis. "1.000") sesuai konvensi OpenType.` });
  }

  if (!info.copyright?.trim()) {
    push(issues, { id: "meta.copyright", severity: "warning", title: "Copyright notice kosong", message: "Marketplace/reviewer font (termasuk Monotype) umumnya mensyaratkan copyright notice terisi di name table." });
  }
  if (!info.license?.trim()) {
    push(issues, { id: "meta.license", severity: "warning", title: "Info lisensi kosong", message: "License description kosong. Isi field lisensi di tab License Info sebelum submit ke marketplace pihak ketiga." });
  }
  if (!info.manufacturer?.trim() && !info.designer?.trim()) {
    push(issues, { id: "meta.manufacturer", severity: "warning", title: "Foundry/Designer tidak diisi", message: "Tidak ada nama foundry maupun desainer di metadata — banyak reviewer marketplace menganggap ini font tak lengkap." });
  }
  if (info.fullName && info.familyName && !info.fullName.trim().startsWith(info.familyName.trim())) {
    push(issues, { id: "meta.fullname-mismatch", severity: "warning", title: "Full Name tidak diawali Family Name", message: `Full Name "${info.fullName}" tidak diawali dengan Family Name "${info.familyName}" — beberapa OS bisa salah mengelompokkan font ini.` });
  }
}

// --- Metrics -----------------------------------------------------------

function checkMetrics(metrics: FontMetrics, issues: QAIssue[]) {
  if (![1000, 2048].includes(metrics.unitsPerEm)) {
    push(issues, { id: "metrics.units-per-em", severity: "warning", title: "unitsPerEm bukan nilai konvensional", message: `unitsPerEm = ${metrics.unitsPerEm}. Nilai yang lazim dan paling kompatibel adalah 1000 (dunia PostScript/CFF) atau 2048 (dunia TrueType).` });
  }
  if (metrics.ascender <= 0) {
    push(issues, { id: "metrics.ascender", severity: "error", title: "Ascender tidak valid", message: `Ascender = ${metrics.ascender}, harus lebih besar dari 0.` });
  }
  if (metrics.descender >= 0) {
    push(issues, { id: "metrics.descender", severity: "error", title: "Descender tidak valid", message: `Descender = ${metrics.descender}, seharusnya bernilai negatif (di bawah baseline).` });
  }
  const totalHeight = metrics.ascender - metrics.descender;
  if (Number.isFinite(totalHeight) && totalHeight < metrics.unitsPerEm * 0.9) {
    push(issues, { id: "metrics.line-height", severity: "warning", title: "Ascender + descender terlalu sempit", message: `Ascender−descender (${totalHeight}) kurang dari 90% unitsPerEm (${metrics.unitsPerEm}) — berisiko glyph tinggi (mis. aksen, huruf besar) terpotong saat dirender.` });
  }
  if (metrics.capHeight > metrics.ascender) {
    push(issues, { id: "metrics.cap-height", severity: "warning", title: "Cap Height melebihi Ascender", message: `Cap Height (${metrics.capHeight}) > Ascender (${metrics.ascender}).` });
  }
  if (metrics.xHeight > metrics.capHeight) {
    push(issues, { id: "metrics.x-height", severity: "warning", title: "x-Height melebihi Cap Height", message: `x-Height (${metrics.xHeight}) > Cap Height (${metrics.capHeight}) — tidak umum untuk font Latin standar.` });
  }
  if (!issues.some((i) => i.id.startsWith("metrics.") && i.severity === "error")) {
    push(issues, { id: "metrics.summary", severity: "pass", title: "Metrik dasar masuk akal", message: "unitsPerEm, ascender, dan descender berada dalam rentang wajar." });
  }
}

// --- Glyph geometry ------------------------------------------------------

function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const cross = (a: Point, b: Point, c: Point) => (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x);
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True if a single closed contour's own outline crosses itself (a "figure-8"),
 * which produces incorrect fill/winding and is flagged by most font QA tools. */
function contourSelfIntersects(points: Point[]): boolean {
  const n = points.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    // Only compare against non-adjacent edges — adjacent edges always share
    // an endpoint, which isn't a self-intersection.
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const b1 = points[j];
      const b2 = points[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

const SPACE_LIKE = new Set([" ", "\u00a0", "\u2009", "\u200a"]);

function checkGlyphs(glyphs: GlyphMap, unitsPerEm: number, issues: QAIssue[]) {
  const entries = Object.entries(glyphs);
  if (entries.length === 0) {
    push(issues, { id: "glyphs.empty-set", severity: "error", title: "Belum ada glyph sama sekali", message: "Font tidak punya satu glyph pun — tidak bisa diekspor." });
    return;
  }

  const blank: string[] = [];
  const zeroWidth: string[] = [];
  const extremeWidth: string[] = [];
  const selfIntersecting: string[] = [];
  const referencedByComponent = new Set<string>();
  for (const g of entries.map(([, glyph]) => glyph)) {
    for (const ref of g.components ?? []) referencedByComponent.add(ref);
  }

  for (const [char, glyph] of entries) {
    const isSpaceLike = SPACE_LIKE.has(char) || glyph.unicode === 0x20;
    const isComponentOnly = referencedByComponent.has(char);

    if (!hasOutline(glyph) && !isSpaceLike && (glyph.components ?? []).length === 0) {
      blank.push(char);
    }

    if (!isSpaceLike) {
      if (glyph.advanceWidth <= 0) zeroWidth.push(char);
      else if (glyph.advanceWidth > unitsPerEm * 3) extremeWidth.push(char);
    }

    if (!isComponentOnly) {
      for (const obj of glyph.outline.objects) {
        if (!isFilledObject(obj)) continue;
        for (const contour of obj.contours) {
          if (contour.nodes.length < 3) continue;
          const flat = flattenContour(contour, 10);
          if (contourSelfIntersects(flat)) {
            selfIntersecting.push(char);
            break;
          }
        }
        if (selfIntersecting[selfIntersecting.length - 1] === char) break;
      }
    }
  }

  if (blank.length > 0) {
    push(issues, {
      id: "glyphs.blank",
      severity: "warning",
      title: `${blank.length} glyph masih kosong`,
      message: `Glyph ini sudah di-encode tapi belum ada outline-nya, kemungkinan belum digambar: ${blank.slice(0, 12).join(", ")}${blank.length > 12 ? ", …" : ""}.`,
      examples: blank,
    });
  }
  if (zeroWidth.length > 0) {
    push(issues, {
      id: "glyphs.zero-width",
      severity: "error",
      title: `${zeroWidth.length} glyph punya advance width 0 atau negatif`,
      message: `Glyph berikut akan tumpang tindih dengan tetangganya saat diketik: ${zeroWidth.slice(0, 12).join(", ")}${zeroWidth.length > 12 ? ", …" : ""}.`,
      examples: zeroWidth,
    });
  }
  if (extremeWidth.length > 0) {
    push(issues, {
      id: "glyphs.extreme-width",
      severity: "warning",
      title: `${extremeWidth.length} glyph punya advance width tidak wajar`,
      message: `Lebih dari 3× unitsPerEm — cek apakah ini disengaja: ${extremeWidth.slice(0, 12).join(", ")}${extremeWidth.length > 12 ? ", …" : ""}.`,
      examples: extremeWidth,
    });
  }
  if (selfIntersecting.length > 0) {
    push(issues, {
      id: "glyphs.self-intersecting",
      severity: "warning",
      title: `${selfIntersecting.length} glyph punya contour yang menyilang dirinya sendiri`,
      message: `Outline "figure-8" bikin fill/winding rasterizer jadi salah dan sering ditandai oleh QA checker font: ${selfIntersecting.slice(0, 12).join(", ")}${selfIntersecting.length > 12 ? ", …" : ""}. Cek di editor node mana yang saling silang.`,
      examples: selfIntersecting,
    });
  }
  if (blank.length === 0 && zeroWidth.length === 0 && selfIntersecting.length === 0) {
    push(issues, { id: "glyphs.summary", severity: "pass", title: "Geometri glyph bersih", message: `Semua ${entries.length} glyph punya outline & advance width yang wajar, tanpa contour yang menyilang dirinya sendiri.` });
  }
}

// --- Kerning -------------------------------------------------------------

function checkKerning(kerningPairs: KerningPairs, glyphs: GlyphMap, unitsPerEm: number, issues: QAIssue[]) {
  const entries = Object.entries(kerningPairs ?? {});
  if (entries.length === 0) return;

  const dangling: string[] = [];
  const extreme: string[] = [];
  for (const [key, value] of entries) {
    const pair = parseKerningKey(key);
    if (!pair) continue;
    if (!glyphs[pair.left] || !glyphs[pair.right]) {
      dangling.push(`${pair.left}|${pair.right}`);
      continue;
    }
    if (Math.abs(value) > unitsPerEm * 0.5) {
      extreme.push(`${pair.left}${pair.right} (${value})`);
    }
  }

  if (dangling.length > 0) {
    push(issues, {
      id: "kerning.dangling-pair",
      severity: "warning",
      title: `${dangling.length} pasangan kerning menunjuk glyph yang tak ada`,
      message: `Pasangan berikut akan dilewati saat export karena salah satu glyphnya sudah dihapus: ${dangling.slice(0, 10).join(", ")}${dangling.length > 10 ? ", …" : ""}.`,
      examples: dangling,
    });
  }
  if (extreme.length > 0) {
    push(issues, {
      id: "kerning.extreme-value",
      severity: "warning",
      title: `${extreme.length} nilai kerning terlihat ekstrem`,
      message: `Nilainya lebih dari 50% unitsPerEm, cek apakah ini disengaja: ${extreme.slice(0, 10).join(", ")}${extreme.length > 10 ? ", …" : ""}.`,
      examples: extreme,
    });
  }
  if (dangling.length === 0 && extreme.length === 0) {
    push(issues, { id: "kerning.summary", severity: "pass", title: "Pasangan kerning valid", message: `${entries.length} pasangan kerning tersimpan, semuanya menunjuk glyph yang ada dan bernilai wajar.` });
  }
}

// --- OpenType features -----------------------------------------------------

function checkFeatures(config: FeatureBuilderConfig | undefined, glyphs: GlyphMap, issues: QAIssue[]) {
  if (!config) return;
  const missing: string[] = [];
  for (const rule of config.ligatures ?? []) {
    for (const c of rule.components) if (!glyphs[c]) missing.push(`ligature ${rule.components.join("+")}: hilang "${c}"`);
    if (!glyphs[rule.target]) missing.push(`ligature target "${rule.target}" tidak ada`);
  }
  for (const rule of config.alternates ?? []) {
    if (!glyphs[rule.base]) missing.push(`alternate base "${rule.base}" tidak ada`);
    for (const alt of rule.alternates) if (!glyphs[alt]) missing.push(`alternate "${alt}" tidak ada`);
  }
  for (const rule of config.swashes ?? []) {
    if (!glyphs[rule.base]) missing.push(`swash base "${rule.base}" tidak ada`);
    if (!glyphs[rule.swash]) missing.push(`swash "${rule.swash}" tidak ada`);
  }
  if (missing.length > 0) {
    push(issues, {
      id: "features.missing-glyph",
      severity: "warning",
      title: `${missing.length} aturan OpenType Feature menunjuk glyph yang hilang`,
      message: `Aturan ini akan dilewati saat export: ${missing.slice(0, 10).join("; ")}${missing.length > 10 ? "; …" : ""}.`,
      examples: missing,
    });
  }
}

/** Runs the full pre-export QA checklist. Purely a read-only report — never
 * blocks export itself, that decision stays with the user/caller. */
export function runFontQA(input: FontQAInput): QAReport {
  const issues: QAIssue[] = [];

  checkMetadata(input.info, issues);
  checkMetrics(input.metrics, issues);
  checkGlyphs(input.glyphs, input.metrics.unitsPerEm, issues);
  issues.push(...validateUnicodeMapping(input.glyphs));
  checkKerning(input.kerningPairs, input.glyphs, input.metrics.unitsPerEm, issues);
  checkFeatures(input.featureConfig, input.glyphs, issues);

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  const infoCount = issues.filter((i) => i.severity === "info").length;
  const passCount = issues.filter((i) => i.severity === "pass").length;

  return { issues, errorCount, warningCount, infoCount, passCount, readyToExport: errorCount === 0 };
}
