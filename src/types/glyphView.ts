/**
 * Multi Glyph Canvas (Glyph Overview) — shared types.
 *
 * Deliberately tiny and dependency-light: this file is imported by the
 * store, the overview renderer, and the toolbar, so it must not pull in
 * React or any editor module. It carries NO glyph data of its own — the
 * overview reads the exact same `glyphs` map the single-glyph editor
 * reads (see store's `glyphs` / `glyphsByStyle`), so there is only ever
 * one copy of a glyph's outline in the app.
 */

/**
 * Which editor surface the canvas area is showing.
 *  - "single"  the pre-existing per-glyph node/bezier editor (GlyphCanvas)
 *  - "multi"   the new grid overview (GlyphOverviewCanvas)
 * Defaults to "single" everywhere so nothing about the existing editing
 * flow changes until the user explicitly switches.
 */
export type EditorMode = "single" | "multi";

/** Built-in overview filters. `custom` renders only the glyphs currently
 *  multi-selected (the same `selectedGlyphChars` list GlyphNav already
 *  uses), and `drawn` renders every glyph that actually has an outline —
 *  the "daftar glyph jadi" that fills itself in as you draw. */
export type GlyphFilterId =
  | "all"
  | "upper"
  | "lower"
  | "digits"
  | "punct"
  | "symbols"
  | "drawn"
  | "custom";

export interface GlyphFilterOption {
  id: GlyphFilterId;
  label: string;
}

export const GLYPH_FILTERS: ReadonlyArray<GlyphFilterOption> = [
  { id: "all", label: "All Glyphs" },
  { id: "upper", label: "Uppercase" },
  { id: "lower", label: "Lowercase" },
  { id: "digits", label: "Numbers" },
  { id: "punct", label: "Punctuation" },
  { id: "symbols", label: "Symbols" },
  { id: "drawn", label: "Glyph Jadi" },
  { id: "custom", label: "Custom" },
];

/** Overview view state. Kept separate from the single-glyph editor's own
 *  `zoom`/`pan` on purpose: switching Single ⇄ Multi must never disturb
 *  the position/zoom the user had dialled in on the other surface. */
export interface OverviewView {
  /** Tile scale, percent. 100 = the default ~132px tile. */
  zoom: number;
  /** Scroll offset of the grid, in CSS pixels (x is usually 0 since the
   *  grid wraps to fit the width; kept for completeness/pan support). */
  scroll: { x: number; y: number };
}

export const OVERVIEW_ZOOM_MIN = 30;
export const OVERVIEW_ZOOM_MAX = 400;
/** Tile edge length in CSS pixels at zoom = 100%. */
export const OVERVIEW_BASE_TILE_PX = 132;
/** Spacing slider range, expressed as a fraction of the tile size. */
export const OVERVIEW_SPACING_MIN = 0;
export const OVERVIEW_SPACING_MAX = 60;

export function clampOverviewZoom(z: number): number {
  if (!Number.isFinite(z)) return 100;
  return Math.min(OVERVIEW_ZOOM_MAX, Math.max(OVERVIEW_ZOOM_MIN, Math.round(z)));
}

export function clampOverviewSpacing(s: number): number {
  if (!Number.isFinite(s)) return 14;
  return Math.min(OVERVIEW_SPACING_MAX, Math.max(OVERVIEW_SPACING_MIN, Math.round(s)));
}
