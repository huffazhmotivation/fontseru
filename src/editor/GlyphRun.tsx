import { memo, useMemo } from "react";
import { useAppStore } from "@/glyph/store";
import { hasOutline, type GlyphMap } from "@/types/glyph";
import type { KerningPairs } from "@/types/kerning";
import { layoutLine } from "./textLayout";
import { getGlyphPaths } from "./glyphPaths";

// Kerning edits (dragging a glyph in the Test Lab) only change glyph X
// positions, not outlines, but every kerning update used to force every
// visible GlyphRun to recompute path data for every glyph on every
// pointer-move frame — that's what made manual kerning feel slow or stuck
// on anything beyond a couple of words. getGlyphPaths (see ./glyphPaths)
// caches computed path data keyed by the glyph object's own identity.
// Every store update in this app replaces edited glyphs with a new object
// (`{ ...glyphs, [char]: nextGlyph }`) while leaving untouched glyphs'
// references intact, so unrelated glyphs — which is all of them during a
// kerning drag — hit the cache instead of recomputing geometry.

interface GlyphRunProps {
  text: string;
  /** Rendered height of one em, in CSS pixels. */
  fontSizePx: number;
  /** Extra spacing between glyphs, in font units (can be negative). */
  trackingUnits?: number;
  color?: string;
  className?: string;
  /**
   * Optional single-glyph ink override, by placed-glyph index — e.g. the
   * Test Lab highlighting the glyph currently being kerning-dragged. Kept
   * as two plain primitives rather than a `(index, char) => color` callback
   * on purpose: a callback prop is a new function identity on every parent
   * render (SpecimenPanel re-renders on every store update, including
   * unrelated ones, and on every kerning-drag animation frame), which used
   * to defeat memoization outright — React had no way to tell "did this
   * row's actual inputs change" from "the parent merely re-rendered", so
   * every visible line/style-row re-rendered and re-diffed on every tick
   * regardless of whether its own text/kerning/highlight had changed.
   * Primitives let `memo` below do real, cheap prop comparisons instead.
   */
  highlightIndex?: number;
  highlightColor?: string;
  /** Additive Test Lab escape hatch: render a family style without switching the editor store style. */
  glyphsOverride?: GlyphMap;
  /** Additive Test Lab escape hatch: render an effective Shared + Style Override view. */
  kerningPairsOverride?: KerningPairs;
  /**
   * Test Lab only: when a character has no glyph yet (or a glyph with an
   * empty outline — nothing drawn), render a faint placeholder ("ghost")
   * instead of leaving invisible blank space. Purely a preview aid — it
   * reads no data that export doesn't already ignore, and it never touches
   * the glyph/outline model, so undrawn glyphs still export empty exactly
   * as before. Defaults to off so every other GlyphRun caller (main editor
   * canvas, thumbnails, etc.) renders exactly as it always has.
   */
  ghostEmpty?: boolean;
}

