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
  installStandaloneViewportFix();
  installTouchInputFixes();
}

/* ------------------------------------------------------------------------------------------------
   Ukuran layar penuh saat dibuka dari Home Screen (PWA) iPad.
   Di iPadOS mode standalone, window.innerHeight / 100vh / 100dvh sering lebih pendek dari layar sebenarnya
   (apalagi setelah diputar atau dibuka dari app switcher), sehingga bagian bawah app menyisakan strip kosong.
   Di sini tinggi/lebar layar sungguhan dari screen.* diukur dan dipasang sebagai --fs-app-h / --fs-app-w di <html>;
   CSS tablet memakainya untuk root Mode Font & Motion. Hanya aktif di PWA standalone — Safari biasa,
   desktop, dan HP tidak disentuh.
   ------------------------------------------------------------------------------------------------ */
function isStandalonePwa(): boolean {
  try {
    if ((navigator as unknown as { standalone?: boolean }).standalone === true) return true;
    return Boolean(window.matchMedia?.("(display-mode: standalone)").matches || window.matchMedia?.("(display-mode: fullscreen)").matches);
  } catch { return false; }
}

let viewportFixInstalled = false;
let keyboardSync: (() => void) | null = null;
function installStandaloneViewportFix(): void {
  if (viewportFixInstalled || typeof window === "undefined") return;
  if (!isTabletDevice() || !isStandalonePwa()) return;
  viewportFixInstalled = true;
  const root = document.documentElement;
  const sync = () => {
    const sw = window.screen?.width || 0;
    const sh = window.screen?.height || 0;
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    if (!sw || !sh) return;
    const landscape = iw > ih;
    // screen.width/height di iPadOS bisa tetap "potret" meski layar diputar → cocokkan dengan orientasi sekarang.
    const long = Math.max(sw, sh);
    const short = Math.min(sw, sh);
    const fullH = landscape ? short : long;
    const fullW = landscape ? long : short;
    // Hanya MEMPERBESAR bila innerHeight kurang dari layar (selisih wajar ≤ 80px); nilai ngawur diabaikan.
    let h = fullH > ih && fullH - ih <= 80 ? fullH : ih;
    const w = fullW > iw && fullW - iw <= 80 && Math.abs(fullW - iw) < 80 ? fullW : iw;
    // Keyboard terbuka: iPadOS TIDAK mengecilkan layout viewport (hanya visual viewport), jadi tanpa ini
    // bagian bawah app (bottom bar) tertutup keyboard dan halaman digeser iOS sehingga app tampak "meloncat".
    // Saat sebuah kolom teks sedang fokus, tinggi root disamakan dengan area yang benar-benar terlihat.
    const vv = window.visualViewport;
    let top = 0;
    if (vv && isEditableFocused() && ih - vv.height > 120) {
      h = Math.max(240, Math.round(vv.height));
      top = Math.max(0, Math.round(vv.offsetTop));
    }
    root.style.setProperty("--fs-app-h", `${h}px`);
    root.style.setProperty("--fs-app-w", `${w}px`);
    root.style.setProperty("--fs-app-top", `${top}px`);
  };
  keyboardSync = sync;
  sync();
  // iPadOS memperbarui ukuran sesudah rotasi / kembali dari app switcher dengan jeda, jadi ukur beberapa kali.
  const later = () => { sync(); window.setTimeout(sync, 120); window.setTimeout(sync, 400); window.setTimeout(sync, 1000); };
  window.addEventListener("resize", later);
  window.addEventListener("orientationchange", later);
  window.addEventListener("pageshow", later);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) later(); });
  window.setTimeout(sync, 300);
  window.setTimeout(sync, 1200);
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


/* ------------------------------------------------------------------------------------------------
   Perbaikan input di iPad / iPhone (Safari & PWA Home Screen)
   1. Fokus ke kolom teks membuat iOS men-zoom halaman (font < 16px); zoom itu tersangkut — setelah app ditutup
      dan dibuka lagi tampilan jadi membesar & bergeser. Di sini zoom di-reset begitu kolom kehilangan fokus,
      saat app kembali tampil, dan saat orientasi berubah. Pinch-zoom halaman diblok (kanvas punya zoom sendiri).
   2. Keyboard muncul/hilang → ukur ulang tinggi root (lihat sync di atas) dan kembalikan scroll halaman ke 0.
   ------------------------------------------------------------------------------------------------ */
export function isEditableFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  const t = ((el as HTMLInputElement).type || "text").toLowerCase();
  return !["range", "checkbox", "radio", "button", "submit", "reset", "file", "color"].includes(t);
}

let touchFixesInstalled = false;
function installTouchInputFixes(): void {
  if (touchFixesInstalled || typeof window === "undefined") return;
  const touch = (navigator.maxTouchPoints || 0) > 1 || Boolean(window.matchMedia?.("(pointer: coarse)").matches);
  if (!touch) return;
  touchFixesInstalled = true;

  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const baseContent = meta?.content ?? "";
  const resetZoom = () => {
    try {
      if (isEditableFocused()) return;
      const vv = window.visualViewport;
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
      if (meta && vv && vv.scale > 1.01) {
        // Mengubah isi meta viewport sesaat memaksa iOS menghitung ulang skala (kembali ke 1).
        meta.content = `${baseContent}, minimum-scale=1`;
        window.setTimeout(() => { meta.content = baseContent; keyboardSync?.(); }, 60);
      }
    } catch { /* abaikan */ }
  };
  const resetSoon = () => {
    window.setTimeout(() => { resetZoom(); keyboardSync?.(); }, 60);
    window.setTimeout(() => { resetZoom(); keyboardSync?.(); }, 350);
  };

  // Pinch-zoom bawaan Safari (kanvas memakai pointer event sendiri, jadi tidak terganggu).
  for (const t of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  }
  document.addEventListener("focusout", resetSoon, true);
  document.addEventListener("focusin", () => { keyboardSync?.(); window.setTimeout(() => keyboardSync?.(), 250); }, true);
  window.addEventListener("pageshow", resetSoon);
  window.addEventListener("orientationchange", resetSoon);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resetSoon(); });
  window.visualViewport?.addEventListener("resize", () => {
    keyboardSync?.();
    if (isEditableFocused() && window.scrollY) window.scrollTo(0, 0);
  });
  window.visualViewport?.addEventListener("scroll", () => {
    if (isEditableFocused()) keyboardSync?.();
  });
  resetSoon();
}
