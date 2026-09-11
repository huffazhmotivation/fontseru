import * as opentype from "opentype.js";
import { expandStrokeObject } from "@/brushes/strokeToOutline";
import {
  applyBooleanOp,
  isBooleanEligible,
  normalizeSelfIntersectingContours,
  unionObjectsHoleAware,
  EXPAND_FIDELITY_SCALE as EXPORT_CURVE_FIDELITY_SCALE,
} from "@/editor/booleanOps";

// Export's own "Remove Overlap" pass (below) reuses the same boolean-union
// machinery as the interactive Boolean Select tool, but with a much tighter
// curve-refit tolerance (`TIGHT_CURVE_FIDELITY_SCALE`, defined in
// booleanOps.ts so `expandStrokeObject` can share the exact same value —
// see that constant's doc comment). The interactive tool's default
// tolerance favors a small, easy-to-edit node count after a manual union/
// subtract/intersect — fine for a designer editing the result by hand.
// Export never hands the result back for editing, though, and any refit
// deviation from the original curve is exactly what makes a smooth/monoline
// outline drift visibly from what Test Lab showed (small facets on an "N"
// leg join, a slightly different "U" bowl), even though Rough/Grunge/Oil
// Brush textures mask the same deviation. Scaling the tolerance down here
// keeps far more of the original curve's sampled points, so the refit
// tracks the authored bezier shape much more closely — at the cost of a few
// more on-curve nodes in the exported outline, which only export ever sees.
import type { Contour, PathNode, VectorObject } from "@/types/geometry";
import type { FontInfo, FontMetrics } from "@/types/font";
import type { Glyph, GlyphCategory, GlyphMap } from "@/types/glyph";
import type { KerningPairs } from "@/types/kerning";
import { kerningKey, parseKerningKey } from "@/types/kerning";
import { shortId } from "@/utils/id";
import { buildTrueTypeFont, type TrueTypeGlyphInput } from "@/utils/trueTypeWriter";
import type { FeatureBuilderConfig } from "@/types/opentypeFeatures";
import { isFeatureConfigEmpty } from "@/types/opentypeFeatures";

export interface ImportedFontProject {
  fontName: string;
  fontInfo: FontInfo;
  metrics: FontMetrics;
  glyphs: GlyphMap;
  kerningPairs: KerningPairs;
}

export type ExportFontFormat = "otf" | "ttf" | "woff" | "woff2";

function categoryFor(cp: number): GlyphCategory {
  if (cp >= 0x41 && cp <= 0x5a) return "upper";
  if (cp >= 0x61 && cp <= 0x7a) return "lower";
  if (cp >= 0x30 && cp <= 0x39) return "digits";
  if ((cp >= 0x21 && cp <= 0x2f) || (cp >= 0x3a && cp <= 0x40) || (cp >= 0x5b && cp <= 0x60) || (cp >= 0x7b && cp <= 0x7e)) return "punct";
  return "symbols";
}

export interface NormalizedFontMetadata extends FontInfo {
  manufacturer: string;
  manufacturerURL: string;
  trademark: string;
  designerURL: string;
  uniqueID: string;
  /**
   * RIBBI-safe nameID 1/2 pair (Font Family / Font Subfamily). Legacy
   * GDI-era apps and Mac Font Book only understand four subfamily values
   * (Regular/Bold/Italic/Bold Italic), so a non-RIBBI style like "Light" or
   * a custom family name is folded into the family string here instead —
   * exactly what desktop font managers expect for style linking to work.
   * `familyName`/`styleName` above stay the true (typographic) name and
   * drive nameID 16/17.
   */
  legacyFamilyName: string;
  legacySubfamilyName: string;
  /** OpenType style-link metadata derived from the subfamily name. */
  weightClass: number;
  fsSelection: number;
  macStyle: number;
  italicAngle: number;
}

export interface GeneratedFontFile {
  extension: "otf" | "ttf" | "woff" | "woff2";
  mimeType: "font/otf" | "font/ttf" | "font/woff" | "font/woff2";
  buffer: ArrayBuffer;
}

export interface NormalizedExportFontData {
  familyName: string;
  subfamilyName: string;
  fullName: string;
  postScriptName: string;
  version: string;
  creator: string;
  license: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  glyphs: Glyph[];
  metrics: FontMetrics;
  info: NormalizedFontMetadata;
  kerningPairs: KerningPairs;
}


const DEFAULT_UPM = 1000;
const MIN_FONT_COORD = -32760;
const MAX_FONT_COORD = 32760;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read an OpenType name record without assuming that English exists.
 * Imported fonts may expose BCP-47 language keys other than `en`.
 */
export function getFontName(record: unknown, fallback = ""): string {
  if (typeof record === "string") return record.trim() || fallback;
  if (!record || typeof record !== "object") return fallback;

  const values = record as Record<string, unknown>;
  for (const language of ["en", "en-US", "en-GB"]) {
    const value = asText(values[language]);
    if (value) return value;
  }
  for (const value of Object.values(values)) {
    const resolved = getFontName(value, "");
    if (resolved) return resolved;
  }
  return fallback;
}

/**
 * Read a name field from an opentype.js-parsed font's `names` object.
 *
 * opentype.js nests parsed name records by platform first
 * (e.g. `names.windows.fontFamily.en`), not flat as `names.fontFamily.en`.
 * Reading the flat shape against a real parsed font silently returns
 * undefined for every field, which previously caused freshly generated,
 * perfectly valid fonts to fail FontSeru's own post-export validation
 * ("family name is missing") even though the font's name table was fine.
 * This checks platforms in priority order and also accepts the flat shape
 * for forward/backward compatibility with other opentype.js versions.
 */
const NAME_PLATFORM_PRIORITY = ["windows", "unicode", "macintosh"] as const;

export function getParsedFontName(names: unknown, field: string, fallback = ""): string {
  if (!names || typeof names !== "object") return fallback;
  const byPlatform = names as Record<string, unknown>;

  for (const platform of NAME_PLATFORM_PRIORITY) {
    const platformNames = byPlatform[platform];
    if (platformNames && typeof platformNames === "object") {
      const value = getFontName((platformNames as Record<string, unknown>)[field], "");
      if (value) return value;
    }
  }

  const direct = getFontName(byPlatform[field], "");
  return direct || fallback;
}

function cleanPostScriptPart(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\s()[\]{}<>/%]+/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "");
  return cleaned || fallback;
}

export function sanitizePostScriptName(familyName: string, styleName: string, requested = ""): string {
  const requestedName = cleanPostScriptPart(requested, "");
  if (requestedName) return requestedName.slice(0, 63);
  const family = cleanPostScriptPart(familyName, "UntitledFont");
  const style = cleanPostScriptPart(styleName, "Regular");
  return `${family}-${style}`.replace(/-+/g, "-").slice(0, 63);
}

function normalizedStyleWords(styleName: string): string {
  return styleName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .toLowerCase();
}

function weightClassForStyle(styleName: string): number {
  const style = normalizedStyleWords(styleName);
  if (/\b(thin|hairline)\b/.test(style)) return 100;
  if (/\b(extra light|ultra light|extralight|ultralight)\b/.test(style)) return 200;
  if (/\blight\b/.test(style)) return 300;
  if (/\bmedium\b/.test(style)) return 500;
  if (/\b(semi bold|demi bold|semibold|demibold)\b/.test(style)) return 600;
  if (/\b(extra bold|ultra bold|extrabold|ultrabold)\b/.test(style)) return 800;
  if (/\b(black|heavy)\b/.test(style)) return 900;
  if (/\bbold\b/.test(style)) return 700;
  return 400;
}

/**
 * Resolve the metadata that desktop font managers and applications use to
 * connect Regular/Bold/Italic files as one installed family.
 *
 * This remains name-driven because FontSeru currently stores style identity
 * as a subfamily name rather than as a separate weight/slant model.
 */
export function fontStyleLinkMetadata(styleName: string): {
  weightClass: number;
  fsSelection: number;
  macStyle: number;
  italicAngle: number;
} {
  const style = normalizedStyleWords(styleName);
  const weightClass = weightClassForStyle(styleName);
  const italic = /\b(italic|oblique)\b/.test(style);
  const bold = weightClass >= 700;
  const regular = !bold && !italic && (weightClass === 400 || /\b(regular|normal|roman|book)\b/.test(style));

  // OS/2.fsSelection: bit 0 ITALIC, bit 5 BOLD, bit 6 REGULAR.
  const fsSelection = (italic ? 0x0001 : 0) | (bold ? 0x0020 : 0) | (regular ? 0x0040 : 0);
  // head.macStyle: bit 0 BOLD, bit 1 ITALIC.
  const macStyle = (bold ? 0x0001 : 0) | (italic ? 0x0002 : 0);

  return {
    weightClass,
    fsSelection,
    macStyle,
    italicAngle: italic ? -12 : 0,
  };
}

/** The only four subfamily names GDI-era Windows apps and Mac Font Book
 * can style-link within one family via nameID 1/2 + head.macStyle. */
const RIBBI_SUBFAMILIES = new Set(["regular", "bold", "italic", "bold italic"]);

/**
 * Resolve the RIBBI-safe legacy family/subfamily pair (nameID 1/2) from the
 * font's true (typographic) family/style.
 *
 * When the style is one of the four RIBBI names, nameID 1/2 can just be the
 * real family/style. Otherwise (e.g. a "Light" or "Black" custom family)
 * the style name is folded into the family string and the subfamily is
 * forced to "Regular" — the standard trick so the font still installs and
 * selects correctly as its own distinct entry in apps that predate
 * typographic (nameID 16/17) family names.
 */
export function legacyStyleLinkNames(
  familyName: string,
  styleName: string,
): { legacyFamilyName: string; legacySubfamilyName: string } {
  const normalized = normalizedStyleWords(styleName);
  if (RIBBI_SUBFAMILIES.has(normalized)) {
    const canonical = normalized
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
    return { legacyFamilyName: familyName, legacySubfamilyName: canonical };
  }
  return {
    legacyFamilyName: `${familyName} ${styleName}`.trim() || familyName,
    legacySubfamilyName: "Regular",
  };
}

/**
 * Optional grouping spec so several exported styles install and are
 * recognized as ONE family on Mac (Font Book) and Windows — even when their
 * style names are outside the four RIBBI values (e.g. "Regular Clean",
 * "Italic Rough").
 *
 * How it works:
 *  - `typographicFamily` becomes nameID 16 for EVERY member, so every modern
 *    app groups them under one family menu entry.
 *  - `typographicSubfamily` becomes nameID 17 — the distinct face label the
 *    app shows inside that one family ("Regular Clean", "Italic Rough", …).
 *  - nameID 1/2 (the legacy RIBBI pair) is still made unique-and-installable
 *    per face, but derived from the SAME typographic family so old apps at
 *    least keep them adjacent.
 *  - `faceIndex`/`faceCount` let the writer hand each face a DISTINCT
 *    usWeightClass when two faces would otherwise be OS-identical (same
 *    italic bit, same weight) — the real reason a 4-style custom family used
 *    to collide down to 2 visible faces. Only the single designated Regular
 *    face keeps the OS/2 REGULAR bit; the others clear it, so the OS never
 *    sees two "Regular"s fighting for the same slot in one family.
 */
export interface FontFamilyGrouping {
  typographicFamily: string;
  typographicSubfamily: string;
  faceIndex: number;
  faceCount: number;
  /** True for exactly one face in the family (the reference/Regular face). */
  isRegularReference: boolean;
}

