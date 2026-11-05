/**
 * OpenType Feature Builder — data model only.
 *
 * This is purely additive project data, stored alongside (never inside)
 * the existing glyph/kerning state. Every rule references glyphs by their
 * existing GlyphMap key (the same string already used everywhere else in
 * the app as `glyph.char`), so nothing about how glyphs are stored,
 * rendered, or edited changes. At export time (see utils/fontIO.ts) these
 * rules are compiled into a standard GSUB table; any rule whose glyphs
 * aren't present in a given style's GlyphMap is silently skipped for that
 * style's export, the same "never break the base font" philosophy already
 * used for kerning export.
 */

/** A GlyphMap key — an existing glyph's `char`, e.g. "r", "a", or a
 * Feature-Builder-created glyph like "a.alt1" / "re". */
export type FeatureGlyphRef = string;

export interface LigatureRule {
  id: string;
  /** Ordered component glyphs, e.g. ["r", "e"] for the "re" ligature. */
  components: FeatureGlyphRef[];
  /** The single glyph the components are replaced with. */
  target: FeatureGlyphRef;
  /** OpenType feature tag; absent means "liga". Other choices: "dlig", "clig", "rlig". */
  feature?: string;
}

export interface AlternateRule {
  id: string;
  /** The glyph the alternates apply to, e.g. "a". */
  base: FeatureGlyphRef;
  /** One or more alternate glyphs, e.g. ["a.alt1", "a.alt2"]. */
  alternates: FeatureGlyphRef[];
}

export interface SwashRule {
  id: string;
  /** The glyph the swash applies to, e.g. "A". */
  base: FeatureGlyphRef;
  /** The swash glyph, e.g. "A.swash". */
  swash: FeatureGlyphRef;
}

/**
 * One-to-one glyph substitution under any feature tag — small caps (smcp,
 * c2sc), figures (onum, lnum, pnum, tnum, zero), case (case), superior/
 * inferior (sups, subs), stylistic sets (ss01–ss20) and contextual
 * alternates (calt). When `before` and/or `after` is set the substitution
 * only applies with that glyph immediately before/after `from`.
 */
export interface SubstitutionRule {
  id: string;
  /** OpenType feature tag, e.g. "smcp", "ss01", "calt". */
  feature: string;
  from: FeatureGlyphRef;
  to: FeatureGlyphRef;
  before?: FeatureGlyphRef;
  after?: FeatureGlyphRef;
}

/** Feature tags offered in the UI (any valid 4-character tag is also accepted). */
export const SUBSTITUTION_FEATURES: { tag: string; label: string }[] = [
  { tag: "smcp", label: "smcp — Small caps" },
  { tag: "c2sc", label: "c2sc — Capitals to small caps" },
  { tag: "onum", label: "onum — Oldstyle figures" },
  { tag: "lnum", label: "lnum — Lining figures" },
  { tag: "pnum", label: "pnum — Proportional figures" },
  { tag: "tnum", label: "tnum — Tabular figures" },
  { tag: "zero", label: "zero — Slashed zero" },
  { tag: "case", label: "case — Case-sensitive forms" },
  { tag: "sups", label: "sups — Superscript" },
  { tag: "subs", label: "subs — Subscript" },
  { tag: "calt", label: "calt — Contextual alternates" },
  ...Array.from({ length: 20 }, (_, i) => {
    const tag = `ss${String(i + 1).padStart(2, "0")}`;
    return { tag, label: `${tag} — Stylistic set ${i + 1}` };
  }),
];

export const LIGATURE_FEATURES = ["liga", "dlig", "clig", "rlig"] as const;

/** Valid OpenType tag: 4 printable ASCII characters (we also forbid spaces for simplicity). */
export function isValidFeatureTag(tag: string): boolean {
  return /^[A-Za-z0-9]{4}$/.test(tag);
}

export interface FeatureBuilderConfig {
  ligatures: LigatureRule[];
  alternates: AlternateRule[];
  swashes: SwashRule[];
  /** Optional so older saved projects (without it) keep loading unchanged. */
  substitutions?: SubstitutionRule[];
}

export function emptyFeatureConfig(): FeatureBuilderConfig {
  return { ligatures: [], alternates: [], swashes: [] };
}

/** True when the config has no rules at all — used to skip GSUB generation
 * entirely on export so fonts with no Feature Builder use are unaffected. */
export function isFeatureConfigEmpty(config: FeatureBuilderConfig | null | undefined): boolean {
  if (!config) return true;
  return config.ligatures.length === 0 && config.alternates.length === 0 && config.swashes.length === 0 && (config.substitutions?.length ?? 0) === 0;
}

let ruleIdCounter = 0;
export function nextFeatureRuleId(prefix: string): string {
  ruleIdCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${ruleIdCounter}`;
}

/**
 * Suggests a default glyph name for a new ligature/alternate/swash target,
 * following common OpenType glyph-naming conventions. Purely a UI
 * convenience — the user can freely edit the suggested name before
 * creating the glyph.
 */
export function suggestLigatureName(components: FeatureGlyphRef[]): string {
  return components.join("_");
}
export function suggestAlternateName(base: FeatureGlyphRef, index: number): string {
  return `${base}.alt${index}`;
}
export function suggestSwashName(base: FeatureGlyphRef): string {
  return `${base}.swash`;
}
