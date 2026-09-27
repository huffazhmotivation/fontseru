import { memo } from "react";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { hasOutline, type Glyph } from "@/types/glyph";
import { objectFillPath, objectStrokePath, contourToPath } from "./pathBuilder";

/**
 * Where a combining mark conventionally attaches relative to a base letter.
 * Only used to decide which side of the dotted-circle placeholder (below)
 * gets the little position hint — this is a coarse, hand-picked lookup over
 * the Combining Diacritical Marks block (U+0300–U+036F) plus a couple of
 * commonly-typed marks outside it (Vietnamese U+0323 dot-below lives inside
 * the block; U+0309 hook-above too). It does not need to be exhaustive or
 * Unicode-perfect: it only feeds a decorative preview, never real text
 * shaping or glyph data.
 */
const BELOW_MARKS = new Set(
  [
    0x0316, 0x0317, 0x0318, 0x0319, 0x031c, 0x031d, 0x031e, 0x031f, 0x0320,
    0x0323, 0x0324, 0x0325, 0x0326, 0x0327, 0x0328, 0x0329, 0x032a, 0x032b,
    0x032c, 0x032d, 0x032e, 0x032f, 0x0330, 0x0331, 0x0332, 0x0333, 0x0339,
    0x033a, 0x033b, 0x033c, 0x0347, 0x0348, 0x0349, 0x0353, 0x0354, 0x0355,
    0x0356,
  ].map((cp) => String.fromCodePoint(cp))
);
const OVERLAY_MARKS = new Set(
  [0x033d, 0x0334, 0x0335, 0x0336, 0x0337, 0x0338, 0x0489].map((cp) =>
    String.fromCodePoint(cp)
  )
);
function markPosition(char: string): "above" | "below" | "overlay" {
  if (OVERLAY_MARKS.has(char)) return "overlay";
  if (BELOW_MARKS.has(char)) return "below";
  return "above";
}

/**
 * Self-contained, font-independent placeholder for an isolated combining
 * mark (Vietnamese U+0309 hook-above, U+0323 dot-below, and the rest of the
 * Mn category). Drawn entirely from SVG primitives — a dotted circle (the
 * standard type-design convention for "a mark with no base to sit on") plus
 * a small generic tick showing which side the mark attaches to.
 *
 * This deliberately does NOT ask any installed font to render the mark
 * character itself. Isolated combining marks are notoriously inconsistent
 * across text-shaping stacks: a browser/OS that has no glyph for the bare
 * codepoint in the active font falls back to whatever font it thinks covers
 * that codepoint next — and that substitute varies by device (which is why
 * the same ghost used to render as a completely different shape on a laptop
 * vs. a tablet). Worse, some fallback fonts bake a literal debug label like
 * "NO GLYPH" into their .notdef slot as a foundry placeholder, and that
 * label was exactly what was showing up here, stretched sideways to fit the
 * mark's narrow advance box. Drawing our own vector shape sidesteps both
 * problems: it needs no font at all, so it looks identical everywhere.
 */
function CombiningMarkGhost({
  anchorX,
  ascender,
  capHeight,
  offsetY,
  opacity,
  scale,
  position,
}: {
  anchorX: number;
  ascender: number;
  capHeight: number;
  offsetY: number;
  opacity: number;
  scale: number;
  position: "above" | "below" | "overlay";
}) {
  const r = capHeight * 0.34 * scale;
  const cy = ascender - capHeight * 0.5 * scale - offsetY;
  const tick = r * 0.5;
  return (
    <g opacity={opacity} style={{ pointerEvents: "none", userSelect: "none" }} aria-hidden="true">
      <circle
        cx={anchorX}
        cy={cy}
        r={r}
        fill="none"
        stroke="var(--text)"
        strokeWidth={Math.max(1, r * 0.09)}
        strokeDasharray={`${r * 0.32} ${r * 0.28}`}
      />
      {position === "above" && (
        <path
          d={`M ${anchorX - tick} ${cy - r - tick * 0.6} Q ${anchorX} ${cy - r - tick * 1.8}, ${anchorX + tick} ${cy - r - tick * 0.6}`}
          fill="none"
          stroke="var(--text)"
          strokeWidth={Math.max(1, r * 0.14)}
          strokeLinecap="round"
        />
      )}
      {position === "below" && (
        <circle cx={anchorX} cy={cy + r + tick * 0.9} r={tick * 0.42} fill="var(--text)" />
      )}
      {position === "overlay" && (
        <path
          d={`M ${anchorX - tick} ${cy} L ${anchorX + tick} ${cy}`}
          fill="none"
          stroke="var(--text)"
          strokeWidth={Math.max(1, r * 0.14)}
          strokeLinecap="round"
        />
      )}
    </g>
  );
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
    // Combining marks (Vietnamese U+0309 hook-above, U+0323 dot-below, and
    // any other Mn-category mark slot) have nothing to combine with when
    // drawn on their own. They used to be prefixed with a dotted-circle
    // placeholder (U+25CC) and rendered as ordinary <text>, but that still
    // asked the browser to shape and draw the bare mark character itself —
    // which text-rendering stacks handle very inconsistently across
    // browsers/devices, and which some fallback fonts render as a literal
    // "NO GLYPH" debug label baked into their .notdef slot when they have no
    // glyph for the codepoint. See CombiningMarkGhost above: it draws the
    // dotted-circle placeholder and a generic above/below/overlay position
    // hint entirely as SVG vector shapes, with no font involved at all, so
    // it can never fall back to another font's placeholder text and always
    // looks identical regardless of platform.
    const isCombiningMark = /\p{Mn}/u.test(char);
    if (isCombiningMark) {
      return (
        <CombiningMarkGhost
          anchorX={laneOffsetX + boxCenterX + offsetX}
          ascender={ascender}
          capHeight={capHeight}
          offsetY={offsetY}
          opacity={opacity}
          scale={scale}
          position={markPosition(char)}
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
