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
}

export interface BrushPreset {
  id: BrushType;
  label: string;
  description: string;
  settings: Omit<BrushSettings, "type">;
}

export type { StrokeSample } from "./geometry";
