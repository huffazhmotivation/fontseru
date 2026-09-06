export type BrushType =
  | "round"
  | "monoline"
  | "marker"
  | "calligraphic"
  | "pencil"
  | "pressureTaper"
  | "rough"
  | "grunge"
  | "oilBrush"
  | "pixel"
  | "strong"
  | "outline";

export interface BrushSettings {
  type: BrushType;
  /** The single stroke width control. Real stylus pressure (when enabled)
   * scales DOWN from this value — Size is always the width at full press /
   * with pressure off, never a "max" the user tunes separately from a "min". */
  size: number;
  opacity: number;
  spacing: number;
  smoothing: number;
  /** Live pointer stabilization only; 0 keeps legacy direct capture, 1 applies strongest responsive smoothing. */
  stabilizer?: number;
  roundness: number;
  angle: number;
  taperStart: number;
  taperEnd: number;
  /** Whether REAL stylus pressure (Apple Pencil and other pen-type
   * pointers) is allowed to drive width at all. Mouse, trackpad, and touch
   * never read this — they always draw at a constant `size` regardless of
   * this flag (see stylusPressure()/pressureFor() in useBrushTool.ts). */
  pressureEnabled: boolean;
  /** 0..1: how strongly real stylus pressure narrows the stroke below
   * `size` when `pressureEnabled` is on. 0 = pressure has no visible
   * effect (always draws at Size); 1 = the lightest touch can thin the
   * stroke almost to nothing. Never applies to mouse/trackpad/touch. */
  pressureSensitivity: number;
  /** Width Profile "needle" mode for the start/end taper — see
   * taperFactor() in strokeToOutline.ts. When on, that end's taper ramps
   * all the way down to true ~0 width instead of stopping at a small
   * rounded floor, producing a genuinely sharp point. Independent of
   * pressure, and independent of the taperStart/taperEnd length sliders
   * (which still control how LONG the taper ramp is either way). */
  sharpStart?: boolean;
  sharpEnd?: boolean;
  /** 0 = clean edge (all existing presets). >0 = irregular, distressed edge amplitude as a fraction of size (Grunge, Oil Brush). */
  jitter?: number;
  /** Rough Brush only: roughly how many small counter-holes per 18 font units of stroke length — a dense, pitted scatter, not a sparse one (see roughBrushOutlineContours). */
  holeDensity?: number;
  /** Rough Brush only: hole radius as a fraction of the nib's half-width. Kept small on purpose. */
  holeSize?: number;
  /** When true, captured stroke points snap to the canvas grid as you draw (Pixel). */
  gridSnap?: boolean;
  /**
   * Pixel Brush only: the grid cell size (font units) baked in at draw time
   * from the canvas's current grid setting, so the outline is built from
   * true grid-cell blocks rather than the elliptical nib model. Isolated to
   * `gridSnap` — every other brush ignores this field entirely.
   */
  cellSize?: number;
  /** Outline Brush only: border thickness as a fraction of the nib's half-width. The interior stays hollow — see outlineBrushOutlineContours. */
  outlineThickness?: number;
  /** Pixel Brush only: "blocks" (default) keeps the original crisp grid-cell
   * squares; "liquid" instead walks those same cells as one connected path
   * and re-strokes it with a round pen, so grid turns flow into smooth,
   * fused joints — see pixelLiquidOutline. Isolated to `gridSnap`/pixel
   * brush the same way `cellSize` is. */
  pixelMode?: PixelRenderMode;
  /** Pixel Liquid mode only: how much extra width beyond the raw cell size
   * the round pen sweeps at. 0 = close to the plain grid size, so cells
   * still read as individual rounded blocks; 1 = noticeably chunkier and
   * more fused at every grid turn. Inert when `pixelMode` isn't "liquid". */
  pixelLiquidSmoothness?: number;
  /** Outline Brush only: how the two stroke ends are finished. "round"/"square"
   * both fully close the ring's tip into one joined end cap (a pill-shaped
   * bulge or a flat square-cornered cut, respectively); "open" instead keeps
   * the outer and inner border rails as two separate strips that are never
   * joined across the stroke width at either end, so the ends read as
   * genuinely open rather than capped off. See outlineBrushOutlineContours. */
  outlineCapStyle?: OutlineCapStyle;
}

/** See `BrushSettings.outlineCapStyle`. */
export type OutlineCapStyle = "round" | "square" | "open";

/** Pixel Brush only: how neighboring pixel blocks are rendered. "blocks" is
 * the original crisp grid-cell look (see pixelBlockOutline); "liquid"
 * re-strokes the same grid cells as one connected round-pen path instead,
 * so pixel-grid turns flow into smooth, fused joints rather than staying
 * separate hard-edged squares. See pixelLiquidOutline in strokeToOutline.ts. */
export type PixelRenderMode = "blocks" | "liquid";

export interface BrushPreset {
  id: BrushType;
  label: string;
  description: string;
  settings: Omit<BrushSettings, "type">;
}

export type { StrokeSample } from "./geometry";
