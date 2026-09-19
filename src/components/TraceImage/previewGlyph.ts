import type { FontMetrics } from "@/types/font";
import type { Glyph } from "@/types/glyph";
import type { VectorObject } from "@/types/geometry";
import { fitTracedObjectsToGlyph } from "@/trace/imageTrace";

/** Fixed preview advance width for result thumbnails — GlyphThumbnail sizes itself from the outline's own bounds, so this only needs to be a stable, reasonable value. */
export const PREVIEW_ADVANCE = 600;

/** Builds a throwaway preview Glyph wrapping a flat list of traced/extracted objects, purely so GlyphThumbnail can render it. */
export function objectsPreviewGlyph(objects: VectorObject[], metrics: FontMetrics): Glyph {
  const outline = fitTracedObjectsToGlyph(objects, metrics, PREVIEW_ADVANCE);
  return {
    char: "",
    unicode: 0,
    category: "symbols",
    advanceWidth: PREVIEW_ADVANCE,
    lsb: 0,
    rsb: 0,
    outline,
    components: [],
  };
}
