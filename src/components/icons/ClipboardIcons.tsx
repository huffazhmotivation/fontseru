/**
 * Copy / Paste icons for the top bar.
 *
 * Same visual language as FlipIcon: a faint shape for "where it came
 * from" and a solid one for "what you get", on a 20×20 grid with the same
 * ~1.6 stroke weight as the Lucide icons they sit next to, so the whole
 * row reads as one set.
 *
 *  Copy  — a faint sheet behind, a crisp sheet in front: "one becomes two".
 *  Paste — a clipboard outline with a solid block landing inside it:
 *          "the copied thing is placed here".
 */
interface IconProps {
  size?: number;
}

export function CopyIcon({ size = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" aria-hidden="true">
      <path
        d="M13 4.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v7.5A1.5 1.5 0 0 0 4 13h.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.5"
      />
      <rect
        x="7"
        y="7"
        width="10.5"
        height="10.5"
        rx="1.8"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}

export function PasteIcon({ size = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" aria-hidden="true">
      <path
        d="M7 3.75H5.5A1.75 1.75 0 0 0 3.75 5.5v10.75A1.75 1.75 0 0 0 5.5 18h9a1.75 1.75 0 0 0 1.75-1.75V5.5A1.75 1.75 0 0 0 14.5 3.75H13"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="7" y="2" width="6" height="3.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="7" y="9.25" width="6" height="5.75" rx="1" fill="currentColor" />
    </svg>
  );
}
