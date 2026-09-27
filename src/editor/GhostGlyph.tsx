import { memo } from "react";
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
    // drawn on their own — a bare <text> node renders them at zero visual
    // width, so the "sample" ghost silently disappears for exactly these
    // characters even though this branch runs and returns real markup.
    // A base character in front of the mark keeps that from happening.
    //
    // The base used to be the literal dotted-circle character (U+25CC)
    // painted as visible text. That depends on whichever font the browser
    // substitutes actually mapping U+25CC — most do, but when one in the
    // fallback chain doesn't, the platform's own "missing glyph" stand-in
    // is what renders instead, and it is NOT a blank box: it's a distinct,
    // OS/browser-specific placeholder that on some systems has visible
    // debug lettering baked into it. That's a font-substitution problem,
    // not a "which glyph did we ask for" problem, so it can't be fixed by
    // picking a different placeholder character — it can only be avoided
    // by not asking a system font to paint the dotted circle at all, which
    // also happened to make the ghost look different across devices
    // (whatever fallback font each browser lands on differs).
    //
    // So the visible dotted circle below is drawn ourselves, as plain SVG
    // dots — identical on every platform, zero font dependency. A real
    // base character (a plain period) still sits in the text flow, but
    // fully transparent: it exists only so the browser's text shaping has
    // something to hang the following mark glyph on, per the same "isolated
    // combining marks don't paint" behavior noted above. Its own glyph
    // shape is never seen.
    const isCombiningMark = /\p{Mn}/u.test(char);
    const cx = laneOffsetX + boxCenterX + offsetX;
    const baselineY = ascender - offsetY;

    if (isCombiningMark) {
      const fontSize = capHeight * 1.36 * scale;
      // Rough stand-in for a round lowercase letter (e.g. "o") at this
      // font size — good enough for a placement guide, not exact metrics.
      const ringDiameter = capHeight * 0.66 * scale;
      const ringRadius = ringDiameter / 2;
      const ringCenterY = baselineY - ringRadius;
      const dotCount = 12;
      const dotR = Math.max(0.6, ringRadius * 0.09);
      const dots = Array.from({ length: dotCount }, (_, i) => {
        const a = (i / dotCount) * Math.PI * 2 - Math.PI / 2;
        return {
          x: cx + Math.cos(a) * ringRadius,
          y: ringCenterY + Math.sin(a) * ringRadius,
        };
      });
      return (
        <g opacity={opacity} style={{ pointerEvents: "none", userSelect: "none" }} aria-hidden="true">
          {dots.map((d, i) => (
            <circle key={i} cx={d.x} cy={d.y} r={dotR} fill="var(--text)" />
          ))}
          <text
            x={cx}
            y={baselineY}
            textAnchor="middle"
            fontFamily="'Inter', system-ui, sans-serif"
            fontWeight={600}
            fontSize={fontSize}
          >
            <tspan fill="transparent">.</tspan>
            <tspan fill="var(--text)">{char}</tspan>
          </text>
        </g>
      );
    }

    return (
      <text
        x={cx}
        y={baselineY}
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
