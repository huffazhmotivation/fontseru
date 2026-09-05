import type { BrushPreset, BrushType } from "@/types/brush";

/**
 * All presets share one engine (`brushes/strokeToOutline.ts`). What makes
 * them behave differently is real geometry, not cosmetic labels:
 *  - `roundness` < 1 flattens the nib into an ellipse (marker/calligraphic).
 *  - `angle` fixes that ellipse's rotation, independent of stroke direction
 *    (a broad-nib calligraphy effect).
 *  - `pressureEnabled` + `pressureSensitivity` decide whether REAL stylus
 *    pressure narrows the stroke below `size` at all, and how strongly.
 *    Mouse/trackpad/touch never simulate pressure — those always draw at
 *    a constant `size` regardless of these two fields (see
 *    stylusPressure()/pressureFor() in useBrushTool.ts).
 *  - `taperStart`/`taperEnd` shrink the nib toward the stroke's ends
 *    regardless of pressure.
 */
export const BRUSH_PRESETS: Record<BrushType, BrushPreset> = {
  round: {
    id: "round",
    label: "Basic Round",
    description: "Circular nib, pressure-sensitive width.",
    settings: {
      size: 26,
      opacity: 1,
      spacing: 4,
      smoothing: 0.5,
      // Brush Stabilizer defaults on, moderate strength: smooths live
      // pointer position (mouse/stylus/pen, Normal + Sketch Mode alike)
      // without adding perceptible lag, and never touches pressure — see
      // smoothStroke()/pressureFor() in useBrushTool.ts and
      // brushes/strokeSmoothing.ts.
      stabilizer: 0.35,
      roundness: 1,
      angle: 0,
      taperStart: 0.15,
      taperEnd: 0.2,
      pressureEnabled: true,
      // A light stylus touch draws at ~30% of Size, a full press at 100%.
      // No effect at all on mouse/trackpad/touch — see pressureEnabled doc.
      pressureSensitivity: 0.7,
    },
  },
  monoline: {
    id: "monoline",
    label: "Monoline",
    description: "Constant width, no pressure response.",
    settings: {
      size: 18,
      opacity: 1,
      spacing: 4,
      smoothing: 0.3,
      stabilizer: 0.3,
      roundness: 1,
      angle: 0,
      taperStart: 0,
      taperEnd: 0,
      pressureEnabled: false,
      pressureSensitivity: 0,
    },
  },
  marker: {
    id: "marker",
    label: "Marker",
    description: "Broad, near-uniform felt-tip nib held at a shallow angle — soft directional width, not pressure.",
    settings: {
      size: 34,
      opacity: 0.88,
      spacing: 6,
      smoothing: 0.22,
      stabilizer: 0.3,
      // A wide, only mildly flattened ellipse: width stays fairly broad in
      // most directions, the way a chisel-tip marker reads on paper — the
      // opposite of Calligraphic's sharp, high-contrast nib below.
      roundness: 0.34,
      angle: 8,
      taperStart: 0,
      taperEnd: 0,
      pressureEnabled: false,
      pressureSensitivity: 0,
    },
  },
  calligraphic: {
    id: "calligraphic",
    label: "Calligraphic",
    description: "Thin, fixed-angle broad-edge pen nib — strong thick/thin contrast from stroke direction alone.",
    settings: {
      size: 30,
      opacity: 1,
      spacing: 4,
      smoothing: 0.4,
      stabilizer: 0.3,
      // A near-flat ellipse at the classic 45° broad-nib angle: strokes with
      // the pen swing thin, strokes across it go full width — dramatic
      // contrast that Marker deliberately avoids.
      roundness: 0.08,
      angle: 45,
      taperStart: 0.06,
      taperEnd: 0.06,
      pressureEnabled: false,
      pressureSensitivity: 0,
    },
  },
  pencil: {
    id: "pencil",
    label: "Pencil",
    description: "Thin graphite line with fine grain — subtle jitter and low smoothing keep the hand tremor.",
    settings: {
      size: 9,
      opacity: 0.82,
      spacing: 2,
      smoothing: 0.1,
      // Kept low relative to the other presets: Pencil's whole character is
      // the hand-tremor grain (jitter below), so only light stabilization
      // is applied to avoid smoothing that texture away.
      stabilizer: 0.15,
      roundness: 0.9,
      angle: 0,
      taperStart: 0.05,
      taperEnd: 0.05,
      pressureEnabled: true,
      pressureSensitivity: 0.65,
      // Fine, low-amplitude grain — a fraction of Grunge's jitter below —
      // reads as graphite texture rather than a rough distressed edge.
      jitter: 0.14,
    },
  },
  rough: {
    id: "rough",
    label: "Rough",
    description: "Near-constant-width line like Monoline, with a dense scatter of small pitted texture holes through the stroke's interior and a ragged, uneven grain along both edges.",
    settings: {
      size: 20,
      opacity: 1,
      spacing: 3,
      smoothing: 0.35,
      stabilizer: 0.3,
      roundness: 1,
      angle: 0,
      // Flat-cut ends, same as Monoline (taper 0) — a tapered point at the
      // start/finish read as a stray, out-of-place spike on an otherwise
      // constant-width stroke.
      taperStart: 0,
      taperEnd: 0,
      pressureEnabled: false,
      pressureSensitivity: 0,
      // Dense, heavily-varied scatter of counter-holes — see
      // roughBrushOutlineContours() in strokeToOutline.ts. Each is a real
      // vector counter (hole) per dot, not a raster texture, so it exports
      // cleanly into the font too. holeDensity drives how many holes per
      // unit of stroke length; holeSize is the baseline radius most of
      // them are scattered around before per-hole size variety skews some
      // smaller ("grit") and a few larger ("blotches").
      holeDensity: 2.6,
      holeSize: 0.15,
      // Fine, independent left/right edge grain (see the "rough" branch in
      // centerlineToOutline() in strokeToOutline.ts) — raised so the outer
      // edge itself reads as ragged/eroded, matching the pitted interior,
      // without going as far as Grunge's heavy spikes. Lower/0 for a
      // perfectly clean edge (holes only, the old look).
      jitter: 0.8,
    },
  },
  pressureTaper: {
    id: "pressureTaper",
    label: "Pressure Taper",
    description: "Wide dynamic range with strong tapered ends — brush-lettering swashes.",
    settings: {
      size: 34,
      opacity: 1,
      spacing: 3,
      smoothing: 0.6,
      stabilizer: 0.35,
      roundness: 1,
      angle: 0,
      taperStart: 0.4,
      taperEnd: 0.4,
      pressureEnabled: true,
      // High sensitivity: the lightest touch can thin the swash down close
      // to a hairline, matching this preset's "wide dynamic range" brief.
      pressureSensitivity: 0.9,
    },
  },
  grunge: {
    id: "grunge",
    label: "Grunge",
    description: "Rough, heavily distressed edge — still a real closed vector outline underneath, not a raster texture.",
    settings: {
      size: 38,
      opacity: 0.92,
      // Denser resampling than any other brush: more samples means more
      // high-frequency edge noise, which is what actually reads as "rough"
      // rather than a wobbly-but-smooth line.
      spacing: 1,
      smoothing: 0.04,
      // Kept low, same reasoning as Pencil: heavy live stabilization would
      // fight the deliberately noisy, distressed edge this brush is for.
      stabilizer: 0.1,
      roundness: 0.62,
      angle: 0,
      taperStart: 0.12,
      taperEnd: 0.18,
      pressureEnabled: true,
      pressureSensitivity: 0.65,
      jitter: 0.85,
    },
  },
  oilBrush: {
    id: "oilBrush",
    label: "Oil Brush",
    description: "Dry-brush drag: a smooth body with broad, torn scallops along the edge and frayed, breaking-up ends — like a loaded flat brush running low on paint.",
    settings: {
      size: 34,
      opacity: 1,
      spacing: 4,
      // Kept close to a normal brush (unlike Grunge's near-zero smoothing):
      // Oil Brush wants a clean, coherent stroke body — the ragged look
      // comes entirely from the wide, low-frequency edge waves added in
      // strokeToOutline.ts (oilEdgeOffset()), not from a noisy centerline.
      smoothing: 0.35,
      stabilizer: 0.3,
      // A mildly flattened nib, like a real chisel/flat brush held nearly
      // flat to the page rather than Calligraphic's sharp broad-edge pen.
      roundness: 0.85,
      angle: 0,
      // Stronger than any other preset's taper, especially at the end: this
      // is what makes the stroke visibly run out of paint/lift off, echoing
      // a dry-brush pass rather than a clean pen stroke.
      taperStart: 0.14,
      taperEnd: 0.24,
      pressureEnabled: false,
      pressureSensitivity: 0,
      // Amplitude for the coherent (non-jittery) torn-edge waves — see
      // oilEdgeOffset() in strokeToOutline.ts. Distinct from Grunge's jitter:
      // this is smoothly interpolated per-lobe noise, which reads as broad
      // torn scallops rather than fine spiky noise.
      jitter: 0.5,
    },
  },
  pixel: {
    id: "pixel",
    label: "Pixel",
    description: "True grid-cell blocks, not a smoothed line — the ONLY brush with grid snapping (see gridSnap docs).",
    settings: {
      size: 24,
      opacity: 1,
      spacing: 1,
      smoothing: 0,
      // No stabilizer here on purpose: useBrushTool's pixelSnap path grid-
      // snaps every point directly and skips the Stabilizer smoothing engine
      // entirely, so a value here would be inert anyway (see pointerDown/pointerMove).
      roundness: 1,
      angle: 0,
      taperStart: 0,
      taperEnd: 0,
      pressureEnabled: false,
      pressureSensitivity: 0,
      // The ONLY preset with gridSnap on. Its outline is built entirely
      // differently from every other brush — see pixelBlockOutline() in
      // strokeToOutline.ts — and switching to any other preset clears this
      // flag immediately (see setBrush() in glyph/store.ts).
      gridSnap: true,
    },
  },
  strong: {
    id: "strong",
    label: "Strong",
    description: "Bold, constant-width body whose ends fray into several sharp bristle-like teeth of varying height — a torn, dry-brush tip rather than one clean blade point.",
    settings: {
      size: 36,
      opacity: 1,
      spacing: 3,
      smoothing: 0.3,
      stabilizer: 0.3,
      // Circular nib (roundness 1) and no pressure response: unlike
      // Calligraphic/Marker, width doesn't vary with direction or hand
      // pressure — the ONLY things that shape the tips are the taper below
      // and the torn "comb" teeth added in centerlineToOutline().
      roundness: 1,
      angle: 0,
      // Short taper fraction (the shrink only happens in the last ~9% of
      // the stroke at each end) combined with the bold base size above is
      // what keeps the body reading as uniformly bold right up to where the
      // torn tip teeth take over.
      taperStart: 0.09,
      taperEnd: 0.09,
      pressureEnabled: false,
      pressureSensitivity: 0,
    },
  },
  outline: {
    id: "outline",
    label: "Outline",
    description: "Hollow ring cross-section — a constant-thickness border traces the stroke while the interior stays open, like drawing with a pen instead of filling with ink.",
    settings: {
      size: 40,
      opacity: 1,
      spacing: 4,
      smoothing: 0.3,
      stabilizer: 0.3,
      roundness: 1,
      angle: 0,
      // Flat, untapered ends: a tapered outline would pinch the border
      // shut right where it's most visible (the tip), instead of the
      // border wrapping cleanly all the way around.
      taperStart: 0,
      taperEnd: 0,
      pressureEnabled: false,
      pressureSensitivity: 0,
      // Outline Brush only — see outlineBrushOutlineContours() in
      // strokeToOutline.ts. Fraction of the nib's half-width used as the
      // border thickness; raise for a heavier border, lower for a finer
      // hairline ring.
      outlineThickness: 0.32,
    },
  },
};

export const BRUSH_ORDER: BrushType[] = [
  "monoline",
  "marker",
  "calligraphic",
  "pencil",
  "rough",
  "grunge",
  "oilBrush",
  "pixel",
  "strong",
  "outline",
];
