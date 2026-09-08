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
/** Recursively traces a ligature rule's INPUT component back to the literal
 * character(s) someone actually types. A component is normally just that
 * literal char (e.g. "f"), but Feature Builder's glyph pickers also let a
 * new ligature be built FROM an existing ligature glyph — e.g. "f_f" (the
 * already-built "ff" ligature) as input to an "f_f + l → f_f_l" rule. That
 * component is a glyph-map KEY, not something that ever appears in typed
 * text, so matching it against `chars[i+k]` one raw character at a time
 * (as if every component were exactly one keystroke) can never succeed —
 * this is why a chained rule like that silently never fired. Expanding
 * every component down to its own root literal characters first (so the
 * "ffl" rule ends up matching the 3 literal chars "f","f","l", not the
 * 2-length ["f_f","l"] it was built from) fixes that without needing a
 * multi-pass/iterative substitution engine — a single left-to-right scan
 * over literal chars still works, just with the correct match length.
 * `depth` guards against a rule chain that loops back on itself. */
function resolveLigatureInputChars(
  component: string,
  allLigatureRules: FeatureBuilderConfig["ligatures"],
  depth = 0
): string[] {
  if (depth > 8) return [component];
  const sourceRule = allLigatureRules.find((r) => r.target === component);
  if (!sourceRule) return [component];
  return sourceRule.components.flatMap((c) => resolveLigatureInputChars(c, allLigatureRules, depth + 1));
}

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
        .map((r) => ({ target: r.target, literalChars: resolveLigatureInputChars(r.target, featureConfig.ligatures) }))
        // Longest literal match first, e.g. a chained "ffl" (3 literal
        // chars) must be tried before the plain "ff" (2) it was built
        // from, or "ff" would always win and "l" would just trail after it
        // unmerged.
        .sort((a, b) => b.literalChars.length - a.literalChars.length)
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
      const n = rule.literalChars.length;
      if (i + n <= chars.length && rule.literalChars.every((c, k) => chars[i + k] === c)) {
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
 * Kerning is looked up by the actual RENDERED glyph key (`token`), not the
 * literal typed character(s) that produced it — the same convention every
 * other kerning lookup in the app already follows (drag-to-kern in Test
 * Lab keys off the placed glyph, not the keystroke). That means a pair
 * kerning value set against a ligature/alternate/swash glyph's own
 * glyph-map key (e.g. the "ff" ligature target, or a swash "T") is honored
 * here too — set it once via Feature Builder's preview (drag a glyph left/
 * right, same gesture as the main Kerning Pairs tab) and it applies
 * wherever that glyph gets substituted in, not just when it's typed
 * literally. */
export function layoutTokens(
  tokens: RawToken[],
  glyphs: GlyphMap,
  unitsPerEm: number,
  kerningPairs: Record<string, number>,
  trackingUnits = 0,
  wordSpacing?: number
): TokenLineLayout {
  let penX = 0;
  const placed: PlacedToken[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const { token, source } = tokens[i];
    if (i > 0) {
      penX += trackingUnits;
      const prevToken = tokens[i - 1].token;
      penX += kerningPairs[kerningKey(prevToken, token)] ?? 0;
    }

    const g = glyphs[token];
    const advance = g ? g.advanceWidth : fallbackAdvance(source, unitsPerEm, wordSpacing);
    placed.push({ token, source, x: penX, advance, substituted: token !== source });
    penX += advance;
  }

  return { placed, totalAdvance: penX };
}
