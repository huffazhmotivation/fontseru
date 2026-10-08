import type { VectorObject } from "@/types/geometry";

/**
 * Live preview of a Select-tool move / resize / rotate / skew drag.
 *
 * The Select tool still writes the exact transformed geometry into
 * `liveOutline` every frame (that's what gets committed, and what other
 * consumers such as the Multi Glyph canvas render). On top of that it
 * publishes this description so the single-glyph canvas can render the
 * dragged objects as their UNCHANGED base objects wrapped in an SVG
 * transform — keeping object identity stable for the whole gesture, so
 * memoized paths and the brush-outline cache are not rebuilt on every
 * pointer frame. Only objects whose rendering is exactly affine-equivariant
 * under the drag (see `transformPreviewIsExact`) take that shortcut; every
 * other object is rendered from the live geometry as before, so what's on
 * screen during the drag always matches what gets committed on release.
 */
export type TransformPreviewKind = "move" | "resize" | "rotate" | "skew";

/** Font-space (Y-up) affine [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = [number, number, number, number, number, number];

export interface TransformPreview {
  kind: TransformPreviewKind;
  /** Objects of the drag's base outline (stable identities for the whole gesture). */
  baseObjects: VectorObject[];
  /** Ids being transformed this gesture. */
  ids: Set<string>;
  matrix: Affine;
}

/** Converts a font-space affine into an SVG `matrix(...)` for the canvas's
 *  Y-down coordinates (svgY = ascender − fontY). */
export function affineToSvgMatrix(m: Affine, ascender: number): string {
  const [a, b, c, d, e, f] = m;
  const A = a;
  const B = -b;
  const C = -c;
  const D = d;
  const E = c * ascender + e;
  const F = ascender - d * ascender - f;
  return `matrix(${A} ${B} ${C} ${D} ${E} ${F})`;
}

/**
 * Whether rendering `obj` with an SVG transform is pixel-equivalent to
 * re-rendering the transformed geometry that will actually be committed.
 *
 * - Filled shapes (shape/expanded): Bézier outlines are affine-invariant,
 *   so every transform is exact.
 * - Uniform strokes (line, monoline brush): only rigid motions keep the
 *   stroke width (move, rotate); scale/skew change it differently from how
 *   scaleObject/skewObject do, so those re-render from live geometry.
 * - Variable-width brushes: re-expanded from their centerline, which is
 *   translation-invariant only (nib angle, taper widths etc. don't rotate or
 *   scale with an SVG transform). Some brushes are not even translation-
 *   invariant: Pixel snaps to the absolute grid, Spray seeds its specks from
 *   the stroke's absolute start point, Grunge buckets features on an
 *   absolute occupancy grid, and Outline participates in the canvas-wide
 *   boolean merge — those always render from live geometry.
 */
const NON_TRANSLATION_INVARIANT_BRUSHES = new Set(["pixel", "outline", "sprayBrush", "grunge"]);

export function transformPreviewIsExact(obj: VectorObject, kind: TransformPreviewKind): boolean {
  if (obj.kind === "shape" || obj.kind === "expanded") return true;
  const uniformStroke = obj.kind === "line" || (obj.kind === "brush" && obj.brushType === "monoline");
  if (uniformStroke) return kind === "move" || kind === "rotate";
  if (obj.kind === "brush") {
    const settingsType = obj.brushSettings?.type;
    if (!obj.brushType || NON_TRANSLATION_INVARIANT_BRUSHES.has(obj.brushType)) return false;
    if (settingsType && (settingsType === "monoline" || NON_TRANSLATION_INVARIANT_BRUSHES.has(settingsType))) return false;
    if (obj.brushSettings?.gridSnap) return false;
    return kind === "move";
  }
  return false;
}
