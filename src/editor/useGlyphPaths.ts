import { useEffect, useReducer } from "react";
import type { Glyph } from "@/types/glyph";
import { peekGlyphPaths, warmGlyphPaths, type GlyphPathEntry } from "./glyphPaths";

/**
 * Paths for a glyph shown in a grid cell, or null while they're still being
 * built in the background (render a placeholder meanwhile). Returns cached
 * paths synchronously, so an already-warm glyph never flashes a placeholder.
 * See "Progressive path building" in ./glyphPaths.
 */
export function useGlyphPaths(glyph: Glyph, ascender: number, enabled = true): GlyphPathEntry[] | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const paths = enabled ? peekGlyphPaths(glyph, ascender) : null;
  const missing = enabled && !paths;
  useEffect(() => {
    if (!missing) return;
    return warmGlyphPaths(glyph, ascender, bump);
  }, [missing, glyph, ascender]);
  return paths;
}
