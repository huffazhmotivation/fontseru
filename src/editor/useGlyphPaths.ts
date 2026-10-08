import { useEffect, useReducer, useRef } from "react";
import type { Glyph } from "@/types/glyph";
import { buildGlyphPathsWithinBudget, warmGlyphPaths, type GlyphPathEntry } from "./glyphPaths";

/**
 * Paths for a glyph shown in a grid cell, or null while they're still being
 * built in the background (render a placeholder meanwhile). Returns cached
 * paths synchronously, so an already-warm glyph never flashes a placeholder.
 * See "Progressive path building" in ./glyphPaths.
 *
 * Two things keep a cell from blinking blank when its glyph object is
 * replaced (every committed edit makes a new one, so the cache misses):
 *  • a small per-frame budget builds the new paths inline during render
 *    (see buildGlyphPathsWithinBudget) — usually enough for the one glyph
 *    that just changed;
 *  • past that budget, the cell keeps showing the last paths it rendered
 *    (stale-while-revalidate) until the background build lands, instead
 *    of dropping to the placeholder.
 */
export function useGlyphPaths(glyph: Glyph, ascender: number, enabled = true): GlyphPathEntry[] | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const lastRef = useRef<{ ascender: number; paths: GlyphPathEntry[] } | null>(null);
  const fresh = enabled ? buildGlyphPathsWithinBudget(glyph, ascender) : null;
  const missing = enabled && !fresh;
  if (fresh) lastRef.current = { ascender, paths: fresh };
  else if (!enabled) lastRef.current = null;
  useEffect(() => {
    if (!missing) return;
    return warmGlyphPaths(glyph, ascender, bump);
  }, [missing, glyph, ascender]);
  if (fresh) return fresh;
  const stale = lastRef.current;
  return missing && stale && stale.ascender === ascender ? stale.paths : null;
}