export function normalizeFontMetadata(
  info: Partial<FontInfo> | null | undefined,
  fallbackFamily = "Untitled Font",
  grouping?: FontFamilyGrouping,
): NormalizedFontMetadata {
  const familyName = asText(info?.familyName) || asText(fallbackFamily) || "Untitled Font";
  const styleName = asText(info?.styleName) || "Regular";
  const fullName = asText(info?.fullName) || `${familyName} ${styleName}`;
  const version = asText(info?.version).replace(/^Version\s+/i, "") || "1.000";
  const designer = asText(info?.designer);
  const designerURL = asText(info?.designerURL);
  const manufacturer = asText(info?.manufacturer) || designer || "FontSeru";
  const manufacturerURL = asText(info?.manufacturerURL);
  const trademark = asText(info?.trademark);
  const license = asText(info?.license) || "All Rights Reserved";
  const licenseURL = asText(info?.licenseURL);
  const copyright = asText(info?.copyright) || `Copyright © ${new Date().getFullYear()} ${familyName}`;
  const description = asText(info?.description);
  // PostScript name (nameID 6) must be UNIQUE per installed face — two faces
  // sharing one PS name collide on install (the OS treats them as the same
  // font and one silently overwrites the other). When grouping a family, the
  // project's single stored postscriptName (e.g. "UntitledFont-Regular") is
  // the SAME for every style, so ignore it and always derive a unique
  // family+style PS name instead. Outside grouping, honor a requested name.
  const postscriptName = grouping
    ? sanitizePostScriptName(grouping.typographicFamily, grouping.typographicSubfamily, "")
    : sanitizePostScriptName(familyName, styleName, asText(info?.postscriptName));
  const uniqueID = asText(info?.uniqueID) && !grouping
    ? asText(info?.uniqueID)
    : `${manufacturer}:${postscriptName}:Version ${version}`;
  let styleLink = fontStyleLinkMetadata(styleName);
  let { legacyFamilyName, legacySubfamilyName } = legacyStyleLinkNames(familyName, styleName);

  // FAMILY GROUPING: force every member to share one typographic family
  // (nameID 16) and carry a distinct subfamily (nameID 17), and disambiguate
  // the OS/2 face identity so no two members collapse into the same slot.
  let typographicFamilyOverride: string | undefined;
  let typographicSubfamilyOverride: string | undefined;
  if (grouping) {
    typographicFamilyOverride = grouping.typographicFamily;
    typographicSubfamilyOverride = grouping.typographicSubfamily;
    // ONE-FAMILY GROUPING (the fix for "diinstall jadi font masing-masing"):
    // Font Book, Affinity, Adobe, Office etc. group faces primarily by the
    // legacy Family Name (nameID 1). The old code folded the distinct style
    // INTO nameID 1 ("Ajeba Regular Clean", "Ajeba Regular Rough", …) and set
    // nameID 2 to a bare "Regular"/"Italic" — so every face had a DIFFERENT
    // nameID 1 and the apps correctly showed them as separate families.
    //
    // Correct grouping: nameID 1 is the SHARED family for every face, and the
    // distinct, human-readable style goes in nameID 2 (its full label, e.g.
    // "Regular Clean"). nameID 16/17 mirror them for modern apps. This is
    // exactly how real multi-style custom families ship. A non-RIBBI nameID 2
    // is fine here: apps group by nameID 1 and simply list nameID 2 as the
    // member name. The OS/2 disambiguation below guarantees no two members
    // collide into one slot.
    legacyFamilyName = grouping.typographicFamily;
    legacySubfamilyName = grouping.typographicSubfamily;

    // Disambiguate OS/2 so Font Book / Windows never dedupe two faces that
    // would otherwise read as identical (same italic + same weight). Only
    // the designated reference face keeps the REGULAR bit; every other face
    // gets a unique synthetic usWeightClass so the OS treats them as
    // separate members of the one family rather than duplicates. Weights are
    // spread within 400–600 only, so a plain custom style never accidentally
    // trips the BOLD style-link bit (>=700) unless its own name says "bold".
    const italic = /\b(italic|oblique)\b/.test(normalizedStyleWords(grouping.typographicSubfamily));
    const baseItalic = italic;
    const nameSaysBold = /\b(bold|black|heavy|extra bold|ultra bold|semibold|demibold)\b/.test(
      normalizedStyleWords(grouping.typographicSubfamily),
    );
    const italicBit = baseItalic ? 0x0001 : 0;
    // Non-reference faces get distinct weights 450,500,550,600,650 (all < 700
    // so no accidental bold), unless the name itself is a bold weight.
    const spread = [450, 500, 550, 600, 650];
    const synthWeight = nameSaysBold
      ? weightClassForStyle(grouping.typographicSubfamily)
      : grouping.isRegularReference
        ? 400
        : spread[Math.min(spread.length - 1, Math.max(0, grouping.faceIndex - 1))];
    const boldBit = synthWeight >= 700 ? 0x0020 : 0;
    const regularBit = grouping.isRegularReference && !baseItalic ? 0x0040 : 0;
    styleLink = {
      weightClass: synthWeight,
      fsSelection: italicBit | boldBit | regularBit || (baseItalic ? 0x0001 : 0),
      macStyle: (boldBit ? 0x0001 : 0) | (baseItalic ? 0x0002 : 0),
      italicAngle: baseItalic ? -12 : 0,
    };
  }

  return {
    familyName: typographicFamilyOverride ?? familyName,
    styleName: typographicSubfamilyOverride ?? styleName,
    fullName,
    postscriptName,
    designer,
    designerURL,
    copyright,
    version,
    description,
    license,
    licenseURL,
    manufacturer,
    manufacturerURL,
    trademark,
    uniqueID,
    legacyFamilyName,
    legacySubfamilyName,
    ...styleLink,
  };
}


/**
 * Build the name-record object opentype.js's `name.make()` encoder expects.
 *
 * opentype.js's encoder indexes its input by platform first, then by field,
 * then by language (e.g. `{ windows: { fontFamily: { en: "X" } } }`) — the
 * mirror image of the flat `{ fontFamily: { en: "X" } }` shape one might
 * reasonably expect. Passing the flat shape doesn't just drop names
 * silently: the encoder's platform lookup fails for every field and it
 * throws ('Name table entry "en" does not exist...'), so OTF export never
 * produced a file at all before this fix.
 */
export interface NameTablePreviewRecord {
  id: number;
  label: string;
  value: string;
}

const NAME_TABLE_ID_LABELS: Record<number, string> = {
  0: "Copyright",
  1: "Font Family",
  2: "Font Subfamily",
  3: "Unique Identifier",
  4: "Full Font Name",
  5: "Version",
  6: "PostScript Name",
  7: "Trademark",
  8: "Manufacturer",
  9: "Designer",
  10: "Description",
  11: "Vendor URL",
  12: "Designer URL",
  13: "License Description",
  14: "License URL",
  16: "Typographic Family",
  17: "Typographic Subfamily",
};

/**
 * The exact OpenType `name` table records FontSeru will write for this
 * metadata — same nameIDs, same inclusion/omission rules, same values as
 * `toOpenTypeNames` (OTF/WOFF/WOFF2, below) and `trueTypeWriter.ts`'s
 * `buildName` (TTF) both apply on export. Exposed so the Export dialog can
 * show the user exactly what's about to be baked into the font, before a
 * single file is generated — keep this list in sync with those two if the
 * set of written nameIDs ever changes.
 */
export function previewNameTableRecords(info: NormalizedFontMetadata): NameTablePreviewRecord[] {
  const entries: Array<[number, string]> = [
    [0, info.copyright],
    [1, info.legacyFamilyName],
    [2, info.legacySubfamilyName],
    [3, info.uniqueID],
    [4, info.fullName],
    [5, `Version ${info.version}`],
    [6, info.postscriptName],
    [8, info.manufacturer],
    [9, info.designer || "FontSeru"],
    [13, info.license],
  ];
  if (info.trademark) entries.push([7, info.trademark]);
  if (info.description) entries.push([10, info.description]);
  if (info.manufacturerURL) entries.push([11, info.manufacturerURL]);
  if (info.designerURL) entries.push([12, info.designerURL]);
  if (info.licenseURL) entries.push([14, info.licenseURL]);
  const typographicNamesDiffer =
    info.legacyFamilyName !== info.familyName || info.legacySubfamilyName !== info.styleName;
  if (typographicNamesDiffer) {
    entries.push([16, info.familyName], [17, info.styleName]);
  }

  return entries
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([id, value]) => ({ id, label: NAME_TABLE_ID_LABELS[id] ?? `nameID ${id}`, value }));
}

