import type { BooleanOp } from "@/editor/booleanOps";

/** Minimal outline icons for the boolean shape actions (no text by design —
 * used icon-only with a `title` tooltip). Hand-drawn rather than pulled from
 * lucide-react since there's no matching union/subtract/intersect glyph there. */
export function BooleanOpIcon({ op, size = 14 }: { op: BooleanOp; size?: number }) {
  const common = { viewBox: "0 0 20 20", width: size, height: size, fill: "none" as const };
  if (op === "union") {
    return (
      <svg {...common}>
        <circle cx="7.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="12.5" cy="11.5" r="5.5" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  if (op === "subtract") {
    return (
      <svg {...common}>
        <circle cx="7.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="12.5" cy="11.5" r="5.5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.2" opacity="0.55" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="7.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.1" opacity="0.35" />
      <circle cx="12.5" cy="11.5" r="5.5" stroke="currentColor" strokeWidth="1.1" opacity="0.35" />
      {/* Lens formed by the two circles' actual intersection points. */}
      <path d="M7.6 14 A5.5 5.5 0 0 1 12.4 6 A5.5 5.5 0 0 1 7.6 14 Z" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
