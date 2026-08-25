import { useAppStore } from "@/glyph/store";
import type { Glyph, GlyphMap } from "@/types/glyph";
import type { KerningPairs } from "@/types/kerning";
import { objectFillPath, objectStrokePath, contourToPath } from "./pathBuilder";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { layoutLine } from "./textLayout";

/**
 * Rendering a glyph's outline (fill paths, brush stroke-to-outline
 * envelopes, stroke centerlines) is comparatively expensive — brush
 * envelopes in particular run a Minkowski-sum sweep per contour. None of
 * that geometry depends on WHERE the glyph is drawn, only on the glyph's
 * own outline data. Kerning edits (dragging a glyph in the Test Lab) only
 * change glyph X positions, not outlines, but every kerning update used to
 * force every visible GlyphRun to recompute path data for every glyph on
 * every pointer-move frame — that's what made manual kerning feel slow or
 * stuck on anything beyond a couple of words.
 *
 * This cache keys the computed path data by the glyph object's own
 * identity. Every store update in this app replaces edited glyphs with a
 * new object (`{ ...glyphs, [char]: nextGlyph }`) while leaving untouched
 * glyphs' references intact, so unrelated glyphs — which is all of them
 * during a kerning drag — hit the cache instead of recomputing geometry.
 * Nested by `ascender` (rounded) since glyph rendering is Y-flipped around
 * it and metrics could in principle change independently of the glyph.
 */
type GlyphPathEntry =
  | { kind: "fill"; id: string; d: string }
  | { kind: "brushFill"; id: string; d: string }
  | { kind: "stroke"; id: string; d: string; strokeWidth: number; cap: string; join: string };

const glyphPathCache = new WeakMap<Glyph, Map<number, GlyphPathEntry[]>>();

function getGlyphPaths(glyph: Glyph, ascender: number): GlyphPathEntry[] {
  let byAscender = glyphPathCache.get(glyph);
  const cached = byAscender?.get(ascender);
  if (cached) return cached;

  const entries: GlyphPathEntry[] = glyph.outline.objects.map((obj) => {
    if (obj.kind === "shape" || obj.kind === "expanded") {
      return { kind: "fill", id: obj.id, d: objectFillPath(obj, ascender) };
    }
    if (obj.kind === "brush" && obj.brushType !== "monoline") {
      return {
        kind: "brushFill",
        id: obj.id,
        d: brushOutlineContours(obj).map((c) => contourToPath(c, ascender)).join(" "),
      };
    }
    return {
      kind: "stroke",
      id: obj.id,
      d: objectStrokePath(obj, ascender),
      strokeWidth: obj.strokeWidth ?? 20,
      cap: obj.cap ?? "round",
      join: obj.join ?? "round",
    };
  });

  if (!byAscender) {
    byAscender = new Map();
    glyphPathCache.set(glyph, byAscender);
  }
  byAscender.set(ascender, entries);
  return entries;
}

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
}

export function GlyphRun({
  text,
  fontSizePx,
  trackingUnits = 0,
  color = "currentColor",
  className = "",
  colorForIndex,
  glyphsOverride,
  kerningPairsOverride,
}: GlyphRunProps) {
  const storeGlyphs = useAppStore((s) => s.glyphs);
  const metrics = useAppStore((s) => s.metrics);
  const storeKerningPairs = useAppStore((s) => s.kerningPairs);
  const glyphs = glyphsOverride ?? storeGlyphs;
  const kerningPairs = kerningPairsOverride ?? storeKerningPairs;
  const { ascender, descender, unitsPerEm } = metrics;
  const totalH = ascender - descender;

  // Single shared layout engine — also used by the Test Lab / Kerning caret
  // and click hit-testing, so rendering and caret position can never drift.
  const { placed, totalAdvance: rawAdvance } = layoutLine(text, glyphs, unitsPerEm, kerningPairs, trackingUnits);
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
        {placed.map(({ char, x }, i) => {
          const g = glyphs[char];
          if (!g) return null;
          const glyphColor = colorForIndex?.(i, char) ?? color;
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
        })}
      </g>
    </svg>
  );
}
