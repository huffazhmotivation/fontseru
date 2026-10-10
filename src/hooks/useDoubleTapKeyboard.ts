import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

/**
 * Keyboard layar HANYA muncul saat kotak teks diketuk 2x (iPad / tablet / HP).
 *
 * Di Test Lab, hampir semua interaksi (menggeser kerning, ganti preset, mengetuk glyph) memanggil `focus()` pada
 * textarea tersembunyi supaya caret kustom tetap bekerja — di iPad itu memunculkan keyboard setiap saat.
 * `inputMode="none"` membuat elemen tetap fokus (caret, seleksi, keyboard fisik jalan) tanpa keyboard layar.
 * Ketukan ganda mengaktifkan `inputMode="text"` lalu memfokus ulang elemen di dalam gestur yang sama (syarat iOS),
 * dan keyboard dimatikan lagi begitu elemen kehilangan fokus. Mouse / desktop tidak terpengaruh.
 */
export function useDoubleTapKeyboard<T extends HTMLElement>(ref: RefObject<T>) {
  const coarse = useMemo(
    () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(pointer: coarse)").matches),
    []
  );
  const [armed, setArmed] = useState(false);
  const last = useRef<{ t: number; x: number; y: number } | null>(null);
  const refocusing = useRef(false);

  const onTap = useCallback(
    (e: { clientX: number; clientY: number; pointerType?: string }) => {
      if (!coarse || e.pointerType === "mouse") return;
      const now = Date.now();
      const l = last.current;
      if (l && now - l.t < 400 && Math.hypot(e.clientX - l.x, e.clientY - l.y) < 30) {
        last.current = null;
        flushSync(() => setArmed(true));
        const el = ref.current;
        if (el) {
          refocusing.current = true;
          el.blur();
          el.focus({ preventScroll: true });
          refocusing.current = false;
        }
      } else {
        last.current = { t: now, x: e.clientX, y: e.clientY };
      }
    },
    [coarse, ref]
  );

  const onBlur = useCallback(() => {
    if (!refocusing.current) setArmed(false);
  }, []);

  return { inputMode: coarse && !armed ? ("none" as const) : undefined, onBlur, onTap };
}
