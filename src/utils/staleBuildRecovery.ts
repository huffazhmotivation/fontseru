// A PWA relaunch (or a long-idle tab) can land on an app shell that still
// references an old, hashed JS chunk filename that no longer exists on the
// server/cache after a new deploy (the service worker purges old-version
// assets as soon as it activates — see UpdatePrompt.tsx). When that happens,
// the dynamic import() for that chunk (lazy-loaded overlays, Motion Studio,
// etc.) fails, and — since there is no error boundary catching that failure
// at the moment it happens — the whole React tree can unmount with nothing
// rendered, i.e. the "blank white screen" symptom.
//
// The fix is simply: when this specific kind of failure happens, force a
// full page reload instead of leaving the page dead. A real reload fetches
// the CURRENT index.html + CURRENT hashed assets (all in sync), which is
// exactly the same recovery a manual browser refresh gives.
//
// Guarded with sessionStorage so a genuinely broken build (unrelated to a
// stale cache) can't trap the page in an infinite reload loop — after one
// attempt within a short window we stop and let the caller show a manual
// "reload" fallback instead.

const GUARD_KEY = "fontseru.staleBuildReloadAt";
const GUARD_WINDOW_MS = 15_000;

export function shouldAttemptReload(): boolean {
  try {
    const last = Number(sessionStorage.getItem(GUARD_KEY) || 0);
    return !last || Date.now() - last > GUARD_WINDOW_MS;
  } catch {
    // sessionStorage unavailable (private mode, etc.) — allow one attempt.
    return true;
  }
}

export function reloadForFreshBuild(): void {
  try {
    sessionStorage.setItem(GUARD_KEY, String(Date.now()));
  } catch {
    /* ignore — worst case we just don't guard against a loop */
  }
  window.location.reload();
}

/** True if an error looks like a failed dynamic import of a hashed chunk
 *  (the exact wording differs per browser engine, so this matches all the
 *  common phrasings rather than one exact string). */
export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /dynamically imported module|failed to fetch|loading chunk|import\(\)|failed to load module script/i.test(
    message
  );
}
