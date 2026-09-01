import type { GlyphMap } from "@/types/glyph";
import { unicodeHex } from "@/utils/unicode";

export type QASeverity = "error" | "warning" | "info" | "pass";

export interface QAIssue {
  id: string;
  severity: QASeverity;
  title: string;
  message: string;
  /** Glyph chars or unicode hex strings this issue is about, for optional UI drill-down. */
  examples?: string[];
}

const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;
const MAX_CODEPOINT = 0x10ffff;

function isPUA(cp: number): boolean {
  return (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) || (cp >= 0x100000 && cp <= 0x10fffd);
}

/** Every (char, codepoint) pair a glyph actually claims — `unicode` plus any extras in `unicodes`. */
function* glyphCodepoints(glyphs: GlyphMap): Generator<{ char: string; cp: number }> {
  for (const [char, glyph] of Object.entries(glyphs)) {
    const seen = new Set<number>();
    const list = [glyph.unicode, ...(glyph.unicodes ?? [])];
    for (const cp of list) {
      if (cp == null || !Number.isFinite(cp) || seen.has(cp)) continue;
      seen.add(cp);
      yield { char, cp };
    }
  }
}

const BASIC_LATIN_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASIC_LATIN_LOWER = "abcdefghijklmnopqrstuvwxyz";
const BASIC_DIGITS = "0123456789";

function missingFromSet(glyphs: GlyphMap, chars: string): string[] {
  return [...chars].filter((c) => !glyphs[c] || glyphs[c].unicode == null);
}

/**
 * Validates the Unicode -> glyph mapping of a font project. This is
 * intentionally a standalone module (rather than folded into fontQA.ts)
 * so it can also be run on its own, e.g. from a dedicated "Unicode Map"
 * inspector view.
 */
