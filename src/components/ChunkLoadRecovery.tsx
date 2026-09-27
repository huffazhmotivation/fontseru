import { useEffect } from "react";
import { isStaleChunkError, reloadForFreshBuild, shouldAttemptReload } from "@/utils/staleBuildRecovery";

/**
 * Mounted once at the app root (see main.tsx), renders nothing. Listens for
 * two things that both mean "this page is running a stale build whose
 * hashed asset references no longer exist" — see staleBuildRecovery.ts for
 * the full story of why an "Add to Home Screen" relaunch after a deploy can
 * hit this:
 *
 *  - `vite:preloadError`, the event Vite's own runtime fires specifically
 *    when a dynamically-imported chunk (lazy(() => import(...)) — Motion
 *    Studio, Test Lab, Feature Builder, etc.) fails to load.
 *  - a plain `unhandledrejection` whose message matches the same failure,
 *    as a fallback for any rejection that doesn't go through Vite's event.
 *
 * Either one triggers a guarded full reload, which is the same recovery a
 * manual browser refresh gives (fresh index.html + fresh, matching hashed
 * assets) — turning what would otherwise be a silent blank white screen
 * into a one-time automatic recovery instead.
 */
export function ChunkLoadRecovery() {
  useEffect(() => {
    const recover = () => {
      if (shouldAttemptReload()) reloadForFreshBuild();
    };

    const onPreloadError = (event: Event) => {
      event.preventDefault();
      recover();
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isStaleChunkError(event.reason)) recover();
    };

    window.addEventListener("vite:preloadError", onPreloadError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("vite:preloadError", onPreloadError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
