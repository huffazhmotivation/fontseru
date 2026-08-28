import type { GlyphMap } from "@/types/glyph";
import type { FontMetrics } from "@/types/font";
import { suggestKerningPair } from "@/kerning/autoKern";

export type KerningQuality = "tight" | "loose" | "good";

// How far (in font units) the current kerning value is allowed to sit from
// the optical auto-kern suggestion before it reads as "good". Wider than a
// single rounding step (autoKern snaps to multiples of 5) so a manually
// nudged pair doesn't flicker between good/not-good on tiny adjustments,
// narrow enough that a genuinely mis-kerned pair still stands out.
const GOOD_TOLERANCE_UNITS = 15;

/**
 * Compares a pair's live kerning value against what FontSeru's own optical
 * scanline analysis (see kerning/autoKern.ts) would suggest for those two
 * letterforms, and buckets the difference into three easy-to-scan states:
 *
 * - "tight"  — noticeably more negative than the suggestion (letters are
 *              crowding or colliding).
 * - "loose"  — noticeably more positive than the suggestion (an
 *              unintentionally wide gap).
 * - "good"   — close enough to the suggestion to read as intentional.
 *
 * Returns null when either glyph doesn't exist yet, so callers can simply
 * skip drawing an indicator for undrawn letters.
 */
export function classifyKerningPair(
  glyphs: GlyphMap,
  metrics: FontMetrics,
  left: string,
  right: string,
  currentValue: number
): KerningQuality | null {
  if (!glyphs[left] || !glyphs[right]) return null;
  const suggestion = suggestKerningPair(glyphs, metrics, left, right);
  const diff = currentValue - suggestion;
  if (Math.abs(diff) <= GOOD_TOLERANCE_UNITS) return "good";
  return diff < 0 ? "tight" : "loose";
}

/** Transparent traffic-light fill for a gap indicator, keyed by quality. */
export function kerningQualityColor(quality: KerningQuality): string {
  switch (quality) {
    case "tight":
      return "rgba(239, 68, 68, 0.4)"; // red — too close
    case "loose":
      return "rgba(249, 115, 22, 0.4)"; // orange — too far
    case "good":
      return "rgba(34, 197, 94, 0.32)"; // green — looks right
  }
}

export function kerningQualityLabel(quality: KerningQuality): string {
  switch (quality) {
    case "tight":
      return "Too tight";
    case "loose":
      return "Too loose";
    case "good":
      return "Looks good";
  }
}
