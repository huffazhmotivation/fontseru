import { memo } from "react";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { hasOutline, type Glyph } from "@/types/glyph";
import { objectFillPath, objectStrokePath, contourToPath } from "./pathBuilder";
import { ghostOutlineFor, useGhostFont } from "./ghostFont";

interface GhostGlyphProps {
  mode: "sample" | "family" | "image";
  char: string;
  glyph?: Glyph;
  ascender: number;
  capHeight: number;
  upm: number;
  opacity: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  laneOffsetX?: number;
  centerX?: number;
  totalH?: number;
  imageSrc?: string | null;
  imageAspect?: number;
}

<<<<<<< HEAD
/**
 * Non-interactive reference glyph used by FontSeru's ghost modes.
 *
 * sample: the character's real vector outline from the embedded reference
 * font (Noto Sans, OFL) — drawn as <path>, never as browser <text>, so it
 * is identical on every device (see ghostFont.ts).
 * family: renders only saved vector geometry from another family style.
 * image: renders a user-uploaded reference image, purely as a backdrop —
 * it is never part of the glyph/vector data.
 *
 * Family ghosts deliberately have no fallback. If the matching style glyph
 * has no outline yet, that side stays empty.
 */
=======
>>>>>>> 36d078b61b138f8ca6523681a7e18338402097da
export const GhostGlyph = memo(function GhostGlyph({
  mode,
  char,
  glyph,
  ascender,
  capHeight,
  upm,
  opacity,
  scale,
  offsetX,
  offsetY,
  laneOffsetX = 0,
  centerX,
  totalH,
  imageSrc,
  imageAspect,
}: GhostGlyphProps) {
<<<<<<< HEAD
  // Always called (hooks can't sit behind the early returns below). Only
  // the "sample" mode actually uses it; the font loads lazily on first use.
  const refFont = useGhostFont();
=======
  const ghostFont = useGhostFont("regular");

>>>>>>> 36d078b61b138f8ca6523681a7e18338402097da
  if (opacity <= 0) return null;

  const boxCenterX = centerX ?? upm * 0.5;

  if (mode === "image") {
    if (!imageSrc) return null;
    const boxH = (totalH ?? ascender) * scale;
    const boxW = imageAspect && imageAspect > 0 ? boxH * imageAspect : boxH;
    const cx = laneOffsetX + boxCenterX + offsetX;
    const cy = (totalH ?? ascender) / 2 - offsetY;
    return (
      <image
        href={imageSrc}
        x={cx - boxW / 2}
        y={cy - boxH / 2}
        width={boxW}
        height={boxH}
        opacity={opacity}
        preserveAspectRatio="xMidYMid meet"
        style={{ pointerEvents: "none", userSelect: "none" }}
        aria-hidden="true"
      />
    );
  }

  if (mode === "sample") {
<<<<<<< HEAD
    const ref = ghostOutlineFor(refFont, char);
    if (!ref) return null;
    // Size the reference so ITS cap height lands on the project's cap
    // height — the professional convention for a background/reference
    // layer (the same thing Glyphs/FontLab do when you drop a reference
    // font behind a glyph), so x-height, ascenders and accents all sit in
    // proportion instead of just "roughly the right size". The user's
    // Ghost Scale then zooms around the baseline centre, exactly like the
    // old text ghost did, so existing Scale/Offset settings keep meaning.
    const fit = (capHeight > 0 ? capHeight : upm * 0.7) / ref.capHeight;
    const k = fit * scale;
=======
    if (Array.from(char).length !== 1) return null;
    if (!ghostFont) return null;
    const outline = outlineForChar(ghostFont, char, capHeight * GHOST_FONT_SIZE_SCALE * scale);
    if (!outline) return null;

>>>>>>> 36d078b61b138f8ca6523681a7e18338402097da
    const anchorX = laneOffsetX + boxCenterX + offsetX;
    const anchorY = ascender - offsetY; // baseline in canvas space
    return (
      <g
        transform={`translate(${anchorX} ${anchorY}) scale(${k}) translate(${-ref.centerX} 0)`}
        opacity={opacity}
        color="var(--text)"
        style={{ pointerEvents: "none", userSelect: "none" }}
        aria-hidden="true"
        data-ghost-source="noto-sans"
      >
        {/* Soft fill so the letter reads as a mass, plus a 1-device-pixel
            hairline contour (non-scaling, so it stays crisp at every zoom
            and on every pixel density) so the actual edge you trace to is
            unambiguous — the standard reference-layer look. */}
        <path
          d={ref.d}
          fill="currentColor"
          fillOpacity={0.6}
          fillRule="nonzero"
          stroke="currentColor"
          strokeOpacity={0.9}
          strokeWidth={1}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          shapeRendering="geometricPrecision"
        />
      </g>
    );
  }

  if (!glyph || !hasOutline(glyph)) return null;

  const anchorX = laneOffsetX + upm * 0.5 + offsetX;
  const anchorY = ascender - offsetY;
  const transform = `translate(${anchorX} ${anchorY}) scale(${scale}) translate(${-upm * 0.5} ${-ascender})`;

  return (
    <g
      transform={transform}
      opacity={opacity}
      color="var(--ink)"
      style={{ pointerEvents: "none", userSelect: "none" }}
      aria-hidden="true"
    >
      {glyph.outline.objects.map((obj) =>
        obj.kind === "shape" || obj.kind === "expanded" ? (
          <path key={obj.id} d={objectFillPath(obj, ascender)} fill="currentColor" fillRule="nonzero" />
        ) : obj.kind === "brush" && obj.brushType !== "monoline" ? (
          <path
            key={obj.id}
            d={brushOutlineContours(obj).map((c) => contourToPath(c, ascender)).join(" ")}
            fill="currentColor"
            fillRule="nonzero"
          />
        ) : (
          <path
            key={obj.id}
            d={objectStrokePath(obj, ascender)}
            fill="none"
            stroke="currentColor"
            strokeWidth={obj.strokeWidth ?? 20}
            strokeLinecap={obj.cap ?? "round"}
            strokeLinejoin={obj.join ?? "round"}
          />
        )
      )}
    </g>
  );
});