function toOpenTypeNames(info: NormalizedFontMetadata): Record<string, Record<string, string>> {
  // opentype.js expects a FLAT map of { nameKey: { lang: text } } and emits
  // BOTH the Macintosh (1,0,0) and Windows (3,1,0x409) platform records for
  // every entry itself (see tables/name.js makeNameTable). The previous
  // shape nested everything under { windows, macintosh }, which this build
  // of opentype.js does NOT understand: it read `font.names.fontFamily` as
  // undefined and then crashed on `englishFamilyName.replace(...)` while
  // serializing the CFF/sfnt — the "export sering error" bug. Returning the
  // flat shape fixes the crash and still produces the dual-platform name
  // records automatically.
  //
  // nameID 1/2 (Font Family / Subfamily): RIBBI-safe legacy strings, so
  // GDI-era apps and Mac Font Book still install/select non-RIBBI custom
  // families correctly. nameID 16/17 (Preferred/Typographic Family /
  // Subfamily): the font's true family/style, written only when they differ.
  const fields: Record<string, Record<string, string>> = {
    fontFamily: localized(info.legacyFamilyName),
    fontSubfamily: localized(info.legacySubfamilyName),
    uniqueID: localized(info.uniqueID),
    fullName: localized(info.fullName),
    version: localized(`Version ${info.version}`),
    postScriptName: localized(info.postscriptName),
    manufacturer: localized(info.manufacturer),
    designer: localized(info.designer || "FontSeru"),
    license: localized(info.license),
    copyright: localized(info.copyright),
  };
  const typographicNamesDiffer =
    info.legacyFamilyName !== info.familyName || info.legacySubfamilyName !== info.styleName;
  if (typographicNamesDiffer) {
    fields.preferredFamily = localized(info.familyName);
    fields.preferredSubfamily = localized(info.styleName);
  }
  if (info.description) fields.description = localized(info.description);
  if (info.licenseURL) fields.licenseURL = localized(info.licenseURL);
  if (info.manufacturerURL) fields.manufacturerURL = localized(info.manufacturerURL);
  if (info.trademark) fields.trademark = localized(info.trademark);
  if (info.designerURL) fields.designerURL = localized(info.designerURL);

  return fields;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeMetric(value: unknown, fallback: number): number {
  const n = finiteNumber(value);
  return n == null ? fallback : Math.round(n);
}

/**
 * Font-level metrics are never allowed to block export. Values outside the
 * supported OpenType/TrueType range fall back to a conservative 1000 UPM
 * coordinate system while preserving valid project values whenever possible.
 */
export function normalizeFontMetrics(metrics: Partial<FontMetrics> | null | undefined): FontMetrics {
  const rawUpm = safeMetric(metrics?.unitsPerEm, DEFAULT_UPM);
  const unitsPerEm = rawUpm >= 16 && rawUpm <= 16384 ? rawUpm : DEFAULT_UPM;
  const ascFallback = Math.round(unitsPerEm * 0.8);
  const descFallback = -Math.round(unitsPerEm * 0.2);

  const rawAscender = safeMetric(metrics?.ascender, ascFallback);
  const rawDescender = safeMetric(metrics?.descender, descFallback);
  const ascender = Math.min(MAX_FONT_COORD, rawAscender > 0 ? rawAscender : ascFallback);
  const descender = Math.max(MIN_FONT_COORD, rawDescender <= 0 ? rawDescender : descFallback);
  const capHeightRaw = safeMetric(metrics?.capHeight, Math.round(ascender * 0.875));
  const xHeightRaw = safeMetric(metrics?.xHeight, Math.round(ascender * 0.625));

  return {
    unitsPerEm,
    ascender,
    baseline: 0,
    descender,
    capHeight: Math.max(0, Math.min(ascender, capHeightRaw)),
    xHeight: Math.max(0, Math.min(ascender, xHeightRaw)),
  };
}

function isUnicodeScalar(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= 0x10ffff
    && !(value >= 0xd800 && value <= 0xdfff);
}

function clampFontCoord(value: number): number {
  return Math.max(MIN_FONT_COORD, Math.min(MAX_FONT_COORD, Math.round(value)));
}

function safePoint(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object") return null;
  const point = value as { x?: unknown; y?: unknown };
  const x = finiteNumber(point.x);
  const y = finiteNumber(point.y);
  if (x == null || y == null) return null;
  return { x: clampFontCoord(x), y: clampFontCoord(y) };
}

function samePoint(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}


function cubicPointAt(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * Flatten just enough for containment/orientation tests. The actual exported
 * outline remains the original Bézier geometry; these samples are never
 * written into the font.
 */
function flattenContourForExport(contour: Contour, curveSteps = 16): { x: number; y: number }[] {
  const nodes = contour.nodes ?? [];
  if (!nodes.length) return [];

  const points: { x: number; y: number }[] = [{ ...nodes[0].point }];
  const segmentCount = contour.closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < segmentCount; i++) {
    const from = nodes[i];
    const to = nodes[(i + 1) % nodes.length];
    if (from.handleOut || to.handleIn) {
      const c1 = from.handleOut ?? from.point;
      const c2 = to.handleIn ?? to.point;
      for (let step = 1; step <= curveSteps; step++) {
        points.push(cubicPointAt(from.point, c1, c2, to.point, step / curveSteps));
      }
    } else {
      points.push({ ...to.point });
    }
  }
  return points;
}

function polygonSignedArea(points: { x: number; y: number }[]): number {
  if (points.length < 3) return 0;
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return twiceArea / 2;
}

/**
 * Reverse a contour without changing its curve. When traversal reverses,
 * incoming/outgoing Bézier handles swap roles at every node.
 */
function reverseContourForExport(contour: Contour): Contour {
  return {
    ...contour,
    nodes: [...contour.nodes].reverse().map((node) => ({
      ...node,
      point: { ...node.point },
      handleIn: node.handleOut ? { ...node.handleOut } : null,
      handleOut: node.handleIn ? { ...node.handleIn } : null,
    })),
  };
}

/**
 * Normalize winding PER VECTOR OBJECT before all contours are flattened into
 * a single sfnt glyph.
 *
 * FontSeru deliberately renders separate objects as separate SVG paths. That
 * means two independent filled shapes may overlap without subtracting from
 * each other. In an exported font, however, every contour lives in one glyph
 * outline and a rasterizer applies winding to the combined set. If independent
 * outer contours happen to have opposite directions, their overlap can cancel
 * and become an accidental hole.
 *
 * Test Lab's own preview never re-derives which contour is a "hole" — see
 * pathBuilder.ts's `objectFillPath`: it concatenates an object's contours
 * with whatever winding they already carry and lets the browser's `nonzero`
 * fill rule resolve them. That authored/generated relative winding is the
 * single source of truth for how an object is meant to look. This used to
 * be re-derived here from scratch per contour, via bounding-box containment
 * + a point-in-polygon nesting-depth count — which assumes real holes are
 * always strictly nested inside their container. Rough/Grunge/Oil Brush
 * textures break that assumption on purpose: `makeRoughHole`/`makeSpeckle`
 * in strokeToOutline.ts scatter many small counter-holes across a stroke's
 * body that are siblings, not nested inside one another, and by construction
 * are simply wound opposite the main contour. When two of those sibling
 * holes happened to have one's bounding box sit inside another's, the old
 * per-contour heuristic misread that as nesting and flipped the wrong one —
 * turning a punched-out divot into an extra solid fleck of ink the live
 * preview never showed.
 *
 * The only thing export is actually responsible for here is satisfying the
 * sfnt format's OUTER-direction convention (TrueType outer clockwise; CFF/OTF
 * outer counter-clockwise — the `outerClockwise` param). So: find the truly
 * outer, ink-adding contour (the one with the largest absolute area — holes
 * are, by construction, smaller than the body they're cut from) and check
 * whether IT already matches the target convention. If not, reverse every
 * contour in the object together, as one rigid flip, which preserves each
 * contour's winding *relative to the others* exactly as authored/generated —
 * matching Test Lab's preview bit-for-bit — rather than recomputing any of
 * them independently.
 *
 * We intentionally do not infer holes across different VectorObjects. A shape
 * placed inside or across another object is still independent ink in the editor
 * and must stay independent ink after export.
 */
function normalizeObjectContourDirections(contours: Contour[], outerClockwise = true): Contour[] {
  if (!contours.length) return contours;

  let outerArea = 0;
  let outerAbsArea = -1;
  for (const contour of contours) {
    const polygon = flattenContourForExport(contour);
    if (polygon.length < 3) continue;
    const area = polygonSignedArea(polygon);
    const absArea = Math.abs(area);
    if (absArea > outerAbsArea) {
      outerAbsArea = absArea;
      outerArea = area;
    }
  }

  // Degenerate (zero-area) object — nothing meaningful to orient.
  if (outerAbsArea <= 1e-6) return contours;

  const outerIsClockwise = outerArea < 0;
  if (outerIsClockwise === outerClockwise) return contours;

  return contours.map((contour) => reverseContourForExport(contour));
}

function sanitizeContour(contour: Contour): Contour | null {
  const nodes: PathNode[] = [];
  for (const node of contour.nodes ?? []) {
    const point = safePoint(node?.point);
    if (!point) continue;
    const handleIn = safePoint(node?.handleIn);
    const handleOut = safePoint(node?.handleOut);
    if (nodes.length && samePoint(nodes[nodes.length - 1].point, point) && !handleIn && !handleOut) continue;
    nodes.push({
      id: node?.id || shortId("node"),
      point,
      handleIn,
      handleOut,
      type: node?.type === "smooth" || node?.type === "symmetric" ? node.type : "corner",
    });
  }

  if (nodes.length > 1 && samePoint(nodes[0].point, nodes[nodes.length - 1].point)) {
    nodes.pop();
  }
  if (nodes.length < 2) return null;

  return {
    id: contour.id || shortId("contour"),
    nodes,
    // sfnt outlines are filled contours. Closing here keeps a recoverable
    // editor-side open contour from producing a malformed font outline.
    closed: true,
  };
}

function exportableObjects(glyph: Glyph): VectorObject[] {
  const objects = glyph.outline?.objects ?? [];

  // Step 1: turn every object into its filled representation. Shape/
  // expanded objects are already filled outlines; line/brush strokes are
  // centerline + width and need expanding into their filled silhouette
  // first before they can take part in any boolean/union math below.
  const expanded: VectorObject[] = [];
  for (const obj of objects) {
    try {
      if (obj.kind === "shape" || obj.kind === "expanded") {
        expanded.push(obj);
      } else {
        const exp = expandStrokeObject(obj);
        if (exp) expanded.push(exp);
      }
    } catch (error) {
      console.warn(`[FontSeru] Skipping malformed stroke object in U+${glyph.unicode.toString(16).toUpperCase()}.`, error);
    }
  }

  // Step 2: Remove Overlap. The editor draws each object as its OWN
  // independent <path>, painted opaquely on top of the others (see
  // VectorObject's doc comment in types/geometry.ts) — so two overlapping
  // objects simply paint over each other on screen and never interact,
  // and each object's own holes/counters only ever cut into that same
  // object.
  //
  // An exported font glyph, however, is a SINGLE combined outline: every
  // contour from every object is concatenated into one opentype.js path,
  // and rasterizers resolve that whole path's fill with one nonzero
  // winding count across ALL of it at once. That means a contour that's a
  // hole in one object (e.g. the counter of an "o") can accidentally
  // subtract from a completely different object sitting underneath it
  // wherever the two happen to overlap — punching a bite/hole into the
  // exported glyph that was never visible in the editor. The same kind of
  // mismatch can happen the other way too: two solid objects overlapping
  // with opposite winding can cancel out where they cross.
  //
  // Unioning every eligible filled object together first — exactly what a
  // manual "Remove Overlap"/boolean-union pass does in a normal font
  // editor — resolves the whole glyph into the same flattened, opaque
  // silhouette already shown in the editor, so the exported OTF/TTF
  // matches what was drawn regardless of how many separate objects, or
  // what z-order/winding, it was built from. Objects that don't actually
  // touch union into unaffected, separate disjoint contours, so this is
  // safe to run unconditionally on every glyph, not just ones a designer
  // remembered to flatten by hand.
  const eligible = expanded.filter(isBooleanEligible);
  const ineligible = expanded.filter((o) => !isBooleanEligible(o));

  if (eligible.length >= 2) {
    try {
      // Hole-aware union (preserves each object's own counters — e.g. a
      // slashed "0" built from an oval ring + a diagonal slash keeps its two
      // counters instead of filling solid). Falls back to the plain union if
      // the hole-aware pass returns nothing.
      const holeAware = unionObjectsHoleAware(eligible, EXPORT_CURVE_FIDELITY_SCALE);
      if (holeAware.length > 0) {
        return [{ id: shortId("obj"), kind: "shape", contours: holeAware }, ...ineligible];
      }
      const merged = applyBooleanOp(eligible, "union", EXPORT_CURVE_FIDELITY_SCALE);
      if (merged) return [merged, ...ineligible];
    } catch (error) {
      console.warn(
        `[FontSeru] Remove Overlap failed for U+${glyph.unicode.toString(16).toUpperCase()}; exporting objects unmerged.`,
        error
      );
    }
  } else if (eligible.length === 1) {
    // BUG FIX: a glyph built from a single filled object (the common case —
    // one hand-drawn letterform, or a digit whose outer+counter live in one
    // shape's own contours) used to skip Remove Overlap entirely, since the
    // union pass above only ever ran for 2+ objects. That meant a single
    // self-crossing contour, or a hole wound the wrong way, was never run
    // through the exact clipper's self-intersection resolution — it went
    // straight to the font writer raw. The browser's anti-aliased SVG
    // preview forgives that kind of near-degenerate geometry and still
    // looks clean; an OS font rasterizer computing an exact winding number
    // per scanline does not, and shows it as scattered "pitting"/dropouts —
    // exactly the corruption Test Lab never showed. Routing the lone
    // object's own contours through the same self-intersection normalizer
    // `applyBooleanOp` already applies internally to each input object
    // closes that gap, so single- and multi-object glyphs get the same
    // guarantee instead of only the multi-object ones.
    try {
      const obj = eligible[0];
      const cleaned = normalizeSelfIntersectingContours(obj.contours, EXPORT_CURVE_FIDELITY_SCALE);
      if (cleaned.length > 0) {
        return [{ id: obj.id, kind: "shape", contours: cleaned }, ...ineligible];
      }
    } catch (error) {
      console.warn(
        `[FontSeru] Remove Overlap (single-object) failed for U+${glyph.unicode.toString(16).toUpperCase()}; exporting object unmerged.`,
        error
      );
    }
  }

  return expanded;
}

function sanitizeGlyph(glyph: Glyph, metrics: FontMetrics): Glyph | null {
  if (!isUnicodeScalar(glyph.unicode)) return null;
  const fallbackAdvance = Math.max(1, Math.round(metrics.unitsPerEm * 0.6));
  const rawAdvance = finiteNumber(glyph.advanceWidth);
  // The real space glyph (see ensureSpaceGlyph in glyph/defaultGlyphs.ts,
  // now always present) still defers to metrics.wordSpacing when the user
  // has set it explicitly via the Word Spacing control — same rule
  // syntheticSpace below used to apply back when a space glyph could be
  // missing — so export always matches what was shown in the live preview
  // and Kerning Lab, not whatever static width the glyph object happens
  // to carry.
  const wordSpacingOverride = glyph.unicode === 0x20 ? metrics.wordSpacing : undefined;
  const advanceWidth =
    wordSpacingOverride != null
      ? Math.max(1, Math.round(wordSpacingOverride))
      : Math.max(1, Math.min(65535, Math.round(rawAdvance != null && rawAdvance > 0 ? rawAdvance : fallbackAdvance)));
  const objects: VectorObject[] = [];

  for (const obj of exportableObjects(glyph)) {
    const sanitizedContours = (obj.contours ?? [])
      .map(sanitizeContour)
      .filter((contour): contour is Contour => contour != null);
    if (!sanitizedContours.length) continue;

    const contours = normalizeObjectContourDirections(sanitizedContours);
    objects.push({
      ...obj,
      id: obj.id || shortId("obj"),
      kind: obj.kind === "expanded" ? "expanded" : "shape",
      contours,
    });
  }

  const unicodes = [...new Set([glyph.unicode, ...(glyph.unicodes ?? [])].filter(isUnicodeScalar))];
  return {
    ...glyph,
    unicode: glyph.unicode,
    unicodes,
    advanceWidth,
    lsb: Number.isFinite(glyph.lsb) ? Math.round(glyph.lsb) : 0,
    rsb: Number.isFinite(glyph.rsb) ? Math.round(glyph.rsb) : 0,
    outline: { objects },
    components: [],
  };
}

function syntheticSpace(metrics: FontMetrics): Glyph {
  // metrics.wordSpacing, when the user has set it explicitly via the Word
  // Spacing control, wins here so the exported font's space glyph matches
  // what they saw in the live preview. Left unset, this keeps the original
  // 0.5 * unitsPerEm default so existing projects export unchanged.
  const advanceWidth = metrics.wordSpacing ?? metrics.unitsPerEm * 0.5;
  return {
    char: " ",
    unicode: 0x20,
    unicodes: [0x20],
    name: "space",
    category: "symbols",
    advanceWidth: Math.max(1, Math.round(advanceWidth)),
    lsb: 0,
    rsb: 0,
    outline: { objects: [] },
    components: [],
  };
}

function prepareGlyphs(glyphs: GlyphMap, metrics: FontMetrics): Glyph[] {
  const byUnicode = new Map<number, Glyph>();
  for (const glyph of Object.values(glyphs ?? {})) {
    const clean = sanitizeGlyph(glyph, metrics);
    if (!clean || byUnicode.has(clean.unicode)) continue;
    byUnicode.set(clean.unicode, clean);
  }

  // A usable font should always have a space even if the editor's current
  // navigation set does not expose one.
  if (!byUnicode.has(0x20)) byUnicode.set(0x20, syntheticSpace(metrics));

  return [...byUnicode.values()].sort((a, b) => a.unicode - b.unicode);
}

export function normalizeExportFontData(input: {
  glyphs: GlyphMap;
  metrics: Partial<FontMetrics> | null | undefined;
  info: Partial<FontInfo> | null | undefined;
  fontName?: string;
  kerningPairs?: KerningPairs;
  grouping?: FontFamilyGrouping;
}): NormalizedExportFontData {
  const metrics = normalizeFontMetrics(input.metrics);
  const info = normalizeFontMetadata(input.info, input.fontName || input.info?.familyName || "Untitled Font", input.grouping);
  const glyphs = prepareGlyphs(input.glyphs, metrics);
  return {
    familyName: info.familyName,
    subfamilyName: info.styleName,
    fullName: info.fullName,
    postScriptName: info.postscriptName,
    version: info.version,
    creator: info.designer || "FontSeru",
    license: info.license,
    unitsPerEm: metrics.unitsPerEm,
    ascender: metrics.ascender,
    descender: metrics.descender,
    glyphs,
    metrics,
    info,
    kerningPairs: input.kerningPairs ?? {},
  };
}

function appendContour(path: opentype.Path, contour: Contour): void {
  if (contour.nodes.length < 2) return;
  const first = contour.nodes[0];
  path.moveTo(first.point.x, first.point.y);
  const segmentCount = contour.closed ? contour.nodes.length : contour.nodes.length - 1;
  for (let i = 0; i < segmentCount; i++) {
    const from = contour.nodes[i];
    const to = contour.nodes[(i + 1) % contour.nodes.length];
    if (from.handleOut || to.handleIn) {
      const c1 = from.handleOut ?? from.point;
      const c2 = to.handleIn ?? to.point;
      path.curveTo(c1.x, c1.y, c2.x, c2.y, to.point.x, to.point.y);
    } else {
      path.lineTo(to.point.x, to.point.y);
    }
  }
  if (contour.closed) path.close();
}

function glyphName(glyph: Glyph): string {
  const fallback = `uni${glyph.unicode.toString(16).toUpperCase().padStart(4, "0")}`;
  const raw = asText(glyph.name).normalize("NFKD").replace(/[^\x20-\x7E]/g, "");
  const clean = raw.replace(/[^A-Za-z0-9_.-]+/g, "");
  return clean || (glyph.unicode === 0x20 ? "space" : fallback);
}


/**
 * Build the glyph model used by the CFF writer. We re-run direction
 * normalization per VectorObject with the PostScript/CFF convention instead
 * of merely trusting whatever direction the editor stored.
 *
 * This is deliberately format-specific:
 *   TrueType: outer clockwise, counter counter-clockwise.
 *   CFF/OTF:  outer counter-clockwise, counter clockwise.
 *
 * Keeping the operation per object preserves FontSeru's visual rule that
 * independently drawn shapes remain additive even when they overlap.
 */
function glyphForOpenTypeCFF(glyph: Glyph): Glyph {
  return {
    ...glyph,
    outline: {
      objects: glyph.outline.objects.map((obj) => ({
        ...obj,
        contours: normalizeObjectContourDirections(obj.contours, false),
      })),
    },
  };
}

function glyphToOpenType(glyph: Glyph, index: number): opentype.Glyph {
  const path = new opentype.Path();
  for (const obj of glyph.outline.objects) {
    for (const contour of obj.contours) appendContour(path, contour);
  }

  const result = new opentype.Glyph({
    name: glyphName(glyph),
    unicode: glyph.unicode,
    advanceWidth: glyph.advanceWidth,
    path,
  });
  for (const cp of glyph.unicodes ?? []) {
    if (cp !== glyph.unicode && typeof (result as any).addUnicode === "function") (result as any).addUnicode(cp);
  }
  (result as any).index = index;
  return result;
}

function notdefGlyph(metrics: FontMetrics): opentype.Glyph {
  return new opentype.Glyph({
    name: ".notdef",
    advanceWidth: Math.max(1, Math.round(metrics.unitsPerEm * 0.5)),
    path: new opentype.Path(),
  });
}

function localized(value: string): Record<string, string> {
  return { en: value || " " };
}

function setNames(font: opentype.Font, info: NormalizedFontMetadata): void {
  // Replace, rather than mutate, the table. This guarantees that a malformed
  // imported/project name object cannot leak into the generated OTF. The
  // value is the FLAT { nameKey: { lang } } shape opentype.js reads directly
  // (see toOpenTypeNames) — the previously-nested shape crashed export.
  (font as any).names = toOpenTypeNames(info);
}

function buildOpenTypeFont(
  glyphs: Glyph[],
  metrics: FontMetrics,
  info: NormalizedFontMetadata,
): { font: opentype.Font; glyphIndexByChar: Map<string, number> } {
  const otGlyphs: opentype.Glyph[] = [notdefGlyph(metrics)];
  const index = new Map<string, number>();
  glyphs.forEach((glyph, i) => {
    const gid = i + 1;
    otGlyphs.push(glyphToOpenType(glyph, gid));
    index.set(glyph.char, gid);
  });

  const font = new opentype.Font({
    familyName: info.familyName,
    styleName: info.styleName,
    fullName: info.fullName,
    postScriptName: info.postscriptName,
    designer: info.designer || "FontSeru",
    manufacturer: info.manufacturer,
    license: info.license,
    licenseURL: info.licenseURL,
    version: `Version ${info.version}`,
    description: info.description,
    copyright: info.copyright,
    unitsPerEm: metrics.unitsPerEm,
    ascender: metrics.ascender,
    descender: metrics.descender,
    glyphs: otGlyphs,
  } as any);
  setNames(font, info);

  const tables = ((font as any).tables ||= {});
  const os2 = tables.os2 ||= {};
  os2.sCapHeight = metrics.capHeight;
  os2.sxHeight = metrics.xHeight;
  os2.sTypoAscender = metrics.ascender;
  os2.sTypoDescender = metrics.descender;
  os2.usWinAscent = Math.max(0, metrics.ascender);
  os2.usWinDescent = Math.max(0, -metrics.descender);
  os2.usWeightClass = info.weightClass;
  os2.fsSelection = info.fsSelection;

  const head = tables.head ||= {};
  head.macStyle = info.macStyle;

  const post = tables.post ||= {};
  post.italicAngle = info.italicAngle;

  return { font, glyphIndexByChar: index };
}

function u16(view: DataView, off: number): number { return view.getUint16(off, false); }
function u32(view: DataView, off: number): number { return view.getUint32(off, false); }
function writeTag(view: DataView, off: number, tag: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(off + i, tag.charCodeAt(i) || 0x20);
}
function tagAt(view: DataView, off: number): string {
  return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
}
function checksum(bytes: Uint8Array): number {
  let sum = 0 >>> 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const a = bytes[i] ?? 0, b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0, d = bytes[i + 3] ?? 0;
    sum = (sum + (((a << 24) | (b << 16) | (c << 8) | d) >>> 0)) >>> 0;
  }
  return sum >>> 0;
}
function align4(n: number): number { return (n + 3) & ~3; }

