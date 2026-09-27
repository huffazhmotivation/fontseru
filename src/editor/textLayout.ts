import type { Glyph } from "@/types/glyph";
import { kerningKey } from "@/types/kerning";

export interface PlacedChar {
  char: string;
  /** Pen position (font units) where this glyph's advance box starts. */
  x: number;
  /** The glyph's own advance width in font units (tracking is between glyphs). */
  advance: number;
}

export interface LineLayout {
  placed: PlacedChar[];
  /** Total horizontal advance of the line, in font units (>= 0). */
  totalAdvance: number;
}

/**
 * Fallback advance for characters with no glyph (space, or unsupported
 * input) so layout doesn't collapse. `wordSpacing` is `metrics.wordSpacing`
 * — when the user has set an explicit word-spacing value it wins for the
 * space character; otherwise the space keeps its original 0.27 * unitsPerEm
 * default so existing projects render exactly as before.
 */
export function fallbackAdvance(char: string, unitsPerEm: number, wordSpacing?: number): number {
  if (char === " ") return wordSpacing ?? unitsPerEm * 0.27;
  return unitsPerEm * 0.5;
}

/**
 * One shared text-layout source of truth for FontSeru rendering and editing.
 * Tracking lives BETWEEN glyphs, then pair kerning is applied immediately
 * before the following glyph. The renderer, caret, hit-testing and Kerning
 * Lab all consume these exact positions.
 */
export function layoutLine(
  text: string,
  glyphs: Record<string, Glyph | undefined>,
  unitsPerEm: number,
  kerningPairs: Record<string, number>,
  trackingUnits = 0,
  wordSpacing?: number
): LineLayout {
  const chars = Array.from(text);
  let penX = 0;
  const placed: PlacedChar[] = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (i > 0) {
      const prev = chars[i - 1];
      penX += trackingUnits;
      penX += kerningPairs[kerningKey(prev, ch)] ?? 0;
    }

    const g = glyphs[ch];
    // The space glyph is real now (see ensureSpaceGlyph in
    // glyph/defaultGlyphs.ts), but word spacing is still meant to be a
    // dedicated, separately-tunable control (RightPanel's "Word Spacing" /
    // "Auto") rather than the space glyph's own static advanceWidth —
    // exactly like before that glyph existed. So for " " specifically, an
    // explicit wordSpacing still wins over g.advanceWidth; only an
    // unencoded/missing glyph (any other character) falls all the way
    // through to fallbackAdvance.
    const advance = ch === " " && wordSpacing != null ? wordSpacing : g ? g.advanceWidth : fallbackAdvance(ch, unitsPerEm, wordSpacing);
    placed.push({ char: ch, x: penX, advance });
    penX += advance;
  }

  return { placed, totalAdvance: Math.max(0, penX) };
}

/**
 * Font-unit X of the visual insertion caret. Between two glyphs the caret
 * sits halfway through the tracking/kerning gap instead of being pinned to
 * the next glyph origin. This prevents the caret from visually crowding the
 * following outline while preserving the exact FontSeru layout.
 */
export function caretX(placed: PlacedChar[], col: number): number {
  if (placed.length === 0 || col <= 0) return 0;
  if (col >= placed.length) {
    const last = placed[placed.length - 1];
    return last.x + last.advance;
  }
  const prev = placed[col - 1];
  const next = placed[col];
  const prevEnd = prev.x + prev.advance;
  return (prevEnd + next.x) / 2;
}

/**
 * Character index (0..placed.length) nearest to a client-derived x in font
 * units. Hit-testing uses the same insertion boundaries as the visual caret.
 */
export function nearestCaretColumn(placed: PlacedChar[], xUnits: number): number {
  if (placed.length === 0) return 0;
  let bestCol = 0;
  let bestDist = Math.abs(xUnits - caretX(placed, 0));
  for (let col = 1; col <= placed.length; col++) {
    const dist = Math.abs(xUnits - caretX(placed, col));
    if (dist < bestDist) {
      bestDist = dist;
      bestCol = col;
    }
  }
  return bestCol;
}

export interface WrappedLine {
  text: string;
  layout: LineLayout;
}

