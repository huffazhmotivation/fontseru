export function unicodeHex(codePoint: number): string {
  return "U+" + codePoint.toString(16).toUpperCase().padStart(4, "0");
}

// True Unicode combining marks (category Mn — e.g. the Vietnamese tone
// marks U+0309/U+0323 in MULTILINGUAL_MARK_SLOTS) have zero advance width
// and are only ever meant to render attached to a preceding base
// character. Rendered completely alone in a plain <text>/<span> — which is
// exactly what happens for an undrawn glyph's placeholder character — some
// text-shaping stacks (notably iPadOS/iOS Safari, and some mobile Chrome
// builds) draw nothing at all, since there's no base glyph to attach to
// and no automatic dotted-circle fallback the way desktop Chrome/macOS
// tends to supply. Desktop and mobile were never actually inconsistent in
// behavior — isolated combining marks are simply undefined without a
// base — so give them one.
const COMBINING_MARK_RE = /\p{Mn}/u;

export function isCombiningMark(char: string): boolean {
  return COMBINING_MARK_RE.test(char);
}

// Dotted circle (U+25CC) is the Unicode-recommended stand-in base for
// displaying an isolated combining mark. Only for display — never persisted
// or treated as part of the glyph's own `char`/data.
export function displayChar(char: string): string {
  return isCombiningMark(char) ? "\u25CC" + char : char;
}
