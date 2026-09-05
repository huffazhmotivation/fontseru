/**
 * Flip icons. Instead of the generic arrow-bracket glyph, this draws a
 * lopsided triangle (a shape with no symmetry of its own, so mirroring is
 * actually visible) solid on one side of a dashed axis line, and the same
 * triangle mirrored across that axis, drawn faint/outline-only on the
 * other side — "this solid shape becomes that faint one, flipped over the
 * line". That reads as "flip" at a glance even to someone who's never
 * seen the word used as a button before, which the old two-triangles-and-
 * an-arrow icon didn't.
 */
export function FlipIcon({ direction, size = 14 }: { direction: "horizontal" | "vertical"; size?: number }) {
  const common = { viewBox: "0 0 20 20", width: size, height: size, fill: "none" as const };

  if (direction === "horizontal") {
    // Mirror axis is the vertical dashed line at x=10. Solid triangle
    // points right (toward the axis) on the left; its mirror points left
    // on the right.
    return (
      <svg {...common}>
        <line x1="10" y1="2" x2="10" y2="18" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" opacity="0.55" />
        <path d="M4 4 L4 14 L8.5 9 Z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
        <path d="M16 4 L16 14 L11.5 9 Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" opacity="0.55" />
      </svg>
    );
  }

  // Mirror axis is the horizontal dashed line at y=10. Solid triangle
  // points down (toward the axis) on top; its mirror points up below.
  return (
    <svg {...common}>
      <line x1="2" y1="10" x2="18" y2="10" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" opacity="0.55" />
      <path d="M4 4 L14 4 L9 8.5 Z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M4 16 L14 16 L9 11.5 Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" opacity="0.55" />
    </svg>
  );
}
