/** Minimal single-stroke sun/moon glyphs for the theme and preview-background
 * toggles. Hand-drawn (not lucide-react) so the sun keeps a thin, sparse set
 * of rays instead of lucide's 8 heavier ones, and both read as plain line
 * icons — no filled shapes — matching the rest of the app's outline icon
 * language (see BooleanOpIcon in this folder). */
export function SunIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="4.2" stroke="currentColor" strokeWidth="1.4" />
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M10 1.6v2M10 16.4v2M18.4 10h-2M3.6 10h-2" />
        <path d="M15.6 4.4l-1.4 1.4M5.8 14.2l-1.4 1.4M15.6 15.6l-1.4-1.4M5.8 5.8L4.4 4.4" />
      </g>
    </svg>
  );
}

export function MoonIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <path
        d="M17 12.1A7.1 7.1 0 0 1 7.9 3a7.1 7.1 0 1 0 9.1 9.1Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
