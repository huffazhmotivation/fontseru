export function unicodeHex(codePoint: number): string {
  return "U+" + codePoint.toString(16).toUpperCase().padStart(4, "0");
}

// True Unicode combining marks (category Mn — e.g. the Vietnamese tone
// marks U+0309/U+0323 in MULTILINGUAL_MARK_SLOTS) have zero advance width
// and are only ever meant to render attached to a preceding base
// character. Rendered completely alone as plain text — which is exactly
// what an undrawn glyph's placeholder does — is undefined per Unicode:
// which glyph (if any) shows up depends entirely on the device's
// font/text-shaping stack, so it's never guaranteed to look the same
// (or to render at all) across platforms. Used by CombiningMarkGhost.tsx
// to swap the placeholder for an SVG shape FontSeru draws itself instead
// of relying on the platform to render the character.
const COMBINING_MARK_RE = /\p{Mn}/u;

export function isCombiningMark(char: string): boolean {
  return COMBINING_MARK_RE.test(char);
}
