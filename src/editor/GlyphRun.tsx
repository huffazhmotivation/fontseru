import { memo, useMemo } from "react";
import { ghostOutlineFor, useGhostFont } from "./ghostFont";
import { ghostCenterX } from "./ghostRef";
import { useAppStore } from "@/glyph/store";
import { hasOutline, type GlyphMap } from "@/types/glyph";
import type { KerningPairs } from "@/types/kerning";
import { effectiveWordSpacing } from "@/types/kerning";
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
  /** Optional per-glyph ink override. Existing callers render unchanged when omitted. */
  colorForIndex?: (index: number, char: string) => string | undefined;
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

function GlyphRunView({
  text,
  fontSizePx,
  trackingUnits = 0,
  color = "currentColor",
  className = "",
  colorForIndex,
  glyphsOverride,
  kerningPairsOverride,
  ghostEmpty = false,
}: GlyphRunProps) {
  const storeGlyphs = useAppStore((s) => s.glyphs);
  const metrics = useAppStore((s) => s.metrics);
  const storeKerningPairs = useAppStore((s) => s.kerningPairs);
  const fontStyle = useAppStore((s) => s.fontStyle);
  const wordSpacingOverridesByStyle = useAppStore((s) => s.wordSpacingOverridesByStyle);
  const glyphs = glyphsOverride ?? storeGlyphs;
  const kerningPairs = kerningPairsOverride ?? storeKerningPairs;
  const { ascender, descender, unitsPerEm, capHeight } = metrics;
  // Reference font for the undrawn-glyph placeholder (ghostEmpty). The
  // hook is cheap and shared app-wide; it only triggers a re-render once,
  // when the font finishes loading.
  const refFont = useGhostFont();
  const wordSpacing = effectiveWordSpacing(metrics.wordSpacing, wordSpacingOverridesByStyle, fontStyle);
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
          const glyphColor = colorForIndex?.(i, char) ?? color;

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
          // Same reference as the editor's Sample ghost: the real vector
          // outline from the embedded Noto Sans (see ghostFont.ts), sized
          // to the project cap height and centred on the glyph's standard
          // box — so the placeholder in Live Preview / Test Lab is the very
          // same drawing you trace over on the canvas, on every device.
          // (The user's Ghost Scale/Offset are tracing aids and are not
          // applied here: a text preview must stay typographically true.)
          const ref = ghostOutlineFor(refFont, char);
          const boxCenter = g ? ghostCenterX(g, unitsPerEm) : advance / 2;
          if (!ref) {
            // Still loading → draw nothing for a moment rather than flash.
            // Not in the reference font → a standard .notdef-style box
            // ("tofu"), so the slot still reads as "undrawn glyph here".
            if (!refFont) return null;
            const boxW = Math.max(advance * 0.5, capHeight * 0.45);
            const boxH = capHeight > 0 ? capHeight : ascender * 0.7;
            return (
              <g key={i} transform={`translate(${x} 0)`} opacity={0.32} style={{ pointerEvents: "none" }} aria-hidden="true">
                <rect
                  x={boxCenter - boxW / 2}
                  y={ascender - boxH}
                  width={boxW}
                  height={boxH}
                  rx={boxW * 0.06}
                  fill="none"
                  stroke={glyphColor}
                  strokeWidth={Math.max(8, boxW * 0.07)}
                />
              </g>
            );
          }
          const k = (capHeight > 0 ? capHeight : unitsPerEm * 0.7) / ref.capHeight;
          return (
            <g key={i} transform={`translate(${x} 0)`} opacity={0.32} style={{ pointerEvents: "none" }} aria-hidden="true">
              <path
                d={ref.d}
                transform={`translate(${boxCenter} ${ascender}) scale(${k}) translate(${-ref.centerX} 0)`}
                fill={glyphColor}
                fillRule="nonzero"
                stroke="none"
              />
            </g>
          );
        })}
      </g>
    </svg>
  );
}

export const GlyphRun = memo(GlyphRunView);
