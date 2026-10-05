import { useEffect, useState } from "react";

/**
 * Deteksi iPad / tablet Android untuk Mode Font & Mode Motion (Mode Design punya deteksi sendiri di dalam iframe-nya).
 * Hasilnya dipasang sebagai `data-tablet="true"` di <html>, sehingga CSS tablet cukup memakai `html[data-tablet="true"]`
 * dan tidak menyentuh tampilan desktop/HP. `?tablet=1` / `?tablet=0` pada alamat memaksa nyala/mati (berguna untuk uji di desktop).
 */
function detectTablet(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("tablet");
    if (q === "1") return true;
    if (q === "0") return false;
  } catch { /* abaikan */ }
  const nav = navigator;
  // iPadOS 13+ mengaku sebagai Mac, bedanya ia punya layar sentuh.
  const ipad = /iPad/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  if (ipad) return true;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches;
  const shortSide = Math.min(window.screen?.width || 0, window.screen?.height || 0);
  return Boolean(coarse && shortSide >= 600);
}

let cached: boolean | null = null;
export function isTabletDevice(): boolean {
  if (cached === null) cached = detectTablet();
  return cached;
}

/** pasang atribut di <html> (dipanggil sekali saat start) */
export function applyTabletAttr(): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-tablet", isTabletDevice() ? "true" : "false");
}

export function useIsTablet(): boolean {
  const [t] = useState(isTabletDevice);
  useEffect(() => { applyTabletAttr(); }, []);
  return t;
}

/* ------------------------------------------------------------------------------------------------
   Modifier virtual (Shift / Alt / Cmd-Ctrl) untuk tablet tanpa keyboard.
   Kanvas Font dan Motion membaca e.shiftKey / e.altKey / e.metaKey langsung dari event pointer. Alih-alih mengubah puluhan
   tempat itu, satu pendengar fase-capture di window menimpa properti tersebut pada event asli sebelum React membacanya.
   ------------------------------------------------------------------------------------------------ */
export type ModKey = "shift" | "alt" | "meta";
export const virtualMods: Record<ModKey, boolean> = { shift: false, alt: false, meta: false };
const listeners = new Set<() => void>();
export const subscribeMods = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export function setVirtualMod(k: ModKey, on: boolean) {
  if (virtualMods[k] === on) return;
  virtualMods[k] = on;
  listeners.forEach((fn) => fn());
}

let installed = false;
export function installVirtualModifiers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const apply = (e: Event) => {
    const v = virtualMods;
    if (!v.shift && !v.alt && !v.meta) return;
    const define = (prop: string, on: boolean) => {
      if (!on) return;
      try { Object.defineProperty(e, prop, { value: true, configurable: true }); } catch { /* abaikan */ }
    };
    define("shiftKey", v.shift);
    define("altKey", v.alt);
    define("metaKey", v.meta);
  };
  for (const t of ["pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup", "click", "wheel", "contextmenu"]) {
    window.addEventListener(t, apply, true);
  }
}