function GlyphRunImpl({
  text,
  fontSizePx,
  trackingUnits = 0,
  color = "currentColor",
  className = "",
  highlightIndex,
  highlightColor,
  glyphsOverride,
  kerningPairsOverride,
  ghostEmpty = false,
}: GlyphRunProps) {
  // Skip subscribing to the live store slice entirely when a caller passed
  // its own override — Family/Style-Override rows in the Test Lab already
  // pass explicit glyphs/kerningPairs snapshots, so there is no reason for
  // those rows to also re-render every time the (unrelated, in this case)
  // active-style store slice changes.
  const storeGlyphs = useAppStore(glyphsOverride ? (() => undefined) : (s) => s.glyphs);
  const metrics = useAppStore((s) => s.metrics);
  const storeKerningPairs = useAppStore(kerningPairsOverride ? (() => undefined) : (s) => s.kerningPairs);
  const glyphs = glyphsOverride ?? storeGlyphs!;
  const kerningPairs = kerningPairsOverride ?? storeKerningPairs!;
  const { ascender, descender, unitsPerEm, wordSpacing } = metrics;
  const totalH = ascender - descender;

  // Single shared layout engine — also used by the Test Lab / Kerning caret
  // and click hit-testing, so rendering and caret position can never drift.
  //
  // Memoized on exactly the inputs that can change the result: GlyphRun is
  // mounted many times over in the Test Lab (once per wrapped line, again
  // per family-style row), and re-renders there for reasons that have
  // nothing to do with layout — cursor blink, hover state, another row's
  // active-glyph highlight — which used to re-run this same kerning-pair
  // walk from scratch every time. That's on top of the *intentional*
  // per-frame re-renders during a kerning drag (see useTypingCaret/
  // SpecimenPanel's rAF-batched drag), which made every visible GlyphRun
  // redo full-text layout on every animation frame regardless of whether
  // its own text/kerning actually changed that frame — a real contributor
  // to Test Lab feeling heavy/stuttery under normal use.
  const { placed, totalAdvance: rawAdvance } = useMemo(
    () => layoutLine(text, glyphs, unitsPerEm, kerningPairs, trackingUnits, wordSpacing),
    [text, glyphs, unitsPerEm, kerningPairs, trackingUnits, wordSpacing]
  );
  const totalAdvance = Math.max(1, rawAdvance);

  const pxPerUnit = fontSizePx / unitsPerEm;
  const width = Math.max(1, totalAdvance * pxPerUnit);
  const height = Math.max(1, totalH * pxPerUnit);

  return (
    <svg
      className={`fm-glyphrun ${className}`}
      width={width}
      height={height}
      viewBox={`0 0 ${totalAdvance} ${totalH}`}
      style={{ display: "block", overflow: "visible" }}
      aria-label={text}
    >
      <g fill={color} stroke={color}>
        {placed.map(({ char, x, advance }, i) => {
          const g = glyphs[char];
          const glyphColor = (i === highlightIndex ? highlightColor : undefined) ?? color;

          if (g && hasOutline(g)) {
            const paths = getGlyphPaths(g, ascender);
            return (
              <g key={i} transform={`translate(${x} 0)`} fill={glyphColor} stroke={glyphColor}>
                {paths.map((entry) =>
                  entry.kind === "stroke" ? (
                    <path
                      key={entry.id}
                      d={entry.d}
                      fill="none"
                      stroke={glyphColor}
                      strokeWidth={entry.strokeWidth}
                      strokeLinecap={entry.cap as "round" | "butt" | "square"}
                      strokeLinejoin={entry.join as "round" | "miter" | "bevel"}
                    />
                  ) : (
                    <path key={entry.id} d={entry.d} fill={glyphColor} fillRule="nonzero" stroke="none" />
                  )
                )}
              </g>
            );
          }

          // No outline drawn yet. Left as `return null` this used to just
          // vanish — correct spacing (layoutLine already reserves the right
          // advance) but visually indistinguishable from "this character
          // doesn't exist", which is what confused users in Test Lab. When
          // ghostEmpty is on, show a faint placeholder glyph purely for
          // preview; it carries no outline data, so Export (which reads
          // glyph.outline directly) still produces an empty glyph exactly
          // as before.
          if (!ghostEmpty || char === " ") return null;
          return (
            <g key={i} transform={`translate(${x} 0)`} opacity={0.32} style={{ pointerEvents: "none" }}>
              <text
                x={advance / 2}
                y={ascender}
                textAnchor="middle"
                fontFamily="'Inter', system-ui, sans-serif"
                fontWeight={600}
                fontSize={ascender * 0.72}
                fill={glyphColor}
                stroke="none"
              >
                {char}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/**
 * Memoized so GlyphRun instances that aren't affected by a given store
 * update (or an unrelated re-render of whatever mounted them — cursor
 * blink, a sibling row's hover state, a timer flipping some other flag)
 * skip re-rendering and re-diffing their SVG entirely, instead of every
 * visible line/row in the Test Lab reconciling on every tick regardless of
 * relevance. Only effective now that `highlightIndex`/`highlightColor` are
 * primitives instead of a freshly-allocated callback — see the comment on
 * `highlightIndex` above.
 */
export const GlyphRun = memo(GlyphRunImpl);
