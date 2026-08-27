import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { hasOutline, type Glyph } from "@/types/glyph";
import { objectFillPath, objectStrokePath, contourToPath } from "./pathBuilder";

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
  /** Horizontal center of the *active* glyph's own standard advance box
   * (i.e. the box the working glyph is actually drawn in — lsb to
   * advance-rsb — not the full upm square). "sample" and "image" modes
   * don't have real outline geometry to anchor to, so they center on this
   * instead of the em square, keeping the ghost lined up with where the
   * glyph's ink is meant to sit per FontSeru's standard sidebearing
   * metrics (the same ones LSB/RSB/Advance already default to). Falls back
   * to the em-square center (upm * 0.5) when not provided. "family" mode
   * doesn't need this: it overlays real outline coordinates that are
   * already positioned correctly in the same canvas space. */
  centerX?: number;
  /** "image" mode only: total em height (ascender-descender), used to size
   * the uploaded reference image relative to the glyph box. */
  totalH?: number;
  /** "image" mode only: data URL of the uploaded custom ghost image. */
  imageSrc?: string | null;
  /** "image" mode only: natural width/height ratio of the uploaded image,
   * used to keep it from stretching. Falls back to a square box. */
  imageAspect?: number;
}

/**
 * Non-interactive reference glyph used by FontSeru's ghost modes.
 *
 * sample: restores the original built-in sans reference character.
 * family: renders only saved vector geometry from another family style.
 * image: renders a user-uploaded reference image, purely as a backdrop —
 * it is never part of the glyph/vector data.
 *
 * Family ghosts deliberately have no fallback. If the matching style glyph
 * has no outline yet, that side stays empty.
 */
export function GhostGlyph({
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
    // Sample mode renders a single reference character. Feature-Builder
    // glyphs (ligatures, alternates, swashes) use their multi-character
    // rule key (e.g. "C.swash", "f_i") as `char`, which has no natural
    // single-glyph sample to reference — rendering it as text would draw
    // the whole string at glyph-sized type and blow far past the canvas.
    // Bail out rather than let that happen.
    if (Array.from(char).length !== 1) return null;
    return (
      <text
        x={laneOffsetX + boxCenterX + offsetX}
        y={ascender - offsetY}
        textAnchor="middle"
        fontFamily="'Inter', system-ui, sans-serif"
        fontWeight={600}
        fontSize={capHeight * 1.36 * scale}
        fill="var(--text)"
        opacity={opacity}
        style={{ pointerEvents: "none", userSelect: "none" }}
        aria-hidden="true"
      >
        {char}
      </text>
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
          <path
            key={obj.id}
            d={objectFillPath(obj, ascender)}
            fill="currentColor"
            fillRule="nonzero"
          />
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
}
