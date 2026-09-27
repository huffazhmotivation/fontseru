import { useEffect, useState } from "react";
import * as opentype from "opentype.js";

/**
 * GHOST REFERENCE FONT — embedded, vector, device-independent
 * =============================================================
 * Fix for: sample-mode ghost glyphs rendering as the *wrong* character
 * shape (or missing Vietnamese diacritics entirely) on some PCs/tablets.
 *
 * ROOT CAUSE (what this file replaces)
 * -------------------------------------
 * The old ghost drew an SVG `<text fontFamily="'Inter', system-ui, sans-serif">`.
 * That's a request to the *browser's* text shaper, which:
 *   1. depends on index.html's Google-Fonts <link> having already loaded
 *      Inter by the time the SVG paints (racy on slow/offline connections),
 *   2. falls back to `system-ui` — a different font on every OS/device —
 *      the instant Inter isn't available, and
 *   3. inherits whatever that fallback font does or doesn't support, which
 *      is exactly how Vietnamese hook-above/dot-below stacks (ẩ ậ ặ ệ ổ ...)
 *      go missing or get substituted on some tablets.
 *
 * FIX
 * ---
 * Never ask the browser to shape text for the ghost. Fetch one embedded,
 * open-license font file ourselves, parse it with opentype.js (already a
 * project dependency, used elsewhere for font export), and pull the real
 * vector outline for the requested character directly out of its glyf
 * table. `GhostGlyph.tsx` then draws that outline as a plain SVG <path> —
 * identical bytes in, identical pixels out, on every device, online or
 * offline, regardless of what's installed on the viewer's machine.
 *
 * See public/fonts/README.md for what font ships here and how to swap it.
 */

const GHOST_FONT_URL = "/fonts/ghost-sans.ttf";
const GHOST_FONT_BOLD_URL = "/fonts/ghost-sans-bold.ttf";

/** Visual size multiplier from FontSeru's own `capHeight` metric to the
 * font-unit `fontSize` opentype.js expects. Tuned for the shipped
 * Bricolage Grotesque; if you swap in a different reference font (see
 * public/fonts/README.md) and its cap-height reads visibly bigger or
 * smaller than before, adjust this one number rather than any call site. */
export const GHOST_FONT_SIZE_SCALE = 1.36;

export type GhostFontWeight = "regular" | "bold";

interface GhostFontEntry {
  promise: Promise<opentype.Font> | null;
  font: opentype.Font | null;
}

const entries: Record<GhostFontWeight, GhostFontEntry> = {
  regular: { promise: null, font: null },
  bold: { promise: null, font: null },
};

const urlFor: Record<GhostFontWeight, string> = {
  regular: GHOST_FONT_URL,
  bold: GHOST_FONT_BOLD_URL,
};

const listeners = new Set<() => void>();
function notifyListeners() {
  for (const fn of listeners) fn();
}

/** Fetches + parses the embedded ghost-reference font for one weight.
 * Safe to call many times — the underlying fetch/parse happens once per
 * weight and every caller shares the same promise. */
function loadGhostFont(weight: GhostFontWeight): Promise<opentype.Font> {
  const entry = entries[weight];
  if (entry.promise) return entry.promise;

  entry.promise = fetch(urlFor[weight])
    .then((res) => {
      if (!res.ok) throw new Error(`ghost font fetch failed (${res.status}): ${urlFor[weight]}`);
      return res.arrayBuffer();
    })
    .then((buffer) => {
      const font = opentype.parse(buffer);
      entry.font = font;
      notifyListeners();
      return font;
    })
    .catch((err) => {
      // Leave entry.promise cleared so a later remount (or a flaky first
      // request, e.g. offline-then-online on a tablet) can retry instead
      // of permanently failing for the rest of the session.
      entry.promise = null;
      console.error(`[ghostFont] failed to load embedded reference font (${weight})`, err);
      throw err;
    });

  return entry.promise;
}

// Kick off loading both weights as soon as this module is imported, so
// the font is typically already warm by the time a ghost first paints
// instead of waiting for the first render to trigger the fetch.
loadGhostFont("regular").catch(() => {});
loadGhostFont("bold").catch(() => {});

function getLoadedGhostFont(weight: GhostFontWeight): opentype.Font | null {
  return entries[weight].font;
}

/** React hook: returns the parsed ghost-reference font once it's loaded
 * (null until then, and again briefly if a load ever needs to retry).
 * Components using this should render nothing while it's null rather
 * than fall back to any text-based placeholder — a half-second of no
 * ghost on first paint is a better failure mode than a flash of the
 * wrong glyph shape. */
export function useGhostFont(weight: GhostFontWeight = "regular"): opentype.Font | null {
  const [font, setFont] = useState<opentype.Font | null>(() => getLoadedGhostFont(weight));

  useEffect(() => {
    if (font) return;
    loadGhostFont(weight).catch(() => {});
    const onLoaded = () => setFont(getLoadedGhostFont(weight));
    listeners.add(onLoaded);
    return () => listeners.delete(onLoaded);
  }, [font, weight]);

  return font;
}

export interface GhostGlyphOutline {
  /** SVG path data, baseline at y=0, left edge of the advance box at x=0. */
  pathData: string;
  /** Advance width in the same units as pathData, for horizontal centering. */
  advance: number;
}

// One outline cache per font object (regular vs. bold get their own
// entry automatically, and it stays correct even if more weights are
// added later) — keyed by WeakMap so it never outlives the font itself.
const outlineCaches = new WeakMap<opentype.Font, Map<string, GhostGlyphOutline | null>>();

/**
 * Extracts a single character's vector outline from an already-loaded
 * ghost-reference font, as SVG path data plus its advance width (so
 * callers can center it themselves). Returns null when the character
 * isn't a single code point, or when this reference font genuinely has
 * no glyph for it (the .notdef box is deliberately hidden rather than
 * shown — an absent ghost is a better signal than a wrong one).
 */
export function outlineForChar(
  font: opentype.Font,
  char: string,
  fontSize: number
): GhostGlyphOutline | null {
  if (!char || Array.from(char).length !== 1 || !(fontSize > 0)) return null;

  let cache = outlineCaches.get(font);
  if (!cache) {
    cache = new Map();
    outlineCaches.set(font, cache);
  }
  // Round fontSize so tiny sub-pixel zoom deltas during a drag share a
  // cache entry instead of each computing/storing their own outline.
  const cacheKey = `${char}:${Math.round(fontSize * 20)}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  let result: GhostGlyphOutline | null = null;
  try {
    const glyphIndex = font.charToGlyphIndex(char);
    if (glyphIndex !== 0) {
      const path = font.getPath(char, 0, 0, fontSize, { kerning: false });
      const pathData = path.toPathData(2);
      if (pathData) {
        const advance = font.getAdvanceWidth(char, fontSize, { kerning: false });
        result = { pathData, advance };
      }
    }
  } catch (err) {
    console.error(`[ghostFont] failed to extract outline for "${char}"`, err);
    result = null;
  }

  cache.set(cacheKey, result);
  return result;
}
