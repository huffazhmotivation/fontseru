import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { flushSync } from "react-dom";

/**
 * Keyboard layar HANYA muncul lewat tombol ikon keyboard di kotak teks, atau ketuk 2x (iPad / tablet / HP).
 *
 * Kotak teks Test Lab adalah textarea transparan yang menutupi seluruh area preview, dan banyak interaksi
 * (geser kerning, ganti preset, ketuk glyph) memanggil `focus()` padanya supaya caret kustom bekerja. Di iPad tiap
 * fokus itu memunculkan keyboard — atau, bila diketuk dengan Apple Pencil, bar Scribble dari bawah.
 *
 * Di layar sentuh, selama keyboard belum diminta:
 *  - textarea tidak menerima sentuhan (`pointer-events: none`), jadi ketukan jatuh ke area preview yang hanya
 *    memindah caret kustom;
 *  - `focus()` terprogram pada elemen ini diabaikan (seleksi/caret tetap diperbarui tanpa fokus).
 * `openKeyboard()` (tombol ikon / ketuk 2x) mengaktifkannya lalu memfokus elemen langsung di dalam ketukan pengguna
 * (syarat iOS agar keyboard muncul). Begitu elemen kehilangan fokus, kembali ke mode tanpa keyboard.
 * Mouse / desktop tidak terpengaruh sama sekali.
 */
export function useDoubleTapKeyboard<T extends HTMLElement>(ref: RefObject<T>) {
  const coarse = useMemo(
    () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(pointer: coarse)").matches),
    []
  );
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const last = useRef<{ t: number; x: number; y: number } | null>(null);

  // Abaikan focus() terprogram selama keyboard belum diminta (hanya di layar sentuh).
  useEffect(() => {
    const el = ref.current as (T & { focus: HTMLElement["focus"] }) | null;
    if (!el || !coarse) return;
    const nativeFocus = HTMLElement.prototype.focus;
    el.focus = function guardedFocus(this: HTMLElement, opts?: FocusOptions) {
      if (armedRef.current) nativeFocus.call(this, opts);
    };
    return () => {
      delete (el as unknown as { focus?: unknown }).focus;
    };
  });

  const openKeyboard = useCallback(() => {
    armedRef.current = true;
    flushSync(() => setArmed(true));
    const el = ref.current;
    if (!el) return;
    if (document.activeElement === el) el.blur();
    HTMLElement.prototype.focus.call(el, { preventScroll: true });
  }, [ref]);

  const onTap = useCallback(
    (e: { clientX: number; clientY: number; pointerType?: string }) => {
      if (!coarse || e.pointerType === "mouse") return;
      const now = Date.now();
      const l = last.current;
      if (l && now - l.t < 400 && Math.hypot(e.clientX - l.x, e.clientY - l.y) < 30) {
        last.current = null;
        openKeyboard();
      } else {
        last.current = { t: now, x: e.clientX, y: e.clientY };
      }
    },
    [coarse, openKeyboard]
  );

  const onBlur = useCallback(() => {
    if (!armedRef.current) return;
    armedRef.current = false;
    setArmed(false);
  }, []);

  const locked = coarse && !armed;
  const style: CSSProperties | undefined = locked ? { pointerEvents: "none" } : undefined;
  return { style, onBlur, onTap, openKeyboard, showButton: locked };
}
