import { useAppStore } from "@/glyph/store";
import { memo } from "react";
import type { Glyph } from "@/types/glyph";
import { objectFillPath, objectStrokePath, contourToPath } from "@/editor/pathBuilder";
import { outlineBounds } from "@/editor/objectOps";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { hasOutline } from "@/types/glyph";

/**
 * Miniature preview of a glyph's ACTUAL vector data. Falls back to the plain
 * character (sans) when the glyph has not been drawn yet.
 */
function GlyphThumbnailImpl({ glyph, className = "" }: { glyph: Glyph; className?: string }) {
  const metrics = useAppStore((s) => s.metrics);
  // Feature Builder glyphs (ligatures, alternates, swashes) haven't been
  // drawn yet fall back to their multi-character rule name (e.g. "A.alt1",
  // "C.swash") instead of a single letter. Flag that here so the CSS can
  // shrink + clip it — a name that long rendered at the normal single-char
  // size would spill straight out of this thumbnail's fixed box.
  const multiChar = Array.from(glyph.char).length > 1;
  const charClassName = `fm-thumb-char ${multiChar ? "fm-thumb-char-multi " : ""}${className}`;

  if (!hasOutline(glyph)) {
    return <span className={charClassName}>{glyph.char}</span>;
  }

  const b = outlineBounds(glyph.outline);
  const { ascender } = metrics;
  if (!b) return <span className={charClassName}>{glyph.char}</span>;

  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const pad = Math.max(w, h) * 0.16 + 30;
  const vbX = b.minX - pad;
  const vbY = ascender - b.maxY - pad;
  const vbW = w + pad * 2;
  const vbH = h + pad * 2;

  return (
    <svg className={`fm-thumb-svg ${className}`} viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {glyph.outline.objects.map((obj) =>
        obj.kind === "shape" || obj.kind === "expanded" ? (
          <path key={obj.id} d={objectFillPath(obj, ascender)} fill="currentColor" fillRule="nonzero" />
        ) : obj.kind === "brush" && obj.brushType !== "monoline" ? (
          <path key={obj.id} d={brushOutlineContours(obj).map((c) => contourToPath(c, ascender)).join(" ")} fill="currentColor" fillRule="nonzero" />
        ) : (
          <path key={obj.id} d={objectStrokePath(obj, ascender)} fill="none" stroke="currentColor"
            strokeWidth={obj.strokeWidth ?? 20} strokeLinecap={obj.cap ?? "round"} strokeLinejoin={obj.join ?? "round"} />
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
