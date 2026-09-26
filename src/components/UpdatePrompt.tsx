import { useEffect, useRef } from "react";
import { RefreshCw, X } from "lucide-react";
import { useRegisterSW } from "virtual:pwa-register/react";

// A tab left open for a long time (or the app opened from an "Add to Home
// Screen" icon, which behaves like a tab that never really closes) only
// gets a fresh look at the service worker on the browser's own schedule —
// normally just once on load. Re-checking on an interval, and whenever the
// tab regains focus, is what actually makes an old/idle session notice a
// new deploy instead of quietly running a stale build forever.
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Mounted once at the app root (see main.tsx). Renders nothing until a new
 * deploy's service worker has finished downloading and is sitting ready to
 * take over — at that point it shows a small, non-auto-dismissing notice so
 * the user can apply it on their own terms rather than the page silently
 * reloading out from under an in-progress edit.
 */
export function UpdatePrompt() {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      registrationRef.current = registration ?? null;
      // Check immediately on registration too — not just on the interval/
      // focus/visibility triggers below — so a tab that's been sitting open
      // on an old build sees the "update available" popup as soon as it's
      // (re)loaded, instead of waiting up to UPDATE_CHECK_INTERVAL_MS or for
      // the user to switch away and back.
      registration?.update().catch(() => {});
    },
    onRegisterError(error) {
      console.error("Service worker registration failed:", error);
    },
  });

  useEffect(() => {
    const checkForUpdate = () => registrationRef.current?.update().catch(() => {});
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") checkForUpdate();
    };
    const interval = window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", checkForUpdate);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", checkForUpdate);
    };
  }, []);

  if (!needRefresh) return null;

  return (
    <div className="fm-update-toast" role="status" aria-live="polite">
      <RefreshCw size={16} strokeWidth={2.25} aria-hidden="true" />
      <span>Versi baru FontSeru sudah tersedia.</span>
      <div className="fm-update-toast-actions">
        <button
          type="button"
          className="fm-action-btn accent"
          onClick={() => updateServiceWorker(true)}
          data-testid="update-sw-btn"
        >
          Perbarui sekarang
        </button>
        <button
          type="button"
          className="fm-update-toast-close"
          onClick={() => setNeedRefresh(false)}
          aria-label="Tutup notifikasi pembaruan"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
