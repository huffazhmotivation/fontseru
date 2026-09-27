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
    // A character in front of the mark keeps that from happening, but it
    // must never be visible itself. This has gone through three attempts:
    //  1. The dotted-circle U+25CC, painted for real — font-fallback
    //     dependent, looked different across devices, and put a shape on
    //     screen the person never asked to see.
    //  2. A plain period, painted transparent via its own
    //     <tspan fill="transparent">, mark in a second <tspan
    //     fill="var(--text)">. Worked on desktop Chrome, but on iPadOS
    //     Safari the mark stopped painting entirely: splitting base and
    //     mark across two differently-styled <tspan>s is enough for
    //     Chrome's text stack to still shape them as one cluster, but
    //     WebKit treats a differently-styled tspan as its own run and
    //     loses the cluster the mark needed to be recognized as attached
    //     to anything.
    //  3. U+034F COMBINING GRAPHEME JOINER as the base, on the theory that
    //     an invisible-by-definition character would sidestep the whole
    //     styling problem. It made things *worse* — CGJ is a
    //     Default_Ignorable_Code_Point, which every engine (Chrome and
    //     Safari alike) is specifically told to drop out of the glyph run
    //     before shaping. Drop the base and the mark is isolated again,
    //     so it went back to rendering nothing at all, now on BOTH
    //     platforms.
    //
    // U+200A HAIR SPACE is the one that actually works everywhere: a
    // completely ordinary spacing character (category Zs — not
    // default-ignorable, not a format control) that every engine keeps in
    // the run and shapes for real, so the mark always has something to
    // attach to. Because it's blank ink, base and mark can share one
    // <tspan>/one fill/one run with no color trickery at all, which is
    // what removes the Safari-specific run-splitting failure from attempt
    // 2 as well. Picked over the wider U+00A0 NO-BREAK SPACE specifically
    // for its width: `textAnchor="middle"` centers the *whole* run
    // (invisible base included), so a wide base nudges the visible mark
    // off-center by roughly half the base's own advance. Hair space keeps
    // that nudge close to zero while still being a real, always-rendered
    // character.
    //
    // Position is handled separately from shaping, too, rather than
    // trusted to whatever the browser's own mark-to-base stacking decides
    // (that stacking is the other thing that drifts between engines).
    // Instead the mark is anchored to the same standard-metric lines
    // FontSeru's own multilingual composer (src/glyph/multilingual.ts)
    // uses when it builds a real accented letter from this same mark: an
    // "above" mark sits just above cap height (its own box's bottom edge
    // on the cap-height + 2%-em gap line, via `text-after-edge`); a
    // "below" mark sits right at the baseline (its own box's top edge on
    // the baseline, via `text-before-edge`, matching the composer's
    // `metrics.baseline - markBounds.maxY` with no extra gap). That keeps
    // the ghost sitting where the mark will actually land once it's part
    // of a real composite — on every device, not just the ones whose
    // font-shaping stack happens to agree with FontSeru's own metrics.
    const isCombiningMark = /\p{Mn}/u.test(char);
    const cx = laneOffsetX + boxCenterX + offsetX;
    const baselineY = ascender - offsetY;

    if (isCombiningMark) {
      // Extend this set as more below-type marks (cedilla, ogonek, …) get
      // their own standalone glyph slot in MULTILINGUAL_MARK_SLOTS.
      const isBelowMark = char === "\u0323";
      const gap = upm * 0.02; // same 2%-em breathing room multilingual.ts adds above the glyph
      const anchorFontUnits = isBelowMark ? 0 : capHeight + gap;
      const anchorY = ascender - anchorFontUnits - offsetY;
      return (
        <text
          x={cx}
          y={anchorY}
          textAnchor="middle"
          dominantBaseline={isBelowMark ? "text-before-edge" : "text-after-edge"}
          fontFamily="'Inter', system-ui, sans-serif"
          fontWeight={600}
          fontSize={capHeight * 1.36 * scale}
          fill="var(--text)"
          opacity={opacity}
          style={{ pointerEvents: "none", userSelect: "none" }}
          aria-hidden="true"
        >
          {"\u200A" + char}
        </text>
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
