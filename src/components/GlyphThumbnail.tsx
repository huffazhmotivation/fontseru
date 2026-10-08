import { useAppStore } from "@/glyph/store";
import { memo } from "react";
import type { Glyph } from "@/types/glyph";
import { outlineBounds } from "@/editor/objectOps";
import { useGlyphPaths } from "@/editor/useGlyphPaths";
import { hasOutlineCached } from "@/editor/outlineCache";

const boundsCache = new WeakMap<object, ReturnType<typeof outlineBounds>>();

function cachedOutlineBounds(outline: NonNullable<Glyph["outline"]>) {
  const cached = boundsCache.get(outline);
  if (cached !== undefined) return cached;
  const bounds = outlineBounds(outline);
  boundsCache.set(outline, bounds);
  return bounds;
}

/**
 * Miniature preview of a glyph's ACTUAL vector data. Falls back to the plain
 * character (sans) when the glyph has not been drawn yet.
 *
 * The ink comes from the shared, cached path builder (editor/glyphPaths via
 * useGlyphPaths) — the same geometry Multi Mode's passive cells and the
 * Test Lab draw — so a thumbnail looks exactly like the canvas (merged
 * Outline Brush strokes, resolved textured brushes) and a glyph's brush
 * envelopes are computed once for the whole app instead of once per
 * thumbnail mount. While the paths are still being built in the
 * background the character placeholder is shown.
 */
function GlyphThumbnailImpl({ glyph, className = "" }: { glyph: Glyph; className?: string }) {
  const ascender = useAppStore((s) => s.metrics.ascender);
  const drawn = hasOutlineCached(glyph);
  const paths = useGlyphPaths(glyph, ascender, drawn);
  // Feature Builder glyphs (ligatures, alternates, swashes) haven't been
  // drawn yet fall back to their multi-character rule name (e.g. "A.alt1",
  // "C.swash") instead of a single letter. Flag that here so the CSS can
  // shrink + clip it — a name that long rendered at the normal single-char
  // size would spill straight out of this thumbnail's fixed box.
  const multiChar = Array.from(glyph.char).length > 1;
  const charClassName = `fm-thumb-char ${multiChar ? "fm-thumb-char-multi " : ""}${className}`;

  if (!drawn) {
    // " " renders as nothing at all in a plain <span> — unlike every other
    // undrawn glyph, that leaves the tile looking empty/broken rather than
    // "not drawn yet". Space never needs an outline (see hasSpace check in
    // utils/unicodeValidator.ts), so show the open-box space mark instead.
    if (glyph.char === " ") return <span className={charClassName} aria-hidden="true">␣</span>;
    return <span className={charClassName}>{glyph.char}</span>;
  }

  const b = cachedOutlineBounds(glyph.outline);
  if (!b || !paths) return <span className={charClassName}>{glyph.char === " " ? "␣" : glyph.char}</span>;

  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const pad = Math.max(w, h) * 0.16 + 30;
  const vbX = b.minX - pad;
  const vbY = ascender - b.maxY - pad;
  const vbW = w + pad * 2;
  const vbH = h + pad * 2;

  return (
    <svg className={`fm-thumb-svg ${className}`} viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {paths.map((entry) =>
        entry.kind === "stroke" ? (
          <path
            key={entry.id}
            d={entry.d}
            fill="none"
            stroke="currentColor"
            strokeWidth={entry.strokeWidth}
            strokeLinecap={entry.cap as "round" | "butt" | "square"}
            strokeLinejoin={entry.join as "round" | "miter" | "bevel"}
          />
        ) : (
          <path key={entry.id} d={entry.d} fill="currentColor" fillRule="nonzero" />
        )
      )}
    </svg>
  );
}

// Every glyph list (Glyph Nav grid, Family panel previews, live preview
// strips) can mount dozens to hundreds of these at once; a plain function
// component would re-render every one of them whenever its parent list
// re-renders (e.g. dragging a slider elsewhere in the same panel), even
// though almost none of their actual glyph data changed. Memoizing keeps
// that cost proportional to how many glyphs actually changed instead of
// how often the surrounding UI re-renders.
export const GlyphThumbnail = memo(GlyphThumbnailImpl);