export function validateUnicodeMapping(glyphs: GlyphMap): QAIssue[] {
  const issues: QAIssue[] = [];
  const byCodepoint = new Map<number, string[]>();
  let invalidCount = 0;
  let surrogateCount = 0;
  let puaCount = 0;
  let nonBmpCount = 0;
  const invalidExamples: string[] = [];
  const surrogateExamples: string[] = [];
  const puaExamples: string[] = [];

  for (const { char, cp } of glyphCodepoints(glyphs)) {
    if (!Number.isInteger(cp) || cp < 0 || cp > MAX_CODEPOINT) {
      invalidCount++;
      if (invalidExamples.length < 8) invalidExamples.push(`${char} (${cp})`);
      continue;
    }
    if (cp >= SURROGATE_MIN && cp <= SURROGATE_MAX) {
      surrogateCount++;
      if (surrogateExamples.length < 8) surrogateExamples.push(`${char} (${unicodeHex(cp)})`);
      continue;
    }
    if (isPUA(cp)) {
      puaCount++;
      if (puaExamples.length < 8) puaExamples.push(`${char} (${unicodeHex(cp)})`);
    }
    if (cp > 0xffff) nonBmpCount++;

    const list = byCodepoint.get(cp) ?? [];
    list.push(char);
    byCodepoint.set(cp, list);
  }

  // --- Invalid code points -------------------------------------------
  if (invalidCount > 0) {
    issues.push({
      id: "unicode.invalid-codepoint",
      severity: "error",
      title: "Code point tidak valid",
      message: `${invalidCount} glyph punya code point di luar rentang Unicode yang sah (0–10FFFF): ${invalidExamples.join(", ")}${invalidCount > invalidExamples.length ? ", …" : ""}.`,
      examples: invalidExamples,
    });
  }
  if (surrogateCount > 0) {
    issues.push({
      id: "unicode.surrogate-range",
      severity: "error",
      title: "Code point di rentang surrogate (D800–DFFF)",
      message: `${surrogateCount} glyph memetakan ke code point surrogate, yang tidak boleh dipakai langsung sebagai Unicode scalar value: ${surrogateExamples.join(", ")}${surrogateCount > surrogateExamples.length ? ", …" : ""}. Ini biasanya kesalahan input manual dan bakal ditolak validator manapun.`,
      examples: surrogateExamples,
    });
  }

  // --- Duplicate mapping -----------------------------------------------
  const duplicates = [...byCodepoint.entries()].filter(([, chars]) => chars.length > 1);
  if (duplicates.length > 0) {
    const examples = duplicates.slice(0, 6).map(([cp, chars]) => `${unicodeHex(cp)} → ${chars.join(", ")}`);
    issues.push({
      id: "unicode.duplicate-mapping",
      severity: "error",
      title: "Satu code point dipetakan ke lebih dari satu glyph",
      message: `${duplicates.length} code point dipakai oleh lebih dari satu glyph sekaligus, cmap font cuma bisa nunjuk ke satu glyph per code point — glyph yang belakangan akan menimpa yang lain saat export: ${examples.join("; ")}${duplicates.length > examples.length ? "; …" : ""}.`,
      examples: duplicates.map(([cp]) => unicodeHex(cp)),
    });
  } else {
    issues.push({
      id: "unicode.duplicate-mapping",
      severity: "pass",
      title: "Tidak ada code point yang bentrok",
      message: "Setiap code point yang dipakai hanya menunjuk ke satu glyph.",
    });
  }

  // --- Missing essential coverage --------------------------------------
  const hasSpace = glyphs[" "]?.unicode === 0x20 || Object.values(glyphs).some((g) => g.unicode === 0x20 || g.unicodes?.includes(0x20));
  if (!hasSpace) {
    issues.push({
      id: "unicode.missing-space",
      severity: "error",
      title: "Glyph spasi (U+0020) tidak ada",
      message: "Font tanpa glyph spasi ter-encode akan bikin word-spacing rusak/nge-bug di hampir semua software — termasuk salah satu pemicu umum penolakan review marketplace.",
    });
  }

  const missingUpper = missingFromSet(glyphs, BASIC_LATIN_UPPER);
  const missingLower = missingFromSet(glyphs, BASIC_LATIN_LOWER);
  const missingDigits = missingFromSet(glyphs, BASIC_DIGITS);
  const upperCoverage = BASIC_LATIN_UPPER.length - missingUpper.length;
  const lowerCoverage = BASIC_LATIN_LOWER.length - missingLower.length;

  // Only flag partial coverage — a font that has none of A-Z at all is
  // presumably not meant to be a Latin text font (icon/symbol set), so
  // silently skip rather than nag about a set the designer never intended.
  if (upperCoverage > 0 && missingUpper.length > 0) {
    issues.push({
      id: "unicode.partial-uppercase",
      severity: "warning",
      title: "Huruf besar A–Z belum lengkap",
      message: `${missingUpper.length} dari 26 huruf besar belum di-encode: ${missingUpper.join(", ")}.`,
      examples: missingUpper,
    });
  }
  if (lowerCoverage > 0 && missingLower.length > 0) {
    issues.push({
      id: "unicode.partial-lowercase",
      severity: "warning",
      title: "Huruf kecil a–z belum lengkap",
      message: `${missingLower.length} dari 26 huruf kecil belum di-encode: ${missingLower.join(", ")}.`,
      examples: missingLower,
    });
  }
  if ((upperCoverage > 0 || lowerCoverage > 0) && missingDigits.length > 0 && missingDigits.length < BASIC_DIGITS.length) {
    issues.push({
      id: "unicode.partial-digits",
      severity: "warning",
      title: "Angka 0–9 belum lengkap",
      message: `${missingDigits.length} dari 10 digit belum di-encode: ${missingDigits.join(", ")}.`,
      examples: missingDigits,
    });
  }

  // --- Component references --------------------------------------------
  const brokenComponents: string[] = [];
  for (const [char, glyph] of Object.entries(glyphs)) {
    for (const ref of glyph.components ?? []) {
      if (!glyphs[ref]) brokenComponents.push(`${char} → ${ref}`);
    }
  }
  if (brokenComponents.length > 0) {
    issues.push({
      id: "unicode.broken-component",
      severity: "error",
      title: "Referensi komponen glyph rusak",
      message: `${brokenComponents.length} glyph mereferensikan komponen yang tidak ada lagi di glyph set: ${brokenComponents.slice(0, 8).join(", ")}${brokenComponents.length > 8 ? ", …" : ""}. Ini bikin glyph itu gagal/blank saat export.`,
      examples: brokenComponents,
    });
  }

  // --- Informational: PUA / non-BMP ------------------------------------
  if (puaCount > 0) {
    issues.push({
      id: "unicode.pua-usage",
      severity: "info",
      title: "Memakai Private Use Area",
      message: `${puaCount} glyph memakai code point Private Use Area (mis. untuk ligature/alternate manual): ${puaExamples.join(", ")}${puaCount > puaExamples.length ? ", …" : ""}. Ini sah, tapi pastikan memang disengaja — PUA bukan karakter standar dan cuma bisa diakses lewat font ini.`,
      examples: puaExamples,
    });
  }
  if (nonBmpCount > 0) {
    issues.push({
      id: "unicode.non-bmp",
      severity: "info",
      title: `${nonBmpCount} glyph di luar Basic Multilingual Plane`,
      message: "Code point di atas U+FFFF butuh cmap format 12 (subtable Segmented Coverage) untuk terbaca — FontSeru sudah menuliskannya otomatis, tapi beberapa software lawas mungkin tetap tak mendukungnya.",
    });
  }

  return issues;
}
