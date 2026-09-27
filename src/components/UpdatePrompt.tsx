import { useEffect, useRef, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
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
 * take over — at that point it shows a big, hard-to-miss centered popup
 * (same visual language as EmailConfirmedWelcome's `.fm-auth-dialog`) so
 * that ANY session running a stale build — a browser tab left open for
 * days, or an "Add to Home Screen" PWA icon that behaves like a tab that
 * never really closes — is unmistakably told a new version is ready,
 * instead of a small corner toast that's easy to miss or ignore.
 *
 * Detection itself (registration, interval, focus, visibility — see the
 * effect below) is what makes an old/idle session actually notice a new
 * deploy in the first place; this component only renders the notice once
 * `needRefresh` flips true.
 */
export function UpdatePrompt() {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

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

  // updateServiceWorker(true) tells the waiting SW to skip-waiting + take
  // over, then reloads the page for us automatically once it has — so a
  // click here is genuinely "one click, done": no separate manual refresh
  // step for the user. isUpdating just covers the brief gap before that
  // reload actually happens, so the button can't be double-clicked.
  const handleUpdate = () => {
    if (isUpdating) return;
    setIsUpdating(true);
    updateServiceWorker(true);
  };

  return (
    <div
      className="fm-auth-backdrop fm-update-backdrop"
      role="alertdialog"
      aria-live="assertive"
      aria-labelledby="update-modal-title"
      data-testid="update-sw-modal"
    >
      <div className="fm-auth-dialog fm-welcome-dialog fm-update-dialog">
        <span className="fm-update-badge">
          <Sparkles size={11} strokeWidth={2.5} aria-hidden="true" />
          Pembaruan tersedia
        </span>
        <div className="fm-update-icon-wrap" aria-hidden="true">
          <span className="fm-update-icon-ring" />
          <span className="fm-update-icon-ring fm-update-icon-ring-delay" />
          <span className="fm-update-icon-core">
            <RefreshCw size={20} strokeWidth={2.25} className={isUpdating ? "fm-update-icon-spin" : undefined} />
          </span>
        </div>
        <p id="update-modal-title" className="fm-update-title">Versi baru FontSeru sudah siap!</p>
        <div className="fm-update-content-box">
          <p className="fm-update-sub">
            Ada pembaruan fitur &amp; perbaikan terbaru. Perbarui sekarang — halaman akan otomatis
            dimuat ulang setelah selesai.
          </p>
        </div>
        <button
          type="button"
          className="fm-auth-submit-btn fm-auth-btn-pro"
          onClick={handleUpdate}
          disabled={isUpdating}
          data-testid="update-sw-btn"
        >
          <RefreshCw size={15} strokeWidth={2.25} className={isUpdating ? "fm-update-icon-spin" : undefined} aria-hidden="true" />
          {isUpdating ? "Memperbarui..." : "Perbarui Sekarang"}
        </button>
        <button
          type="button"
          className="fm-update-dismiss"
          onClick={() => setNeedRefresh(false)}
          disabled={isUpdating}
          data-testid="update-sw-dismiss"
        >
          Nanti saja
        </button>
      </div>
    </div>
  );
}