function findSfntTable(buffer: ArrayBuffer, tag: string): { offset: number; length: number } | null {
  const view = new DataView(buffer);
  const numTables = u16(view, 4);
  for (let i = 0; i < numTables; i++) {
    const d = 12 + i * 16;
    if (tagAt(view, d) !== tag) continue;
    return { offset: u32(view, d + 8), length: u32(view, d + 12) };
  }
  return null;
}

/**
 * BUG FIX (OTF/CFF loses Bold/Italic family linking; post.italicAngle
 * always 0): opentype.js@1.3.4's internal sfnt assembler builds the `head`
 * table via `head.make({...})` with a hand-picked options object that never
 * spreads `font.tables.head`, and builds `post` via a bare `post.make()`
 * call with no options at all. That silently drops whatever this file
 * assigns to `tables.head.macStyle` / `tables.post.italicAngle` right
 * before `font.toArrayBuffer()` — the OS/2 table happens to merge
 * `font.tables.os2` correctly, which is why `fsSelection` DOES make it into
 * the file while `macStyle` never does. Desktop font managers (and
 * Affinity) rely on head.macStyle together with nameID 1/2 to link
 * Regular/Bold/Italic files into one installed family; without it, an
 * Italic OTF has no way to announce it's the italic member of its family
 * and registers as an unrelated font instead of style-linking with
 * Regular — exactly the "TTF installs as one family, OTF doesn't" gap.
 * TrueType is unaffected because `generateTTFBase` uses FontSeru's own
 * `buildTrueTypeFont` writer (trueTypeWriter.ts), not opentype.js, and
 * writes macStyle itself.
 *
 * Fixed here by patching the already-serialized OTF buffer's `head.macStyle`
 * and `post.italicAngle` fields directly, reusing the same
 * splice-and-recompute-checksums path (`spliceSfntTable`) already used for
 * GSUB/GPOS — patch, don't touch the library's own (broken) table builder.
 */
function patchOtfHeadAndPost(buffer: ArrayBuffer, macStyle: number, italicAngle: number): ArrayBuffer {
  let result = buffer;

  const head = findSfntTable(result, "head");
  if (head && head.length >= 46) {
    const headBytes = new Uint8Array(result, head.offset, head.length).slice();
    new DataView(headBytes.buffer).setUint16(44, macStyle & 0xffff, false);
    result = spliceSfntTable(result, "head", headBytes);
  }

  const post = findSfntTable(result, "post");
  if (post && post.length >= 8) {
    const postBytes = new Uint8Array(result, post.offset, post.length).slice();
    // post.italicAngle is a Fixed (16.16) value, matching opentype.js's own
    // Fixed encoding elsewhere in this file.
    const fixedAngle = Math.round(italicAngle * 65536);
    new DataView(postBytes.buffer).setInt32(4, fixedAngle, false);
    result = spliceSfntTable(result, "post", postBytes);
  }

  return result;
}

/** Shared sfnt table-directory splicing logic: replace-or-add one table by
 * tag, rebuild the directory (sorted by tag, as required), and recompute
 * the `head` table's checksum adjustment. Used by the `GSUB`/`GPOS`
 * injectors below; `injectKernTable`'s legacy `kern` splice predates this
 * and is left as its own inline copy rather than risk touching it. */
function spliceSfntTable(buffer: ArrayBuffer, tag: string, data: Uint8Array): ArrayBuffer {
  const input = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const numTables = u16(view, 4);
  const tables: { tag: string; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const d = 12 + i * 16;
    const existingTag = tagAt(view, d);
    if (existingTag === tag) continue;
    const offset = u32(view, d + 8), length = u32(view, d + 12);
    if (offset + length > input.length) throw new Error("Generated font has a malformed sfnt table directory.");
    const existingData = input.slice(offset, offset + length);
    if (existingTag === "head" && existingData.length >= 12) existingData.fill(0, 8, 12);
    tables.push({ tag: existingTag, data: existingData });
  }
  tables.push({ tag, data });
  tables.sort((a, b) => a.tag.localeCompare(b.tag));

  const count = tables.length;
  const maxPow2 = 2 ** Math.floor(Math.log2(count));
  const searchRange = maxPow2 * 16;
  const entrySelector = Math.floor(Math.log2(maxPow2));
  const rangeShift = count * 16 - searchRange;
  let cursor = 12 + count * 16;
  const total = cursor + tables.reduce((n, t) => n + align4(t.data.length), 0);
  const output = new Uint8Array(total);
  const ov = new DataView(output.buffer);
  for (let i = 0; i < 4; i++) output[i] = input[i];
  ov.setUint16(4, count, false); ov.setUint16(6, searchRange, false);
  ov.setUint16(8, entrySelector, false); ov.setUint16(10, rangeShift, false);

  let headOffset = -1;
  tables.forEach((table, i) => {
    const d = 12 + i * 16;
    writeTag(ov, d, table.tag);
    ov.setUint32(d + 4, checksum(table.data), false);
    ov.setUint32(d + 8, cursor, false);
    ov.setUint32(d + 12, table.data.length, false);
    output.set(table.data, cursor);
    if (table.tag === "head") headOffset = cursor;
    cursor += align4(table.data.length);
  });

  if (headOffset >= 0) {
    const sum = checksum(output);
    ov.setUint32(headOffset + 8, (0xB1B0AFBA - sum) >>> 0, false);
  }
  return output.buffer;
}

/**
 * Classic `kern` (format-0) and GPOS PairPos-format-1 tables are both
 * built from "Common Table Format" structures whose internal offsets are
 * ALL Offset16 (unsigned 16-bit, max 65535) — the PairPos coverage/
 * pairSet offsets, the classic kern subtable's own `length`/`nPairs`
 * fields, even the LookupList's offsets to each Lookup. This is a hard
 * ceiling baked into the OpenType 1.0 spec, not a bug we can configure
 * around: once the encoded bytes for a *single* subtable's pair data
 * cross ~64KB, any offset that would need to point past it silently
 * wraps back into range instead of throwing — so the *file* looks fine
 * (no exception, no console error) but the actual pair data past the
 * wraparound point is scrambled garbage from that offset onward. Real
 * engines (Windows, Affinity, most browsers) either bail out on the
 * malformed lookup (falling back to plain, un-kerned advance widths) or
 * read whatever garbage the wrapped offset happens to point at — both of
 * which look like "kerning got randomly worse after export" despite Test
 * Lab (which reads the live `kerningPairs` object directly, never this
 * binary) looking correct.
 *
 * FontSeru's "Auto Kerning" can legitimately produce a near-complete
 * matrix (essentially every left/right glyph combination in the font),
 * which for a ~370-glyph family is well over 100,000 pairs — 8-10x more
 * raw pair data than a single PairPos/kern subtable can ever address.
 * The old code treated that ceiling as a hard cap on the *whole export*
 * and silently dropped the smallest-magnitude pairs to fit one subtable.
 * That's the wrong fix: the 64KB limit only ever applies to one subtable's
 * own internal offsets, not to how much kerning data a font can carry in
 * total. `chunkKerningRecords` below splits the full, un-truncated pair
 * list into as many subtable-sized chunks as it takes (grouped by left
 * glyph, so a glyph's whole pair set always lives in exactly one chunk —
 * see buildLookup's docstring for why splitting a left glyph across
 * subtables would silently strand its later pairs). Nothing is ever
 * dropped; large fonts just get more chunks.
 *
 * For GPOS, those chunks are wrapped in Extension Positioning
 * (lookupType 9) subtables — see `buildExtensionPosLookup` — which is the
 * spec-defined, real-compiler way to reference subtable data of any size
 * without the referencing structure itself (the Lookup/LookupList) ever
 * exceeding 64KB. For the legacy `kern` table, each chunk becomes its own
 * self-contained format-0 subtable; the classic `kern` header already
 * natively supports any number of subtables via its own `nTables` count,
 * so no extension trick is needed there.
 */

/** Parses, validates, and clamps every stored kerning pair into sorted-glyph
 * records ready for layout. No budgeting or dropping happens here — every
 * valid pair the user configured comes back out. */
