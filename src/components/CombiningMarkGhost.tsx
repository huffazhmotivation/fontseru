/**
 * Placeholder shown for an undrawn glyph whose `char` is a bare Unicode
 * combining mark (category Mn — e.g. the Vietnamese tone marks U+0309/
 * U+0323, see MULTILINGUAL_MARK_SLOTS). A combining mark rendered alone
 * as plain text has no base character to attach to, which is undefined
 * behavior per Unicode: different OS/browser text-shaping stacks resolve
 * it differently (nothing at all, a tofu/.notdef box, or the mark drawn
 * at an arbitrary spot), and depends on whether the active font even has
 * a glyph for the mark or for a dotted-circle fallback.
 *
 * Previously this was "fixed" by prefixing a literal dotted-circle
 * character (U+25CC) so the mark would have something to combine with.
 * That only swapped one font/platform-dependent render for another —
 * still text, still resolved by whatever font+shaper the device happens
 * to have, so it looked different on different devices and sometimes
 * rendered as a tofu box where the font lacked the combined glyph.
 *
 * This draws the dotted-circle convention ourselves as plain SVG
 * (`<circle>`/`<svg>` shapes), not text — no font, no shaping engine, no
 * per-platform variance. Pixel-identical everywhere, exactly like the
 * rest of FontSeru's own vector rendering.
 */
import { memo } from "react";

/** For use as a direct child of an existing <svg> (ghost canvas, overview
 * grid tiles, multi-edit cells). `y` is the baseline the equivalent text
 * placeholder would have sat on; `size` is the equivalent font-size. */
export const CombiningMarkGhostMark = memo(function CombiningMarkGhostMark({
  x,
  y,
  size,
  stroke,
  opacity = 1,
}: {
  x: number;
  y: number;
  size: number;
  stroke: string;
  opacity?: number;
}) {
  const r = size * 0.3;
  const cy = y - size * 0.34;
  return (
    <circle
      cx={x}
      cy={cy}
      r={r}
      fill="none"
      stroke={stroke}
      strokeWidth={Math.max(1, size * 0.045)}
      strokeDasharray={`${Math.max(1, size * 0.045)} ${size * 0.09}`}
      strokeLinecap="round"
      opacity={opacity}
      style={{ pointerEvents: "none" }}
      aria-hidden="true"
    />
  );
});

/** For use inline among regular HTML (thumbnail tiles, panel labels).
 * Sized in `em` so it matches whatever font-size the surrounding
 * className already sets, and colored via `currentColor` so it follows
 * the surrounding `color` the same way the text it replaces did. */
export const CombiningMarkIcon = memo(function CombiningMarkIcon({
  className,
}: {
  className?: string;
}) {
  return (
    <svg
      className={className}
      width="0.6em"
      height="0.6em"
      viewBox="0 0 24 24"
      style={{ display: "inline-block", verticalAlign: "middle", flex: "0 0 auto" }}
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeDasharray="2.6 4.6"
        strokeLinecap="round"
      />
    </svg>
  );
});
