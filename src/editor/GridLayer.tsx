import { memo, useMemo } from "react";
import { gridPatternSpec, type GridShape } from "./gridGeometry";

interface Props {
  shape: GridShape;
  size: number;
  /** Screen px per font unit. */
  sc: number;
  ascender: number;
  vbX: number;
  vbY: number;
  vbW: number;
  vbH: number;
}

/**
 * Guideline grid covering the WHOLE visible canvas (not just the em box).
 *
 * Drawn as a single SVG <pattern> fill: the DOM cost is one <rect> no matter
 * how far you zoom or pan, and the browser tiles it natively — that is what
 * keeps panning/zooming instant even on a fine grid. The pattern is declared
 * in font space (Y-up) via `patternTransform`, the same space the Pixel brush
 * snaps in (see gridGeometry.ts), so painted cells land exactly on the lines.
 */
function GridLayerInner({ shape, size, sc, ascender, vbX, vbY, vbW, vbH }: Props) {
  const spec = useMemo(() => gridPatternSpec(shape, size), [shape, size]);
  // Lines closer than ~5px just read as a grey haze (and cost fill-rate).
  if (size * sc < 5) return null;
  return (
    <g pointerEvents="none" data-testid="canvas-grid" data-grid-shape={shape}>
      <defs>
        <pattern
          id="fontseru-grid-pattern"
          x={0}
          y={0}
          width={spec.width}
          height={spec.height}
          patternUnits="userSpaceOnUse"
          patternTransform={`translate(0 ${ascender}) scale(1 -1)`}
        >
          <path d={spec.d} className="grid-line" fill="none" />
        </pattern>
      </defs>
      <rect x={vbX} y={vbY} width={vbW} height={vbH} fill="url(#fontseru-grid-pattern)" />
    </g>
  );
}

export const GridLayer = memo(GridLayerInner);