function resolveKerningRecords(
  pairs: KerningPairs,
  glyphIndexByChar: Map<string, number>
): { left: number; right: number; value: number }[] {
  const all: { left: number; right: number; value: number }[] = [];
  for (const [key, rawValue] of Object.entries(pairs ?? {})) {
    const pair = parseKerningKey(key);
    if (!pair) continue;
    const left = glyphIndexByChar.get(pair.left);
    const right = glyphIndexByChar.get(pair.right);
    if (left == null || right == null || !Number.isFinite(rawValue)) continue;
    const value = Math.max(-32768, Math.min(32767, Math.round(rawValue)));
    if (value) all.push({ left, right, value });
  }
  return all;
}

/**
 * Groups kerning records by left glyph and packs whole left-groups into
 * as many chunks as needed to keep each chunk's encoded byte size under
 * `budgetBytes`. A left glyph's entire pair set is always kept in a single
 * chunk — never split — because a Pair Adjustment lookup with multiple
 * subtables applies only the *first* subtable whose coverage includes the
 * current glyph (see buildLookup's docstring); splitting one left glyph's
 * pairs across two subtables would make the second subtable's entries for
 * that glyph permanently unreachable, even though they were technically
 * "kept" rather than dropped.
 *
 * `costPerNewLeft`/`costPerPair`/`baseCost` describe the caller's own
 * on-disk layout math (PairPos format 1 and classic kern format-0 cost
 * pairs differently), so both encoders can reuse the same no-drop packer
 * while staying comfortably inside their own actual byte ceilings.
 *
 * The only case that can't be perfectly bin-packed is a single left glyph
 * whose own pair set alone exceeds the budget — that needs on the order of
 * thousands of distinct right glyphs kerned against one left glyph, far
 * beyond any realistic font's total glyph count. Rather than drop any of
 * it, that oversized group is kept whole in its own (oversized) chunk.
 */
function chunkKerningRecords(
  records: { left: number; right: number; value: number }[],
  costPerNewLeft: number,
  costPerPair: number,
  baseCost: number,
  budgetBytes = 60000 // safety margin under the hard 65535 Offset16 ceiling
): { left: number; right: number; value: number }[][] {
  const byLeft = new Map<number, Array<{ right: number; value: number }>>();
  for (const { left, right, value } of records) {
    const list = byLeft.get(left) ?? [];
    list.push({ right, value });
    byLeft.set(left, list);
  }
  const lefts = [...byLeft.keys()].sort((a, b) => a - b);

  const chunks: { left: number; right: number; value: number }[][] = [];
  let currentLefts: number[] = [];
  let currentSize = baseCost;

  const flush = () => {
    if (!currentLefts.length) return;
    chunks.push(
      currentLefts.flatMap((left) => (byLeft.get(left) ?? []).map((r) => ({ left, right: r.right, value: r.value })))
    );
    currentLefts = [];
    currentSize = baseCost;
  };

  for (const left of lefts) {
    const group = byLeft.get(left) ?? [];
    const addSize = costPerNewLeft + costPerPair * group.length;
    if (currentLefts.length && currentSize + addSize > budgetBytes) flush();
    currentLefts.push(left);
    currentSize += addSize;
  }
  flush();

  if (chunks.length > 1) {
    console.info(
      `[FontSeru] Kerning export: ${records.length} pairs split across ${chunks.length} subtables to stay under ` +
        `the OpenType Offset16 limit per subtable; every pair is still exported.`
    );
  }
  return chunks;
}

/** PairPos format 1 (explicit per-pair values) for a single already-sized
 * chunk of records — no budgeting here, `chunkKerningRecords` already
 * guaranteed this chunk fits. */
function buildPairPosSubtable(records: { left: number; right: number; value: number }[]): Uint8Array {
  const byLeft = new Map<number, Array<{ right: number; value: number }>>();
  for (const { left, right, value } of records) {
    const list = byLeft.get(left) ?? [];
    list.push({ right, value });
    byLeft.set(left, list);
  }
  const lefts = [...byLeft.keys()].sort((a, b) => a - b);
  const coverage = buildCoverageFormat1(lefts);

  const pairSets = lefts.map((left) => {
    const recs = [...(byLeft.get(left) ?? [])].sort((a, b) => a.right - b.right);
    const w = new GsubByteWriter();
    w.u16(recs.length);
    for (const rec of recs) { w.u16(rec.right); w.u16(rec.value); } // valueRecord1 = xAdvance only (int16); valueRecord2 is absent (valueFormat2 = 0)
    return w.toUint8Array();
  });

  const headerSize = 10 + 2 * lefts.length; // posFormat + coverageOffset + valueFormat1 + valueFormat2 + pairSetCount + offsets[]
  const coverageOffset = headerSize;
  const pairSetOffsets: number[] = [];
  let running = coverageOffset + coverage.length;
  for (const set of pairSets) { pairSetOffsets.push(running); running += set.length; }

  const w = new GsubByteWriter();
  w.u16(1).u16(coverageOffset).u16(0x0004).u16(0x0000).u16(lefts.length);
  for (const off of pairSetOffsets) w.u16(off);
  w.raw(coverage);
  for (const set of pairSets) w.raw(set);
  return w.toUint8Array();
}

/**
 * Wraps N already-chunked PairPos subtables (each independently under the
 * 64KB Offset16 ceiling) in GPOS Extension Positioning (lookupType 9,
 * ExtensionPosFormat1) wrappers, all inside a single Lookup, all under the
 * same `kern` feature. This is the standard, spec-compliant mechanism
 * OpenType provides for exactly this situation — real compilers (fontTools,
 * Glyphs, FontLab) use it whenever a GSUB/GPOS data set is too large for a
 * plain subtable.
 *
 * Each wrapper is a fixed 8 bytes: posFormat(2) + extensionLookupType(2) +
 * extensionOffset(4, an Offset32). Crucially, `extensionOffset` is measured
 * from the *wrapper's own start* — not from the Lookup, LookupList, or GPOS
 * table start — so it can reach a PairPos subtable of essentially any size
 * placed anywhere after it. That's what actually removes the ceiling
 * instead of relocating it one level up: the Lookup itself only ever holds
 * a handful of fixed 8-byte wrappers (subTableCount * 8 bytes total, which
 * stays trivially inside Offset16 range no matter how many chunks exist),
 * while the real PairPos payloads sit behind 32-bit reach.
 */
function buildExtensionPosLookup(subtables: Uint8Array[]): Uint8Array {
  const count = subtables.length;
  const headerSize = 6 + 2 * count; // lookupType + lookupFlag + subTableCount + offsets[]
  const wrapperSize = 8; // ExtensionPosFormat1: posFormat(2) + extensionLookupType(2) + extensionOffset(4)

  const wrapperOffsets: number[] = [];
  let cursor = headerSize;
  for (let i = 0; i < count; i++) { wrapperOffsets.push(cursor); cursor += wrapperSize; }

  const payloadOffsets: number[] = [];
  for (let i = 0; i < count; i++) { payloadOffsets.push(cursor); cursor += subtables[i].length; }

  const w = new GsubByteWriter();
  w.u16(9).u16(0).u16(count); // lookupType 9 = Extension Positioning
  for (const off of wrapperOffsets) w.u16(off);
  for (let i = 0; i < count; i++) {
    const extensionOffset = payloadOffsets[i] - wrapperOffsets[i]; // relative to THIS wrapper's own start
    w.u16(1).u16(2).u32(extensionOffset); // posFormat=1, extensionLookupType=2 (PairPos)
  }
  for (const st of subtables) w.raw(st);
  return w.toUint8Array();
}

/** A single classic horizontal format-0 `kern` subtable for one already-
 * sized chunk of records (flat, no left-grouping — coverage is implicit in
 * the sorted [left, right] pair list itself). */
function buildKernFormat0Subtable(records: { left: number; right: number; value: number }[]): Uint8Array {
  const sorted = [...records].sort((a, b) => a.left - b.left || a.right - b.right);
  const nPairs = sorted.length;
  const maxPow2 = 2 ** Math.floor(Math.log2(Math.max(1, nPairs)));
  const searchRange = maxPow2 * 6;
  const entrySelector = Math.floor(Math.log2(maxPow2));
  const rangeShift = nPairs * 6 - searchRange;
  const length = 14 + nPairs * 6;
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, false); // subtable version
  view.setUint16(2, length, false); // subtable length (includes this 14-byte header)
  view.setUint16(4, 1, false); // coverage: format 0, horizontal
  view.setUint16(6, nPairs, false);
  view.setUint16(8, searchRange, false);
  view.setUint16(10, entrySelector, false);
  view.setUint16(12, rangeShift, false);
  sorted.forEach((rec, i) => {
    const off = 14 + i * 6;
    view.setUint16(off, rec.left, false);
    view.setUint16(off + 2, rec.right, false);
    view.setInt16(off + 4, rec.value, false);
  });
  return out;
}

/** Builds a classic `kern` table containing one format-0 subtable per
 * chunk. The top-level `kern` header's own `nTables` count natively
 * supports any number of subtables, applied additively — since each pair
 * lives in exactly one chunk/subtable, that "additive" behavior just means
 * each pair's adjustment is applied once, from whichever subtable holds it. */
function makeKernTable(pairs: KerningPairs, glyphIndexByChar: Map<string, number>): Uint8Array | null {
  const records = resolveKerningRecords(pairs, glyphIndexByChar);
  if (!records.length) return null;

  // Classic format-0 layout is flat: 14-byte subtable header + 6 bytes per
  // pair, no per-left-glyph overhead (unlike PairPos's coverage+pairSet
  // structure), so it gets its own cost constants here.
  const chunks = chunkKerningRecords(records, 0, 6, 14);
  const subtables = chunks.map(buildKernFormat0Subtable);

  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint16(0, 0, false); // kern table version
  new DataView(header.buffer).setUint16(2, subtables.length, false); // nTables
  const total = 4 + subtables.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(total);
  out.set(header, 0);
  let cursor = 4;
  for (const st of subtables) { out.set(st, cursor); cursor += st.length; }
  return out;
}

/** Add/replace a classic horizontal format-0 `kern` table in an sfnt font. */
export function injectKernTable(buffer: ArrayBuffer, pairs: KerningPairs, glyphIndexByChar: Map<string, number>): ArrayBuffer {
  const kern = makeKernTable(pairs, glyphIndexByChar);
  if (!kern) return buffer.slice(0);
  const input = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const numTables = u16(view, 4);
  const tables: { tag: string; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const d = 12 + i * 16;
    const tag = tagAt(view, d);
    if (tag === "kern") continue;
    const offset = u32(view, d + 8), length = u32(view, d + 12);
    if (offset + length > input.length) throw new Error("Generated font has a malformed sfnt table directory.");
    const data = input.slice(offset, offset + length);
    if (tag === "head" && data.length >= 12) data.fill(0, 8, 12);
    tables.push({ tag, data });
  }
  tables.push({ tag: "kern", data: kern });
  tables.sort((a, b) => a.tag.localeCompare(b.tag));

  const count = tables.length;
  const maxPow2 = 2 ** Math.floor(Math.log2(count));
  const searchRange = maxPow2 * 16;
  const entrySelector = Math.floor(Math.log2(maxPow2));
  const rangeShift = count * 16 - searchRange;
  let cursor = 12 + count * 16;
  const total = cursor + tables.reduce((n, t) => n + align4(t.data.length), 0);
  const output = new Uint8Array(total);
  const ov = new DataView(output.buffer);
  for (let i = 0; i < 4; i++) output[i] = input[i];
  ov.setUint16(4, count, false); ov.setUint16(6, searchRange, false);
  ov.setUint16(8, entrySelector, false); ov.setUint16(10, rangeShift, false);

  let headOffset = -1;
  tables.forEach((table, i) => {
    const d = 12 + i * 16;
    writeTag(ov, d, table.tag);
    ov.setUint32(d + 4, checksum(table.data), false);
    ov.setUint32(d + 8, cursor, false);
    ov.setUint32(d + 12, table.data.length, false);
    output.set(table.data, cursor);
    if (table.tag === "head") headOffset = cursor;
    cursor += align4(table.data.length);
  });

  if (headOffset >= 0) {
    const sum = checksum(output);
    ov.setUint32(headOffset + 8, (0xB1B0AFBA - sum) >>> 0, false);
  }
  return output.buffer;
}

// --- OpenType Feature Builder: GSUB table generation ---------------------
// Purely additive, mirroring injectKernTable's own "build a standalone
// table, splice it into the sfnt directory, never touch anything else"
// approach right above. A Feature Builder rule whose glyphs aren't present
// in glyphIndexByChar for the style being exported is simply skipped, so a
// rule drawn only in Regular never breaks a Bold/Italic export — exactly
// the same "kerning is an enhancement, never a reason to lose a valid base
// font" philosophy already used for the kern table.

