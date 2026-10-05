/**
 * Aplikasi desktop (Electron, lihat folder `desktop/`) memuat FontSeru lewat skema `app://`.
 * Di versi ini tidak ada login: semua fitur Pro aktif langsung.
 */
export const isDesktopApp = typeof window !== "undefined" && window.location.protocol === "app:";
