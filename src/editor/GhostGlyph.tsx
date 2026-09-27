import { memo } from "react";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { hasOutline, type Glyph } from "@/types/glyph";
import { objectFillPath, objectStrokePath, contourToPath } from "./pathBuilder";

// U+0309 (combining hook above) and U+0323 (combining dot below) are the
// only two *true* zero-width Unicode combining marks FontSeru ever samples
// in isolation — every other mark slot (´ ` ¨ ¸ ˇ …) is a normal spacing
// character that any font/browser draws the same everywhere. A lone
// combining mark has no such guarantee: rendering it depends entirely on
// the *system font* the browser falls back to, which differs by platform
// (that's why the PC and iPad ghosts looked different in the first place),
// and some platforms don't draw it at all without a base character to
// attach to, or worse, draw a "missing glyph" placeholder for an
// unsupported combining sequence (the dotted box seen on iPad after a
// dotted-circle base was tried).
//
// The only way to get one identical, guaranteed result on every device is
// to stop asking the system font to shape these two marks at all, and draw
// them ourselves as plain SVG vector shapes — same path data, same pixels,
// on a Mac or an iPad or anywhere else.
const HOOK_ABOVE_MARK = "\u0309";
const DOT_BELOW_MARK = "\u0323";

/** Small stroked hook, drawn in a local -0.6…0.6 unit box (unit = size). */
function hookAbovePath(size: number): string {
  const s = size;
  return [
    `M ${0.05 * s} ${-0.55 * s}`,
    `C ${0.65 * s} ${-0.55 * s} ${0.65 * s} ${-0.05 * s} ${0.15 * s} ${0.05 * s}`,
    `C ${-0.3 * s} ${0.13 * s} ${-0.3 * s} ${0.48 * s} ${0.15 * s} ${0.5 * s}`,
  ].join(" ");
}

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

    // The two true combining marks bypass text rendering entirely — see
    // the note above HOOK_ABOVE_MARK — so the hand-drawn shape is the one
    // and only rendering, identical on every device, PC included.
    if (char === HOOK_ABOVE_MARK || char === DOT_BELOW_MARK) {
      const cx = laneOffsetX + boxCenterX + offsetX;
      const baselineY = ascender - offsetY;
      const sz = capHeight * 0.5 * scale;
      if (char === HOOK_ABOVE_MARK) {
        const centerY = baselineY - capHeight * 0.78 * scale;
        return (
          <path
            d={hookAbovePath(sz)}
            transform={`translate(${cx} ${centerY})`}
            fill="none"
            stroke="var(--text)"
            strokeWidth={sz * 0.22}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={opacity}
            style={{ pointerEvents: "none", userSelect: "none" }}
            aria-hidden="true"
          />
        );
      }
      const centerY = baselineY + capHeight * 0.12 * scale;
      return (
        <circle
          cx={cx}
          cy={centerY}
          r={capHeight * 0.09 * scale}
          fill="var(--text)"
          opacity={opacity}
          style={{ pointerEvents: "none", userSelect: "none" }}
          aria-hidden="true"
        />
      );
    }

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
});