class GsubByteWriter {
  private bytes: number[] = [];
  get length(): number { return this.bytes.length; }
  u16(value: number): this { const v = value & 0xffff; this.bytes.push((v >>> 8) & 0xff, v & 0xff); return this; }
  u32(value: number): this {
    const v = value >>> 0;
    this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  tag(value: string): this { for (let i = 0; i < 4; i++) this.bytes.push(value.charCodeAt(i) || 0x20); return this; }
  raw(bytes: Uint8Array): this { for (let i = 0; i < bytes.length; i++) this.bytes.push(bytes[i]); return this; }
  toUint8Array(): Uint8Array { return new Uint8Array(this.bytes); }
}

/** Coverage table format 1 — a flat sorted list of glyph IDs. */
function buildCoverageFormat1(gids: number[]): Uint8Array {
  const sorted = [...new Set(gids)].sort((a, b) => a - b);
  const w = new GsubByteWriter();
  w.u16(1).u16(sorted.length);
  for (const g of sorted) w.u16(g);
  return w.toUint8Array();
}

/** SingleSubst format 2 (explicit substitute list) — used for the 'swsh' feature. */
function buildSingleSubstFormat2(mapping: Array<{ from: number; to: number }>): Uint8Array {
  const sorted = [...mapping].sort((a, b) => a.from - b.from);
  const coverage = buildCoverageFormat1(sorted.map((m) => m.from));
  const headerSize = 6 + 2 * sorted.length;
  const w = new GsubByteWriter();
  w.u16(2).u16(headerSize).u16(sorted.length);
  for (const m of sorted) w.u16(m.to);
  w.raw(coverage);
  return w.toUint8Array();
}

/** AlternateSubst format 1 — used for the 'salt' feature; each base glyph
 * can offer multiple alternates. */
function buildAlternateSubstFormat1(rules: Array<{ base: number; alternates: number[] }>): Uint8Array {
  const sorted = [...rules].sort((a, b) => a.base - b.base);
  const coverage = buildCoverageFormat1(sorted.map((r) => r.base));
  const altSets = sorted.map((r) => {
    const w = new GsubByteWriter();
    w.u16(r.alternates.length);
    for (const gid of r.alternates) w.u16(gid);
    return w.toUint8Array();
  });
  const headerSize = 6 + 2 * sorted.length;
  const coverageOffset = headerSize;
  const altSetOffsets: number[] = [];
  let running = coverageOffset + coverage.length;
  for (const set of altSets) { altSetOffsets.push(running); running += set.length; }
  const w = new GsubByteWriter();
  w.u16(1).u16(coverageOffset).u16(sorted.length);
  for (const off of altSetOffsets) w.u16(off);
  w.raw(coverage);
  for (const set of altSets) w.raw(set);
  return w.toUint8Array();
}

/** LigatureSubst format 1 — used for the 'liga' feature. `rules` share a
 * common first-component glyph within each coverage entry. */
function buildLigatureSubstFormat1(rules: Array<{ components: number[]; ligature: number }>): Uint8Array {
  const byFirst = new Map<number, Array<{ components: number[]; ligature: number }>>();
  for (const rule of rules) {
    const first = rule.components[0];
    const arr = byFirst.get(first) ?? [];
    arr.push(rule);
    byFirst.set(first, arr);
  }
  const firstGlyphs = [...byFirst.keys()].sort((a, b) => a - b);
  const coverage = buildCoverageFormat1(firstGlyphs);

  const ligSets = firstGlyphs.map((first) => {
    // Longest component sequences first, matching the OpenType-recommended
    // greedy-match ordering within a LigatureSet.
    const entries = [...(byFirst.get(first) ?? [])].sort((a, b) => b.components.length - a.components.length);
    const ligatures = entries.map((entry) => {
      const w = new GsubByteWriter();
      w.u16(entry.ligature).u16(entry.components.length);
      for (let i = 1; i < entry.components.length; i++) w.u16(entry.components[i]);
      return w.toUint8Array();
    });
    const headerSize = 2 + 2 * ligatures.length;
    const offsets: number[] = [];
    let running = headerSize;
    for (const lig of ligatures) { offsets.push(running); running += lig.length; }
    const w = new GsubByteWriter();
    w.u16(ligatures.length);
    for (const off of offsets) w.u16(off);
    for (const lig of ligatures) w.raw(lig);
    return w.toUint8Array();
  });

  const headerSize = 6 + 2 * firstGlyphs.length;
  const coverageOffset = headerSize;
  const ligSetOffsets: number[] = [];
  let running = coverageOffset + coverage.length;
  for (const set of ligSets) { ligSetOffsets.push(running); running += set.length; }
  const w = new GsubByteWriter();
  w.u16(1).u16(coverageOffset).u16(firstGlyphs.length);
  for (const off of ligSetOffsets) w.u16(off);
  w.raw(coverage);
  for (const set of ligSets) w.raw(set);
  return w.toUint8Array();
}

/** Wraps one or more subtables in a single Lookup table (lookupFlag always
 * 0). When a lookup carries multiple subtables, OpenType Layout applies the
 * first subtable whose Coverage includes the glyph at the current position
 * and stops there — so subtable order encodes priority. `buildGposTable`
 * relies on exactly this to let exact-pair exceptions (subtable 0) win over
 * class-based kerning (subtable 1) without double-applying both. */
function buildLookup(lookupType: number, subtables: Uint8Array[]): Uint8Array {
  const headerSize = 6 + 2 * subtables.length; // lookupType + lookupFlag + subTableCount + offsets[]
  const offsets: number[] = [];
  let running = headerSize;
  for (const st of subtables) { offsets.push(running); running += st.length; }
  const w = new GsubByteWriter();
  w.u16(lookupType).u16(0).u16(subtables.length);
  for (const off of offsets) w.u16(off);
  for (const st of subtables) w.raw(st);
  return w.toUint8Array();
}

function buildLookupList(lookups: Uint8Array[]): Uint8Array {
  const headerSize = 2 + 2 * lookups.length;
  const offsets: number[] = [];
  let running = headerSize;
  for (const lookup of lookups) { offsets.push(running); running += lookup.length; }
  const w = new GsubByteWriter();
  w.u16(lookups.length);
  for (const off of offsets) w.u16(off);
  for (const lookup of lookups) w.raw(lookup);
  return w.toUint8Array();
}

/** Splits ligature rules into ordered levels so a ligature built FROM
 * another ligature — e.g. an "f_f"+"l"→"f_f_l" rule whose first input is
 * the "ff" ligature's own glyph, not a plain typed letter — ends up in a
 * LATER lookup than the rule that produces that input glyph. OpenType
 * applies a feature's lookups in order, each one a full pass over the
 * whole glyph run before the next lookup starts, so putting the "ff" rule
 * in lookup level 0 and the "ff"+"l" rule in level 1 means that by the
 * time level 1 runs, level 0 has already turned the two "f"s into a
 * single "ff" glyph for it to match against — a single combined lookup
 * (the old behavior) could never do this, since within one lookup's pass
 * the newly-substituted glyph doesn't exist yet for a later rule in the
 * same pass to match. A rule whose components don't depend on any other
 * rule's target sits at level 0, same as before. Cycle-safe (falls back
 * to level 0 for whichever rule closes the loop) since a font shouldn't
 * ever actually have one, but a corrupt/cyclic config must never
 * infinite-loop the export. */
function ligatureLevels(
  rules: Array<{ components: number[]; ligature: number }>
): Array<Array<{ components: number[]; ligature: number }>> {
  const byTarget = new Map<number, { components: number[]; ligature: number }>();
  for (const r of rules) byTarget.set(r.ligature, r);
  const levelCache = new Map<{ components: number[]; ligature: number }, number>();
  function levelOf(rule: { components: number[]; ligature: number }, seen: Set<typeof rule>): number {
    const cached = levelCache.get(rule);
    if (cached != null) return cached;
    if (seen.has(rule)) return 0;
    seen.add(rule);
    let depLevel = -1;
    for (const c of rule.components) {
      const dep = byTarget.get(c);
      if (dep) depLevel = Math.max(depLevel, levelOf(dep, seen));
    }
    const level = depLevel + 1;
    levelCache.set(rule, level);
    return level;
  }
  const levels: Array<Array<{ components: number[]; ligature: number }>> = [];
  for (const rule of rules) {
    const level = levelOf(rule, new Set());
    (levels[level] ??= []).push(rule);
  }
  return levels.filter((l) => l && l.length > 0);
}

/** One Feature table per entry — each references its lookups, by their
 * global indices into the LookupList, in the order they should be
 * applied (see `ligatureLevels` for why "liga" can need more than one,
 * in dependency order). */
function buildFeatureList(features: Array<{ tag: string; lookupIndices: number[] }>): Uint8Array {
  const featureTables = features.map((f) => {
    const w = new GsubByteWriter();
    w.u16(0).u16(f.lookupIndices.length); // no FeatureParams
    for (const idx of f.lookupIndices) w.u16(idx);
    return w.toUint8Array();
  });
  const headerSize = 2 + 6 * features.length;
  const offsets: number[] = [];
  let running = headerSize;
  for (const table of featureTables) { offsets.push(running); running += table.length; }
  const w = new GsubByteWriter();
  w.u16(features.length);
  features.forEach((f, i) => { w.tag(f.tag); w.u16(offsets[i]); });
  for (const table of featureTables) w.raw(table);
  return w.toUint8Array();
}

/** A LangSys table (used as every script's default) listing every feature
 * index — every script/langsys in this table shares the same global
 * feature set, which is standard practice for a single-language font. */
function buildLangSys(featureIndices: number[]): Uint8Array {
  const w = new GsubByteWriter();
  w.u16(0).u16(0xffff).u16(featureIndices.length);
  for (const idx of featureIndices) w.u16(idx);
  return w.toUint8Array();
}

function buildScript(featureIndices: number[]): Uint8Array {
  const langSys = buildLangSys(featureIndices);
  const w = new GsubByteWriter();
  w.u16(4).u16(0); // defaultLangSysOffset = 4 (right after this header), langSysCount = 0
  w.raw(langSys);
  return w.toUint8Array();
}

function buildScriptList(scriptTags: string[], featureIndices: number[]): Uint8Array {
  const scripts = scriptTags.map(() => buildScript(featureIndices));
  const headerSize = 2 + 6 * scriptTags.length;
  const offsets: number[] = [];
  let running = headerSize;
  for (const script of scripts) { offsets.push(running); running += script.length; }
  const w = new GsubByteWriter();
  w.u16(scriptTags.length);
  scriptTags.forEach((tag, i) => { w.tag(tag); w.u16(offsets[i]); });
  for (const script of scripts) w.raw(script);
  return w.toUint8Array();
}

/**
 * Compiles a Feature Builder config into a standard GSUB table. Returns
 * null when there's nothing to generate (empty config, or none of the
 * configured glyphs exist in this style's glyph set) so callers can skip
 * injection entirely.
 */
function buildGsubTable(config: FeatureBuilderConfig, glyphIndexByChar: Map<string, number>): Uint8Array | null {
  const gid = (ref: string) => glyphIndexByChar.get(ref);

  const ligatureRules = config.ligatures
    .map((rule) => ({
      components: rule.components.map(gid),
      ligature: gid(rule.target),
    }))
    .filter((r): r is { components: number[]; ligature: number } =>
      r.ligature != null && r.components.length >= 2 && r.components.every((g) => g != null)
    );

  const alternateRules = config.alternates
    .map((rule) => ({
      base: gid(rule.base),
      alternates: rule.alternates.map(gid).filter((g): g is number => g != null),
    }))
    .filter((r): r is { base: number; alternates: number[] } => r.base != null && r.alternates.length > 0);

  const swashRules = config.swashes
    .map((rule) => ({ from: gid(rule.base), to: gid(rule.swash) }))
    .filter((r): r is { from: number; to: number } => r.from != null && r.to != null);

  if (!ligatureRules.length && !alternateRules.length && !swashRules.length) return null;

  const lookups: Uint8Array[] = [];
  const features: Array<{ tag: string; lookupIndices: number[] }> = [];

  if (ligatureRules.length) {
    const levels = ligatureLevels(ligatureRules);
    const ligLookupIndices: number[] = [];
    for (const level of levels) {
      ligLookupIndices.push(lookups.length);
      lookups.push(buildLookup(4, [buildLigatureSubstFormat1(level)]));
    }
    features.push({ tag: "liga", lookupIndices: ligLookupIndices });
  }
  if (alternateRules.length) {
    features.push({ tag: "salt", lookupIndices: [lookups.length] });
    lookups.push(buildLookup(3, [buildAlternateSubstFormat1(alternateRules)]));
  }
  if (swashRules.length) {
    features.push({ tag: "swsh", lookupIndices: [lookups.length] });
    lookups.push(buildLookup(1, [buildSingleSubstFormat2(swashRules)]));
  }

  const lookupListBytes = buildLookupList(lookups);
  const featureListBytes = buildFeatureList(features);
  const featureIndices = features.map((_, i) => i);
  const scriptListBytes = buildScriptList(["DFLT", "latn"], featureIndices);

  const headerSize = 10;
  const scriptListOffset = headerSize;
  const featureListOffset = scriptListOffset + scriptListBytes.length;
  const lookupListOffset = featureListOffset + featureListBytes.length;

  const w = new GsubByteWriter();
  w.u16(1).u16(0); // version 1.0
  w.u16(scriptListOffset).u16(featureListOffset).u16(lookupListOffset);
  w.raw(scriptListBytes);
  w.raw(featureListBytes);
  w.raw(lookupListBytes);
  return w.toUint8Array();
}

/** Add/replace a `GSUB` table in an sfnt font, mirroring injectKernTable's
 * own directory-splicing approach exactly (see above) so both can be
 * applied independently without interfering with each other. */
export function injectGsubTable(buffer: ArrayBuffer, config: FeatureBuilderConfig, glyphIndexByChar: Map<string, number>): ArrayBuffer {
  if (isFeatureConfigEmpty(config)) return buffer.slice(0);
  const gsub = buildGsubTable(config, glyphIndexByChar);
  if (!gsub) return buffer.slice(0);
  return spliceSfntTable(buffer, "GSUB", gsub);
}

// --- GPOS 'kern' feature (modern pair-positioning kerning) ----------------
// The legacy `kern` table above (format-0, sfnt tag "kern") is what
// classic Mac/Win TrueType rasterizers read. Most current tooling —
// browsers, and notably third-party font QA/marketplace checks such as
// Monotype's submission review — instead look for kerning expressed as
// OpenType Layout: a GPOS table with a 'kern' feature using a Pair
// Adjustment (lookupType 2) subtable. A font with only the legacy table
// can genuinely read back as "no kerning" to those checks even though the
// data is present and correct. Both are written from the exact same
// `kerningPairs`, so they can never disagree with each other.

/** Compiles kerning pairs into a standard GPOS table (ScriptList +
 * FeatureList with a single 'kern' feature + LookupList with one Extension
 * Positioning lookup) — same header shape as `buildGsubTable`, since GSUB
 * and GPOS share the same top-level "Common Tables" layout, they just
 * point at different lookup subtable formats. The full, un-truncated pair
 * list is chunked into as many PairPos format-1 subtables as needed (see
 * `chunkKerningRecords`), each wrapped in an Extension Positioning
 * subtable (see `buildExtensionPosLookup`) so no pair is ever dropped
 * regardless of how large the kerning matrix gets. */
function buildGposTable(pairs: KerningPairs, glyphIndexByChar: Map<string, number>): Uint8Array | null {
  const records = resolveKerningRecords(pairs ?? {}, glyphIndexByChar);
  if (!records.length) return null;

  // PairPos format 1 layout: header(10) + 2*L (pairSet offsets) +
  // coverage(4 + 2*L) + per-pair(4) — i.e. baseCost 14, +6 per new left
  // glyph, +4 per pair. Matches buildPairPosSubtable's own byte layout.
  const chunks = chunkKerningRecords(records, 6, 4, 14);
  const pairPosSubtables = chunks.map(buildPairPosSubtable);
  const extensionLookup = buildExtensionPosLookup(pairPosSubtables);

  const lookupListBytes = buildLookupList([extensionLookup]);
  const featureListBytes = buildFeatureList([{ tag: "kern", lookupIndices: [0] }]);
  const scriptListBytes = buildScriptList(["DFLT", "latn"], [0]);

  const headerSize = 10;
  const scriptListOffset = headerSize;
  const featureListOffset = scriptListOffset + scriptListBytes.length;
  const lookupListOffset = featureListOffset + featureListBytes.length;

  const w = new GsubByteWriter();
  w.u16(1).u16(0); // version 1.0
  w.u16(scriptListOffset).u16(featureListOffset).u16(lookupListOffset);
  w.raw(scriptListBytes);
  w.raw(featureListBytes);
  w.raw(lookupListBytes);
  return w.toUint8Array();
}

/** Add/replace a `GPOS` table carrying the same kerning pairs as
 * `injectKernTable`'s legacy table — see the block comment above. Purely
 * additive and independent of the legacy `kern`/`GSUB` injection, so it
 * can be skipped on failure without affecting either. */
export function injectGposTable(buffer: ArrayBuffer, pairs: KerningPairs, glyphIndexByChar: Map<string, number>): ArrayBuffer {
  const gpos = buildGposTable(pairs, glyphIndexByChar);
  if (!gpos) return buffer.slice(0);
  return spliceSfntTable(buffer, "GPOS", gpos);
}

function signatureFor(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return String.fromCharCode(...bytes);
}

export function validateGeneratedFont(
  buffer: ArrayBuffer,
  format: "otf" | "ttf",
  expected?: { familyName?: string; hasUpperA?: boolean },
): opentype.Font {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 64) {
    throw new Error(`Generated ${format.toUpperCase()} data is incomplete.`);
  }

