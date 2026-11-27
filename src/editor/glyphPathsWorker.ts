/// <reference lib="webworker" />
// Builds glyph render paths off the main thread (see "Off-thread building"
// in ./glyphPaths). Textured brush strokes take 100–600 ms per glyph to
// outline and union, which froze the UI while Multi mode or the glyph list
// filled in on brush-heavy fonts.
import type { Glyph } from "@/types/glyph";
import { getGlyphPaths } from "./glyphPaths";

self.onmessage = (e: MessageEvent<{ id: number; glyph: Glyph; ascender: number }>) => {
  const { id, glyph, ascender } = e.data;
  try {
    (self as unknown as Worker).postMessage({ id, entries: getGlyphPaths(glyph, ascender) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
