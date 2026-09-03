/**
 * Kerning is intentionally kept out of the glyph geometry model
 * (types/geometry.ts) — it's a font-level adjustment between a pair of
 * glyphs, not part of either glyph's outline.
 */
export type KerningPairs = Record<string, number>;

/** Which pair keys were set by the user directly (vs by an auto-kern suggestion). Auto-kern must never overwrite these. */
export type KerningManualFlags = Record<string, boolean>;

import type { FontStyle } from "./glyph";

/**
 * Family kerning stays layered: `kerningPairs` is the shared layer and these
 * maps contain only style-specific differences. They are never materialized
 * into full per-style copies in persisted project state.
 */
export type KerningOverridesByStyle = Partial<Record<FontStyle, KerningPairs>>;
export type KerningOverrideManualByStyle = Partial<Record<FontStyle, KerningManualFlags>>;
export type KerningContext = "shared" | FontStyle;

/**
 * Word spacing follows the same Shared + sparse Style Override layering as
 * kerning above: `metrics.wordSpacing` is the shared/family value, and this
 * map holds only the styles that have explicitly diverged from it (e.g. a
 * Bold cut that needs a slightly wider space than Regular).
 */
export type WordSpacingOverridesByStyle = Partial<Record<FontStyle, number>>;

export function effectiveWordSpacing(
  shared: number | undefined,
  overridesByStyle: WordSpacingOverridesByStyle,
  style: FontStyle
): number | undefined {
  return overridesByStyle[style] ?? shared;
}

export function effectiveKerningValue(
  shared: KerningPairs,
  overridesByStyle: KerningOverridesByStyle,
  style: FontStyle,
  left: string,
  right: string
): number {
  const key = kerningKey(left, right);
  return overridesByStyle[style]?.[key] ?? shared[key] ?? 0;
}

/**
 * Runtime-only merged view for layout/preview. The persisted model remains
 * Shared + sparse Style Override layers.
 */
export function effectiveKerningPairs(
  shared: KerningPairs,
  overridesByStyle: KerningOverridesByStyle,
  style: FontStyle
): KerningPairs {
  const override = overridesByStyle[style];
  return override && Object.keys(override).length ? { ...shared, ...override } : shared;
}

export function kerningKey(left: string, right: string): string {
  // URI-encoding keeps the legacy "A|V" form for ordinary glyphs while
  // making pairs containing the literal "|" glyph unambiguous.
  return `${encodeURIComponent(left)}|${encodeURIComponent(right)}`;
}

/** Inverse of `kerningKey` — recovers the [left, right] chars from a pair key. */
export function decodeKerningKey(key: string): [string, string] {
  const sep = key.indexOf("|");
  if (sep === -1) return [key, ""];
  return [decodeURIComponent(key.slice(0, sep)), decodeURIComponent(key.slice(sep + 1))];
}

export function parseKerningKey(key: string): { left: string; right: string } | null {
  const idx = key.indexOf("|");
  if (idx <= 0 || idx === key.length - 1) return null;
  try {
    return { left: decodeURIComponent(key.slice(0, idx)), right: decodeURIComponent(key.slice(idx + 1)) };
  } catch {
    return null;
  }
}

/**
 * Kerning Classes (a.k.a. kerning groups) let a font builder set ONE value
 * that applies to many glyph pairs at once — the "pro" workflow used by
 * tools like Glyphs/FontLab, where e.g. every round letter (O, Q, C, G, D)
 * shares the same behavior against every diagonal letter (A, V, W, Y).
 *
 * FontSeru keeps this additive rather than replacing the existing flat
 * `KerningPairs` model: a class is just a named group of glyphs on one
 * "side" of a pair, and a class-pair value is *materialized* (flattened)
 * into ordinary `KerningPairs` entries the moment it's set — every member
 * combination gets written, unless a specific pair is already flagged
 * `manual` (hand-tuned pairs are never overwritten, exactly like the
 * existing global Auto Kerning pass already guarantees). Because of this,
 * every existing consumer of `kerningPairs` (rendering, export, Test Lab,
 * Auto Word Spacing, …) keeps working unmodified — classes are a
 * bulk-editing convenience layered on top, not a second kerning engine.
 *
 * `side: "left"` = groups glyphs by how they behave as the FIRST (left)
 * glyph of a pair (grouped by shape of their own right edge).
 * `side: "right"` = groups glyphs by how they behave as the SECOND (right)
 * glyph of a pair (grouped by shape of their own left edge).
 * A glyph belongs to at most one class per side — matching how every
 * professional kerning-class tool works, and what keeps "which value wins"
 * unambiguous.
 */
export interface KerningClass {
  id: string;
  name: string;
  side: "left" | "right";
  members: string[];
  /** True for classes produced by Auto-Generate Groups; false once the user
   * creates a class by hand or renames an auto one. Purely informational —
   * used to label the class in the UI, never to restrict editing. */
  auto: boolean;
}

export interface KerningClasses {
  left: KerningClass[];
  right: KerningClass[];
}

export const EMPTY_KERNING_CLASSES: KerningClasses = { left: [], right: [] };

/** Key for a class-pair kerning value, kept visually distinct from
 * `kerningKey`'s glyph-pair keys (which never contain "::"). */
export function classPairKey(leftClassId: string, rightClassId: string): string {
  return `${leftClassId}::${rightClassId}`;
}

export function decodeClassPairKey(key: string): [string, string] | null {
  const sep = key.indexOf("::");
  if (sep === -1) return null;
  return [key.slice(0, sep), key.slice(sep + 2)];
}

export function findKerningClass(classes: KerningClass[], ch: string): KerningClass | undefined {
  return classes.find((c) => c.members.includes(ch));
}

/** Useful pair shortcuts for the Kerning panel. Global auto-kerning is not limited to this list. */
export const AUTO_KERN_PRIORITY_PAIRS: [string, string][] = [
  ["A", "V"], ["V", "A"],
  ["A", "W"], ["W", "A"],
  ["A", "Y"], ["Y", "A"],
  ["A", "T"], ["T", "A"],
  ["T", "o"], ["T", "a"], ["T", "e"], ["T", "y"],
  ["Y", "o"],
  ["L", "T"], ["L", "Y"], ["L", "V"],
  ["F", "A"], ["P", "A"],
  ["R", "A"], ["R", "T"],
  ["K", "O"], ["O", "O"],
];
