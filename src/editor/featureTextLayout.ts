import { hasOutline, type GlyphMap } from "@/types/glyph";
import type { FeatureBuilderConfig } from "@/types/opentypeFeatures";
import { kerningKey } from "@/types/kerning";
import { fallbackAdvance } from "./textLayout";

export interface FeatureToggles {
  ligatures: boolean;
  alternates: boolean;
  swashes: boolean;
}

export const ALL_FEATURE_TOGGLES: FeatureToggles = { ligatures: true, alternates: true, swashes: true };

interface RawToken {
  /** The glyph-map key actually rendered — a rule's target/alternate/swash
   * glyph when a rule matched, otherwise the same as `source`. */
  token: string;
  /** The literal character(s) typed that produced this token. */
  source: string;
}

/**
 * Turns typed text into a sequence of glyph-map keys with Feature Builder
 * rules applied — a preview-quality stand-in for the GSUB substitution the
 * real exported font performs, so a word or sentence can be tried in
 * context instead of only browsing rules one at a time.
 *
 * - Ligatures: longest-match-first, e.g. "ffi" prefers a 3-component rule
 *   over a 2-component one covering just "ff".
 * - Alternates / Swashes: every occurrence of the rule's base glyph is
 *   swapped for its (first) alternate / its swash glyph when that toggle
 *   is on. Real typesetting applies these more selectively (a chosen
 *   alternate, a swash at a word boundary); this is a quick "what does it
 *   look like" preview, not a shaping engine.
 *
 * A rule is only ever applied if its replacement glyph actually has a
 * drawn outline — an empty target would silently blank out letters, which
 * is worse than just leaving the typed text alone.
 */
export function applyFeatureSubstitution(
  text: string,
  glyphs: GlyphMap,
  featureConfig: FeatureBuilderConfig,
  toggles: FeatureToggles
): RawToken[] {
  const chars = Array.from(text);
  const out: RawToken[] = [];

  const ligatureRules = toggles.ligatures
    ? featureConfig.ligatures
        .filter((r) => r.components.length > 1 && glyphs[r.target] && hasOutline(glyphs[r.target]!))
        .slice()
        .sort((a, b) => b.components.length - a.components.length)
    : [];
  const alternateMap = toggles.alternates
    ? new Map(
        featureConfig.alternates
          .filter((r) => r.alternates[0] && glyphs[r.alternates[0]] && hasOutline(glyphs[r.alternates[0]]!))
          .map((r) => [r.base, r.alternates[0]] as const)
      )
    : new Map<string, string>();
  const swashMap = toggles.swashes
    ? new Map(
        featureConfig.swashes
          .filter((r) => glyphs[r.swash] && hasOutline(glyphs[r.swash]!))
          .map((r) => [r.base, r.swash] as const)
      )
    : new Map<string, string>();

  let i = 0;
  outer: while (i < chars.length) {
    for (const rule of ligatureRules) {
      const n = rule.components.length;
      if (i + n <= chars.length && rule.components.every((c, k) => chars[i + k] === c)) {
        out.push({ token: rule.target, source: chars.slice(i, i + n).join("") });
        i += n;
        continue outer;
      }
    }

    const ch = chars[i];
    const chosen = swashMap.get(ch) ?? alternateMap.get(ch) ?? ch;
    out.push({ token: chosen, source: ch });
    i += 1;
  }

  return out;
}

export interface PlacedToken {
  token: string;
  source: string;
  x: number;
  advance: number;
  /** True when this position's rendered glyph differs from a plain typed
   * character — used to highlight the substitution in the preview. */
  substituted: boolean;
}

export interface TokenLineLayout {
  placed: PlacedToken[];
  totalAdvance: number;
}

/** Same pen-advance + pair-kerning model as layoutLine, but for a
 * pre-substituted token sequence instead of a plain character string.
 * Pair kerning only applies between two adjacent *un-substituted* single
 * characters — a merged ligature or swapped alternate/swash glyph has its
 * own drawn sidebearings, so guessing a kerning value for it would be
 * more misleading than just leaving it at zero. */
export function layoutTokens(
  tokens: RawToken[],
  glyphs: GlyphMap,
  unitsPerEm: number,
  kerningPairs: Record<string, number>,
  trackingUnits = 0
): TokenLineLayout {
  let penX = 0;
  const placed: PlacedToken[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const { token, source } = tokens[i];
    if (i > 0) {
      penX += trackingUnits;
      const prev = tokens[i - 1];
      const bothPlain = prev.token === prev.source && token === source && source.length === 1 && prev.source.length === 1;
      if (bothPlain) {
        penX += kerningPairs[kerningKey(prev.source, source)] ?? 0;
      }
    }

    const g = glyphs[token];
    const advance = g ? g.advanceWidth : fallbackAdvance(source, unitsPerEm);
    placed.push({ token, source, x: penX, advance, substituted: token !== source });
    penX += advance;
  }

  return { placed, totalAdvance: penX };
}
