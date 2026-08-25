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
  size: number;
  minSize: number;
  maxSize: number;
  opacity: number;
  spacing: number;
  smoothing: number;
  /** Live pointer stabilization only; 0 keeps legacy direct capture, 1 applies strongest responsive smoothing. */
  stabilizer?: number;
  roundness: number;
  angle: number;
  taperStart: number;
  taperEnd: number;
  pressureEnabled: boolean;
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