  const bytes = new Uint8Array(buffer, 0, 4);
  const tag = signatureFor(buffer);
  const validSignature = format === "otf"
    ? tag === "OTTO"
    : (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) || tag === "true";
  if (!validSignature) throw new Error(`Generated ${format.toUpperCase()} data has an invalid sfnt signature.`);

  try {
    const parsed = opentype.parse(buffer.slice(0));
    const unitsPerEm = (parsed as any).unitsPerEm;
    const glyphCount = (parsed as any).glyphs?.length ?? 0;
    if (!Number.isFinite(unitsPerEm) || unitsPerEm <= 0) {
      throw new Error("unitsPerEm is invalid");
    }
    if (!Number.isFinite(glyphCount) || glyphCount < 2) {
      throw new Error("glyph table is incomplete");
    }
    const family = getParsedFontName((parsed as any).names, "fontFamily", "");
    if (!family) throw new Error("family name is missing");
    if (expected?.familyName && family !== expected.familyName) {
      throw new Error(`family name mismatch (expected "${expected.familyName}", got "${family}")`);
    }
    if (expected?.hasUpperA && typeof (parsed as any).charToGlyphIndex === "function") {
      const aIndex = (parsed as any).charToGlyphIndex("A");
      if (!Number.isFinite(aIndex) || aIndex <= 0) throw new Error('encoded glyph "A" is missing');
    }
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Generated ${format.toUpperCase()} failed parser validation: ${detail}`);
  }
}

function generateOTFBase(
  glyphs: Glyph[],
  metrics: FontMetrics,
  info: NormalizedFontMetadata,
): { buffer: ArrayBuffer; glyphIndexByChar: Map<string, number> } {
  // The shared export model is normalized for TrueType. CFF/OpenType uses
  // the opposite canonical direction, so convert only for the OTF writer.
  const cffGlyphs = glyphs.map(glyphForOpenTypeCFF);
  const { font, glyphIndexByChar } = buildOpenTypeFont(cffGlyphs, metrics, info);
  // See patchOtfHeadAndPost's doc comment: opentype.js drops macStyle/
  // italicAngle from the tables it actually writes, so they're patched
  // into the serialized buffer directly rather than relying on the
  // library's own (incomplete) head/post table builders.
  const buffer = patchOtfHeadAndPost(font.toArrayBuffer(), info.macStyle, info.italicAngle);
  validateGeneratedFont(buffer, "otf", {
    familyName: info.legacyFamilyName,
    hasUpperA: glyphs.some((glyph) => glyph.unicode === 0x41 || glyph.unicodes?.includes(0x41) === true),
  });
  return { buffer, glyphIndexByChar };
}

function generateOTF(
  glyphs: Glyph[],
  metrics: FontMetrics,
  info: NormalizedFontMetadata,
  kerningPairs: KerningPairs,
  featureConfig?: FeatureBuilderConfig,
): ArrayBuffer {
  const base = generateOTFBase(glyphs, metrics, info);
  let buffer = base.buffer;

  // Kerning is an enhancement, never a reason to lose a valid base font.
  //
  // BUG FIX (double-applied kerning after install): this used to inject
  // BOTH the legacy 'kern' table AND the modern GPOS 'kern' feature with
  // the SAME full pair values. Per the OpenType spec a renderer should use
  // GPOS and ignore legacy 'kern' when both exist, and that's exactly what
  // browsers/HarfBuzz-based engines (e.g. Figma) do — but several native
  // desktop text engines (notably Affinity's) read and SUM both tables,
  // so every pair's adjustment was effectively doubled once the font was
  // actually installed, even though Test Lab (which only ever simulates
  // one set of values) looked correct. Fixed by writing GPOS first and
  // only falling back to the legacy 'kern' table if GPOS injection fails,
  // so a real exported font never carries both at once.
  if (Object.keys(kerningPairs ?? {}).length) {
    let gposApplied = false;
    try {
      const withGpos = injectGposTable(buffer, kerningPairs, base.glyphIndexByChar);
      validateGeneratedFont(withGpos, "otf", {
        familyName: info.legacyFamilyName,
        hasUpperA: glyphs.some((glyph) => glyph.unicode === 0x41 || glyph.unicodes?.includes(0x41) === true),
      });
      buffer = withGpos;
      gposApplied = true;
    } catch (error) {
      console.warn("[FontSeru] GPOS kerning export skipped.", error);
    }

    // Legacy 'kern' is only a fallback for apps that don't read GPOS at
    // all (virtually none left). Never write it alongside a successful
    // GPOS table — that's what caused the doubled kerning above.
    if (!gposApplied) {
      try {
        const withKerning = injectKernTable(buffer, kerningPairs, base.glyphIndexByChar);
        validateGeneratedFont(withKerning, "otf", {
          familyName: info.legacyFamilyName,
          hasUpperA: glyphs.some((glyph) => glyph.unicode === 0x41 || glyph.unicodes?.includes(0x41) === true),
        });
        buffer = withKerning;
      } catch (error) {
        console.warn("[FontSeru] Kerning export skipped; using the valid base OTF.", error);
      }
    }
  }

  // OpenType Feature Builder (ligature/alternate/swash) is likewise an
  // enhancement layered on top — never a reason to lose an otherwise valid
  // font, kerned or not.
  if (featureConfig && !isFeatureConfigEmpty(featureConfig)) {
    try {
      const withFeatures = injectGsubTable(buffer, featureConfig, base.glyphIndexByChar);
      validateGeneratedFont(withFeatures, "otf", {
        familyName: info.legacyFamilyName,
        hasUpperA: glyphs.some((glyph) => glyph.unicode === 0x41 || glyph.unicodes?.includes(0x41) === true),
      });
      buffer = withFeatures;
    } catch (error) {
      console.warn("[FontSeru] OpenType Feature export skipped; using the font without it.", error);
    }
  }

  return buffer;
}

function glyphToTrueTypeInput(glyph: Glyph): TrueTypeGlyphInput {
  const contours = glyph.outline.objects.flatMap((obj) =>
    obj.contours.map((contour) => ({
      nodes: contour.nodes.map((node) => ({
        point: { x: node.point.x, y: node.point.y },
        handleIn: node.handleIn ? { x: node.handleIn.x, y: node.handleIn.y } : null,
        handleOut: node.handleOut ? { x: node.handleOut.x, y: node.handleOut.y } : null,
      })),
    })),
  );

  return {
    name: glyphName(glyph),
    unicodes: glyph.unicodes?.length ? glyph.unicodes : [glyph.unicode],
    advanceWidth: glyph.advanceWidth,
    contours,
  };
}

function generateTTFBase(
  glyphs: Glyph[],
  metrics: FontMetrics,
  info: NormalizedFontMetadata,
): { buffer: ArrayBuffer; glyphIndexByChar: Map<string, number> } {
  // TTF is now written directly from FontSeru's normalized glyph model.
  // There is no SVG intermediary and no OTF -> TTF conversion step.
  const result = buildTrueTypeFont({
    unitsPerEm: metrics.unitsPerEm,
    ascender: metrics.ascender,
    descender: metrics.descender,
    capHeight: metrics.capHeight,
    xHeight: metrics.xHeight,
    metadata: {
      familyName: info.legacyFamilyName,
      subfamilyName: info.legacySubfamilyName,
      typographicFamilyName: info.familyName,
      typographicSubfamilyName: info.styleName,
      fullName: info.fullName,
      postScriptName: info.postscriptName,
      version: info.version,
      creator: info.designer || "FontSeru",
      designerURL: info.designerURL,
      manufacturer: info.manufacturer || "FontSeru",
      manufacturerURL: info.manufacturerURL,
      trademark: info.trademark,
      uniqueID: info.uniqueID,
      copyright: info.copyright,
      description: info.description,
      license: info.license,
      licenseURL: info.licenseURL,
      weightClass: info.weightClass,
      fsSelection: info.fsSelection,
      macStyle: info.macStyle,
      italicAngle: info.italicAngle,
    },
    glyphs: glyphs.map(glyphToTrueTypeInput),
  });

  const glyphIndexByChar = new Map<string, number>();
  for (const glyph of glyphs) {
    const gid = result.glyphIndexByUnicode.get(glyph.unicode);
    if (gid != null) glyphIndexByChar.set(glyph.char, gid);
  }

  validateGeneratedFont(result.buffer, "ttf", {
    familyName: info.legacyFamilyName,
    hasUpperA: glyphs.some((glyph) => glyph.unicode === 0x41 || glyph.unicodes?.includes(0x41) === true),
  });

  return { buffer: result.buffer, glyphIndexByChar };
}

function generateTTF(
  glyphs: Glyph[],
  metrics: FontMetrics,
  info: NormalizedFontMetadata,
  kerningPairs: KerningPairs,
  featureConfig?: FeatureBuilderConfig,
): ArrayBuffer {
  const base = generateTTFBase(glyphs, metrics, info);
  let buffer = base.buffer;

  // Kerning is optional. A valid base TTF always wins over a broken kern
  // injection, and the technical reason remains visible in the console.
  //
  // BUG FIX (double-applied kerning after install): see the identical fix
  // in generateOTF above — writing both the legacy 'kern' table and the
  // GPOS 'kern' feature with the same full values let engines that honor
  // both (several native desktop apps) sum them, doubling every pair's
  // adjustment versus what Test Lab previewed. GPOS is now tried first and
  // legacy 'kern' is only written when GPOS injection fails, so the two
  // are never both present at once.
  if (Object.keys(kerningPairs ?? {}).length) {
    let gposApplied = false;
    try {
      const withGpos = injectGposTable(buffer, kerningPairs, base.glyphIndexByChar);
      validateGeneratedFont(withGpos, "ttf", {
        familyName: info.legacyFamilyName,
        hasUpperA: glyphs.some((glyph) => glyph.unicode === 0x41 || glyph.unicodes?.includes(0x41) === true),
      });
      buffer = withGpos;
      gposApplied = true;
    } catch (error) {
      console.warn("[FontSeru] GPOS kerning export skipped.", error);
    }

    if (!gposApplied) {
      try {
        const withKerning = injectKernTable(buffer, kerningPairs, base.glyphIndexByChar);
        validateGeneratedFont(withKerning, "ttf", {
          familyName: info.legacyFamilyName,
          hasUpperA: glyphs.some((glyph) => glyph.unicode === 0x41 || glyph.unicodes?.includes(0x41) === true),
        });
        buffer = withKerning;
      } catch (error) {
        console.warn("[FontSeru] Kerning export skipped; using the valid base TTF.", error);
      }
    }
  }

  // Same enhancement-only treatment as OTF above — see generateOTF.
  if (featureConfig && !isFeatureConfigEmpty(featureConfig)) {
    try {
      const withFeatures = injectGsubTable(buffer, featureConfig, base.glyphIndexByChar);
      validateGeneratedFont(withFeatures, "ttf", {
        familyName: info.legacyFamilyName,
        hasUpperA: glyphs.some((glyph) => glyph.unicode === 0x41 || glyph.unicodes?.includes(0x41) === true),
      });
      buffer = withFeatures;
    } catch (error) {
      console.warn("[FontSeru] OpenType Feature export skipped; using the font without it.", error);
    }
  }

  return buffer;
}

function technicalMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function exportOTF(
  glyphs: GlyphMap,
  metrics: FontMetrics,
  info: FontInfo,
  kerningPairs: KerningPairs,
  featureConfig?: FeatureBuilderConfig,
  grouping?: FontFamilyGrouping,
): ArrayBuffer {
  const data = normalizeExportFontData({ glyphs, metrics, info, fontName: info?.familyName, kerningPairs, grouping });
  return generateOTF(data.glyphs, data.metrics, data.info, data.kerningPairs, featureConfig);
}

export async function exportTTF(
  glyphs: GlyphMap,
  metrics: FontMetrics,
  info: FontInfo,
  kerningPairs: KerningPairs,
  featureConfig?: FeatureBuilderConfig,
  grouping?: FontFamilyGrouping,
): Promise<ArrayBuffer> {
  const data = normalizeExportFontData({ glyphs, metrics, info, fontName: info?.familyName, kerningPairs, grouping });
  return generateTTF(data.glyphs, data.metrics, data.info, data.kerningPairs, featureConfig);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // woff-lib may hand back a view into a larger, over-allocated backing
  // buffer, so copy out exactly the bytes that belong to this font.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function generateFontFiles(
  glyphs: GlyphMap,
  metrics: FontMetrics,
  info: FontInfo,
  kerningPairs: KerningPairs,
  formats: ExportFontFormat[],
  featureConfig?: FeatureBuilderConfig,
  grouping?: FontFamilyGrouping,
): Promise<GeneratedFontFile[]> {
  const data = normalizeExportFontData({
    glyphs,
    metrics,
    info,
    fontName: info?.familyName,
    kerningPairs,
    grouping,
  });
  const files: GeneratedFontFile[] = [];
  const wanted = new Set(formats);

  // Generate every selected binary before the caller opens any Save As UI.
  // Each format is independent: no OTF->TTF rename/conversion chain exists.

  // WOFF and WOFF2 are just compressed containers around an existing sfnt.
  // FontSeru wraps its TrueType (glyf) output for them — the same binary a
  // plain .ttf export produces — since that's the most broadly compatible
  // choice for web fonts and only needs generating once for both.
  let ttfBuffer: ArrayBuffer | null = null;
  if (wanted.has("ttf") || wanted.has("woff") || wanted.has("woff2")) {
    try {
      ttfBuffer = generateTTF(data.glyphs, data.metrics, data.info, data.kerningPairs, featureConfig);
    } catch (error) {
      console.error("[FontSeru] TTF generation failed:", error);
      throw new Error(`Unable to generate TTF. ${technicalMessage(error)}`);
    }
    if (wanted.has("ttf")) {
      files.push({ extension: "ttf", mimeType: "font/ttf", buffer: ttfBuffer });
    }
  }

  if (wanted.has("otf")) {
    try {
      const otf = generateOTF(data.glyphs, data.metrics, data.info, data.kerningPairs, featureConfig);
      files.push({ extension: "otf", mimeType: "font/otf", buffer: otf });
    } catch (error) {
      console.error("[FontSeru] OTF generation failed:", error);
      throw new Error(`Unable to generate OTF. ${technicalMessage(error)}`);
    }
  }

  if (wanted.has("woff")) {
    try {
      const { woffEncode } = await import("woff-lib/woff/encode");
      const woff = await woffEncode(new Uint8Array(ttfBuffer as ArrayBuffer));
      files.push({ extension: "woff", mimeType: "font/woff", buffer: toArrayBuffer(woff) });
    } catch (error) {
      console.error("[FontSeru] WOFF generation failed:", error);
      throw new Error(`Unable to generate WOFF. ${technicalMessage(error)}`);
    }
  }

  if (wanted.has("woff2")) {
    try {
      const { woff2Encode } = await import("woff-lib/woff2/encode");
      const woff2 = woff2Encode(new Uint8Array(ttfBuffer as ArrayBuffer));
      files.push({ extension: "woff2", mimeType: "font/woff2", buffer: toArrayBuffer(woff2) });
    } catch (error) {
      console.error("[FontSeru] WOFF2 generation failed:", error);
      throw new Error(`Unable to generate WOFF2. ${technicalMessage(error)}`);
    }
  }

  return files;
}
function commandContours(commands: any[]): Contour[] {
  const contours: Contour[] = [];
  let current: Contour | null = null;
  let last: PathNode | null = null;
  const start = (x: number, y: number) => {
    current = { id: shortId("contour"), nodes: [], closed: false };
    contours.push(current);
    const node: PathNode = { id: shortId("node"), point: { x, y }, handleIn: null, handleOut: null, type: "corner" };
    current.nodes.push(node); last = node;
  };
  const addLine = (x: number, y: number) => {
    if (!current) start(x, y);
    else {
      const node: PathNode = { id: shortId("node"), point: { x, y }, handleIn: null, handleOut: null, type: "corner" };
      current.nodes.push(node); last = node;
    }
  };
  for (const cmd of commands) {
    if (cmd.type === "M") {
      start(cmd.x, cmd.y);
      continue;
    }
    if (cmd.type === "L") {
      addLine(cmd.x, cmd.y);
      continue;
    }

    // Assignments inside start()/addLine() are intentionally hidden behind
    // closures; use stable locals so TypeScript does not incorrectly narrow
    // the mutable parser state to `never`.
    const activeContour = current as Contour | null;
    const activeNode = last as PathNode | null;
    if (cmd.type === "C" && activeContour && activeNode) {
      activeNode.handleOut = { x: cmd.x1, y: cmd.y1 };
      const node: PathNode = { id: shortId("node"), point: { x: cmd.x, y: cmd.y }, handleIn: { x: cmd.x2, y: cmd.y2 }, handleOut: null, type: "smooth" };
      activeContour.nodes.push(node); last = node;
    } else if (cmd.type === "Q" && activeContour && activeNode) {
      const p0 = activeNode.point, p2 = { x: cmd.x, y: cmd.y }, q = { x: cmd.x1, y: cmd.y1 };
      activeNode.handleOut = { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) };
      const node: PathNode = {
        id: shortId("node"), point: p2,
        handleIn: { x: p2.x + (2 / 3) * (q.x - p2.x), y: p2.y + (2 / 3) * (q.y - p2.y) },
        handleOut: null, type: "smooth",
      };
      activeContour.nodes.push(node); last = node;
    } else if (cmd.type === "Z" && activeContour) {
      // opentype paths sometimes repeat the start point before Z; remove that
      // duplicate because FontSeru expresses closure with `closed`.
      if (activeContour.nodes.length > 1) {
        const a = activeContour.nodes[0].point, b = activeContour.nodes[activeContour.nodes.length - 1].point;
        if (a.x === b.x && a.y === b.y) activeContour.nodes.pop();
      }
      activeContour.closed = true;
      last = activeContour.nodes[activeContour.nodes.length - 1] ?? null;
    }
  }
  return contours.filter((c) => c.nodes.length > 0);
}

function parseOpenTypeKerning(font: any, charByGid: Map<number, string>): KerningPairs {
  const out: KerningPairs = {};
  const legacy = font.kerningPairs ?? {};
  for (const [pair, value] of Object.entries(legacy)) {
    const parts = pair.split(",");
    if (parts.length !== 2) continue;
    const left = charByGid.get(Number(parts[0])), right = charByGid.get(Number(parts[1]));
    if (left && right && Number.isFinite(Number(value))) out[kerningKey(left, right)] = Math.round(Number(value));
  }
  // GPOS pair positioning is exposed through getKerningValue even when no
  // legacy kern map exists. Probe only encoded glyphs to avoid an O(n^2)
  // scan across unencoded production glyphs.
  const encoded = [...charByGid.entries()];
  if (typeof font.getKerningValue === "function" && encoded.length <= 800) {
    for (const [lgid, left] of encoded) for (const [rgid, right] of encoded) {
      const v = font.getKerningValue(font.glyphs.get(lgid), font.glyphs.get(rgid));
      if (v) out[kerningKey(left, right)] = Math.round(v);
    }
  }
  return out;
}

export function importOpenType(buffer: ArrayBuffer): ImportedFontProject {
  const font = opentype.parse(buffer);
  const glyphs: GlyphMap = {};
  const charByGid = new Map<number, string>();
  const count = (font as any).glyphs.length;
  for (let gid = 0; gid < count; gid++) {
    const og: any = (font as any).glyphs.get(gid);
    const unicodes: number[] = Array.isArray(og.unicodes) && og.unicodes.length
      ? [...new Set<number>(og.unicodes.filter((u: unknown): u is number => typeof u === "number" && Number.isFinite(u)))]
      : (Number.isFinite(og.unicode) ? [Number(og.unicode)] : []);
    if (!unicodes.length) continue; // current editor navigation is Unicode-centric
    const cp = unicodes[0];
    const char = String.fromCodePoint(cp);
    const contours = commandContours(og.path?.commands ?? []);
    const advanceWidth = Math.round(og.advanceWidth ?? font.unitsPerEm * 0.6);
    const left = Number.isFinite(og.xMin) ? og.xMin : 0;
    const right = Number.isFinite(og.xMax) ? advanceWidth - og.xMax : 0;
    glyphs[char] = {
      char, unicode: cp, unicodes, name: og.name || undefined,
      category: categoryFor(cp),
      advanceWidth,
      lsb: Math.round(left),
      rsb: Math.round(right),
      outline: { objects: contours.length ? [{ id: shortId("obj"), kind: "shape", contours }] : [] },
      components: [],
    };
    charByGid.set(gid, char);
  }
  if (!Object.keys(glyphs).length) throw new Error("The font has no Unicode-mapped glyphs that FontSeru can edit.");

  const names: unknown = (font as any).names ?? {};
  const familyName = getParsedFontName(names, "fontFamily", "Imported Font");
  const styleName = getParsedFontName(names, "fontSubfamily", "Regular");
  const fullName = getParsedFontName(names, "fullName", `${familyName} ${styleName}`);
  const postscriptName = sanitizePostScriptName(
    familyName,
    styleName,
    getParsedFontName(names, "postScriptName", ""),
  );
  const os2: any = (font as any).tables?.os2 ?? {};
  const metrics: FontMetrics = {
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascender,
    baseline: 0,
    descender: font.descender,
    capHeight: Number.isFinite(os2.sCapHeight) ? os2.sCapHeight : Math.round(font.ascender * 0.875),
    xHeight: Number.isFinite(os2.sxHeight) ? os2.sxHeight : Math.round(font.ascender * 0.625),
  };
  const versionName = getParsedFontName(names, "version", "").replace(/^Version\s+/i, "") || "1.000";
  const fontInfo: FontInfo = {
    familyName, styleName, fullName, postscriptName,
    version: versionName,
    designer: getParsedFontName(names, "designer", ""),
    copyright: getParsedFontName(names, "copyright", ""),
    description: getParsedFontName(names, "description", ""),
    license: getParsedFontName(names, "license", ""),
    licenseURL: getParsedFontName(names, "licenseURL", ""),
    manufacturer: getParsedFontName(names, "manufacturer", ""),
    manufacturerURL: getParsedFontName(names, "manufacturerURL", ""),
    uniqueID: getParsedFontName(names, "uniqueID", ""),
  };
  return { fontName: familyName, fontInfo, metrics, glyphs, kerningPairs: parseOpenTypeKerning(font as any, charByGid) };
}
