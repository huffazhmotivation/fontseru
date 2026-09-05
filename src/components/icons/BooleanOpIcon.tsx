import type { BooleanOp } from "@/editor/booleanOps";

/**
 * Icons for the boolean shape actions (no text by design — used icon-only
 * with a `title` tooltip). Two overlapping SQUARES stand in for the two
 * selected shapes, offset diagonally so they share a square of overlap —
 * and each icon draws the ACTUAL resulting outline for its operation
 * (solid fill = "this is what you get"), not just a generic pair of shapes
 * with a subtle style difference. That's the point: someone unfamiliar
 * with "union/subtract/intersect" as words should still be able to read
 * the icon as "the two boxes become one L-shape", "a bite gets cut out of
 * the front box", or "only the middle where they overlap survives".
 *
 * Square A: (3,3)-(13,13). Square B: (8,8)-(18,18), offset by (5,5) so
 * they overlap exactly on (8,8)-(13,13) — every path below is built from
 * those same nine coordinates, hand-picked (not approximated) so the
 * corners always line up pixel-for-pixel between the outline and the
 * filled result.
 */
export function BooleanOpIcon({ op, size = 14 }: { op: BooleanOp; size?: number }) {
  const common = { viewBox: "0 0 20 20", width: size, height: size, fill: "none" as const };

  if (op === "union") {
    // The two squares fully merged: one continuous L-shaped (hexagonal)
    // outline, filled solid — "these become one shape".
    return (
      <svg {...common}>
        <path
          d="M3 3 H13 V8 H18 V18 H8 V13 H3 Z"
          fill="currentColor"
          fillOpacity="0.55"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (op === "subtract") {
    // Front square (A) solid, with the overlapping corner cut away —
    // an L-shaped notch — plus the back square (B) drawn as a faint
    // dashed outline so it reads as "the shape that got subtracted".
    return (
      <svg {...common}>
        <rect x="8" y="8" width="10" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.2 2" opacity="0.5" />
        <path
          d="M3 3 H13 V8 H8 V13 H3 Z"
          fill="currentColor"
          fillOpacity="0.55"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // Intersect: both squares shown only as thin outline context, and just
  // the shared middle square is filled solid — "only where they overlap
  // survives".
  return (
    <svg {...common}>
      <rect x="3" y="3" width="10" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.1" opacity="0.4" />
      <rect x="8" y="8" width="10" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.1" opacity="0.4" />
      <rect x="8" y="8" width="5" height="5" fill="currentColor" fillOpacity="0.65" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
