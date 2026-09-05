import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Replaces a permanently-visible `.fm-hint` paragraph with a small "i"
 * badge. The description only appears in a floating bubble on hover,
 * keyboard focus, or tap/click — so panels stay compact instead of being
 * padded out with feature-explainer copy that most people only need once.
 *
 * Positioning is pure CSS (the bubble is absolutely positioned against
 * this component's own — unmoved — wrapper), so no measurement/JS is
 * needed and it can't drift from the icon it belongs to.
 */
export function InfoTip({
  children,
  className = "",
  align = "start",
}: {
  children: ReactNode;
  className?: string;
  /** Which edge the bubble hangs from, so it can be flipped near the panel's right edge. */
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Tap-away closes it on touch/click devices (hover alone won't apply there).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span
      ref={wrapRef}
      className={`fm-infotip ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        className="fm-infotip-badge"
        aria-label="More information"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        i
      </button>
      {open && (
        <span className={`fm-infotip-bubble fm-infotip-bubble-${align}`} role="tooltip">
          {children}
        </span>
      )}
    </span>
  );
}