/**
 * Soft-wraps `text` against real glyph advances/kerning (not browser text
 * metrics) so it breaks exactly where it will actually render — used by
 * previews that grow taller instead of scrolling sideways as glyph scale
 * increases. Explicit "\n" is preserved as a hard break.
 *
 * Wraps at word (space) boundaries, like ordinary text — not mid-word —
 * so zooming in past the box's width drops whole words to the next line
 * instead of splitting a word letter-by-letter. A single word that is by
 * itself wider than `maxWidthUnits` (no space anywhere in it to break at)
 * is the one case that still falls back to a mid-word break, since there
 * is no other way to keep it from overflowing forever. Test Lab's own
 * preview shares this function, so both wrap the same way at the same
 * scale.
 */
export function wrapLines(
  text: string,
  glyphs: Record<string, Glyph | undefined>,
  unitsPerEm: number,
  kerningPairs: Record<string, number>,
  trackingUnits = 0,
  maxWidthUnits = Infinity,
  wordSpacing?: number
): WrappedLine[] {
  const out: WrappedLine[] = [];
  let lineChars: string[] = [];
  let advance = 0;
  // Index within lineChars right after the most recent space — i.e. the
  // start of the word currently being accumulated. -1 means the line so
  // far is a single unbroken token with no word-break opportunity yet.
  let wordStart = -1;

  const advanceFor = (chars: string[]) =>
    chars.length ? layoutLine(chars.join(""), glyphs, unitsPerEm, kerningPairs, trackingUnits, wordSpacing).totalAdvance : 0;

  const flush = () => {
    const lineText = lineChars.join("");
    out.push({ text: lineText, layout: layoutLine(lineText, glyphs, unitsPerEm, kerningPairs, trackingUnits, wordSpacing) });
    lineChars = [];
    advance = 0;
    wordStart = -1;
  };

  for (const ch of Array.from(text)) {
    if (ch === "\n") {
      flush();
      continue;
    }

    const g = glyphs[ch];
    const glyphAdvance = ch === " " && wordSpacing != null ? wordSpacing : g ? g.advanceWidth : fallbackAdvance(ch, unitsPerEm, wordSpacing);
    const previous = lineChars[lineChars.length - 1] ?? null;
    const between = previous ? trackingUnits + (kerningPairs[kerningKey(previous, ch)] ?? 0) : 0;
    const nextAdvance = advance + between + glyphAdvance;
    const overflows = lineChars.length > 0 && nextAdvance > maxWidthUnits;

    if (overflows && ch === " ") {
      // A trailing space that would overflow just ends the line — it
      // doesn't need to reappear (invisibly) at the start of the next one.
      flush();
      continue;
    }

    if (overflows && wordStart > 0) {
      // Break at the last word boundary: everything up to (not including)
      // the space becomes this line, and the word already being typed
      // carries over to start the next one.
      const thisLine = lineChars.slice(0, wordStart - 1);
      const carry = lineChars.slice(wordStart);
      out.push({ text: thisLine.join(""), layout: layoutLine(thisLine.join(""), glyphs, unitsPerEm, kerningPairs, trackingUnits, wordSpacing) });
      lineChars = [...carry, ch];
      advance = advanceFor(lineChars);
      wordStart = -1;
      continue;
    }

    if (overflows) {
      // No word-break opportunity on this line at all (one token wider
      // than the box by itself) — fall back to a mid-word break rather
      // than let it overflow indefinitely.
      flush();
      lineChars.push(ch);
      advance = glyphAdvance;
      continue;
    }

    lineChars.push(ch);
    advance = nextAdvance;
    if (ch === " ") wordStart = lineChars.length;
  }

  flush();
  return out.length
    ? out
    : [{ text: "", layout: layoutLine("", glyphs, unitsPerEm, kerningPairs, trackingUnits, wordSpacing) }];
}

/** Glyph index nearest to x, used by the glyph-centric kerning workflow. */
export function nearestGlyphIndex(placed: PlacedChar[], xUnits: number): number {
  if (placed.length === 0) return -1;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    const center = p.x + p.advance / 2;
    const dist = Math.abs(xUnits - center);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}
