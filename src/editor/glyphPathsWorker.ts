/// <reference lib="webworker" />
// Builds glyph render paths off the main thread (see "Off-thread building"
// in ./glyphPaths). Textured brush strokes take 100–600 ms per glyph to
// outline and union, which froze the UI while Multi mode or the glyph list
// filled in on brush-heavy fonts.
import type { Glyph } from "@/types/glyph";
import type { VectorObject } from "@/types/geometry";
import { getGlyphPaths } from "./glyphPaths";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { contoursToPathCached } from "./pathBuilder";

self.onmessage = (e: MessageEvent<{ id: number; glyph?: Glyph; obj?: VectorObject; ascender: number }>) => {
  const { id, glyph, obj, ascender } = e.data;
  if (obj) {
    // One brush object, exactly as the editing canvas draws it.
    try {
      (self as unknown as Worker).postMessage({ id, d: contoursToPathCached(brushOutlineContours(obj), ascender) });
    } catch (err) {
      (self as unknown as Worker).postMessage({ id, error: String(err) });
    }
    return;
  }
  if (!glyph) return;
  try {
    (self as unknown as Worker).postMessage({ id, entries: getGlyphPaths(glyph, ascender) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
