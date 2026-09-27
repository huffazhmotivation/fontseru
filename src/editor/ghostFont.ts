import { useSyncExternalStore } from "react";
import type { Font, Glyph as OtGlyph } from "opentype.js";

/**
 * GHOST REFERENCE FONT
 * ====================
 * The "Sample" ghost used to be an SVG `<text>` element, which meant the
 * browser picked whatever font the device happened to have for that
 * character. On one PC it was Inter, on an iPad it was SF, on an Android
 * tablet it was Roboto — and for Vietnamese hook-above / dot-below vowels
 * the fallback font often stacked the marks wrongly or not at all. The
 * reference you trace over was therefore a different drawing on every
 * device, which defeats the point of a reference.
 *
 * Now the ghost is real vector geometry:
 *
 *  - One embedded open-license font (Noto Sans SemiBold, SIL OFL 1.1 —
 *    see public/fonts/ghost/OFL.txt), subset to Latin / Latin Extended /
 *    Vietnamese / Greek / Cyrillic / punctuation / currency / math.
 *  - Parsed with opentype.js (already a dependency for font export), and
 *    each glyph's actual outline is emitted as an SVG path `d` string.
 *
 * No browser text shaping, no system fonts, no font-fallback chain: every
 * device draws the exact same Bézier curves. The WOFF sits in /public so
 * the service worker precaches it (see globPatterns in vite.config.ts) and
 * the ghost also works offline.
 */

const GHOST_FONT_URL = `${import.meta.env.BASE_URL}fonts/ghost/NotoSans-SemiBold.woff`;

/** Reference-font geometry for one ghost character, in the reference
 *  font's own units, y-down, baseline at y = 0. */
export interface GhostOutline {
  /** SVG path data. */
  d: string;
  /** Horizontal point that gets aligned to the working glyph's box centre. */
  centerX: number;
  /** Reference font's cap height, used to size the ghost to the project. */
  capHeight: number;
  unitsPerEm: number;
}

type Status = "idle" | "loading" | "ready" | "error";

let font: Font | null = null;
let status: Status = "idle";
let loadPromise: Promise<Font | null> | null = null;
const listeners = new Set<() => void>();
const outlineCache = new Map<string, GhostOutline | null>();

function emit() {
  for (const l of listeners) l();
}

/** Loads (once) and parses the embedded reference font. Never throws. */
export function loadGhostFont(): Promise<Font | null> {
  if (loadPromise) return loadPromise;
  status = "loading";
  loadPromise = (async () => {
    try {
      const [{ parse }, res] = await Promise.all([
        import("opentype.js"),
        fetch(GHOST_FONT_URL, { cache: "force-cache" }),
      ]);
      if (!res.ok) throw new Error(`Ghost font HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      font = parse(buffer);
      status = "ready";
    } catch (err) {
      console.warn("[FontSeru] Ghost reference font failed to load", err);
      status = "error";
      // Allow a retry next time something asks (e.g. after coming back
      // online) instead of staying broken for the whole session.
      loadPromise = null;
    }
    emit();
    return font;
  })();
  return loadPromise;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (status === "idle" || (status === "error" && !loadPromise)) void loadGhostFont();
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return font;
}

/** Reference font, or null while it is still loading. Re-renders the
 *  caller once it is ready. */
export function useGhostFont(): Font | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function isMissing(g: OtGlyph | undefined | null): boolean {
  return !g || g.index === 0;
}

/** Turns a glyph key into the text the reference font should draw.
 *  - "A", "ả"             → itself
 *  - "a.alt1", "C.swash"  → the base letter before the suffix
 *  - "f_i", "r_e"         → the component sequence ("fi", "re")
 */
function resolveKeyText(key: string): string | null {
  const chars = Array.from(key);
  if (chars.length === 1) return key;
  const base = key.includes(".") && !key.startsWith(".") ? key.slice(0, key.indexOf(".")) : key;
  const joined = base.includes("_") ? base.split("_").join("") : base;
  return joined.length > 0 ? joined : null;
}

/** Vector outline of `key` from the reference font, or null if the font
 *  has no design for it (or has not loaded yet). Cached per key. */
export function ghostOutlineFor(f: Font | null, key: string): GhostOutline | null {
  if (!f) return null;
  const cached = outlineCache.get(key);
  if (cached !== undefined) return cached;

  const result = buildOutline(f, key);
  outlineCache.set(key, result);
  return result;
}

function buildOutline(f: Font, key: string): GhostOutline | null {
  const text = resolveKeyText(key);
  if (!text) return null;
  const upm = f.unitsPerEm || 1000;
  const capHeight = f.tables.os2?.sCapHeight || upm * 0.714;

  const chars = Array.from(text);
  if (chars.length === 1) {
    const g = f.charToGlyph(text);
    if (isMissing(g)) return null;
    const path = g.getPath(0, 0, upm);
    const d = path.toPathData(2);
    if (!d) return null;
    const advance = g.advanceWidth ?? 0;
    // Spacing glyphs centre on their own advance box (keeps the reference
    // font's native sidebearings). Zero-width combining marks (U+0309,
    // U+0323, …) are designed to hang over the PREVIOUS glyph at negative
    // x, so for those the ink itself is centred instead.
    let centerX = advance / 2;
    if (!(advance > 0)) {
      const bb = path.getBoundingBox();
      centerX = (bb.x1 + bb.x2) / 2;
    }
    return { d, centerX, capHeight, unitsPerEm: upm };
  }

  // Multi-character key (ligature/alternate recipe): lay the run out with
  // the reference font's own ligatures + kerning.
  const glyphs = f.stringToGlyphs(text);
  if (glyphs.some(isMissing)) return null;
  const path = f.getPath(text, 0, 0, upm, { kerning: true });
  const d = path.toPathData(2);
  if (!d) return null;
  const advance = f.getAdvanceWidth(text, upm, { kerning: true });
  return { d, centerX: advance / 2, capHeight, unitsPerEm: upm };
}

/** Synchronous "will the Sample ghost paint something for this key?".
 *  Optimistic while the font is still loading so an empty-cell placeholder
 *  does not flash in and out. */
export function ghostSampleAvailable(key: string): boolean {
  if (status !== "ready" || !font) return status !== "error";
  return ghostOutlineFor(font, key) !== null;
}
