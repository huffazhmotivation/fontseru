import { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { useTourStore } from "@/store/tourStore";
import { FontSeruLogo } from "@/components/FontSeruLogo";
import { TOUR_SCENES } from "./tourScenes";
import "./productTour.css";

const SCENE_DURATION_MS = 6500;

/**
 * Pre-login automated product tour.
 *
 * Isolation guarantees (see task requirements):
 * - Renders only mock/static data from `tourScenes.tsx` — it never reads
 *   from or writes to `useAppStore` (the real editor state), never calls
 *   `saveProject`/IndexedDB, and never talks to Supabase.
 * - It is a fixed, full-viewport overlay, so the real editor underneath is
 *   unreachable by mouse/touch while it's open. Keyboard input to the
 *   editor is already hard-blocked by `AuthProvider` for the entire
 *   logged-out ("locked") state that the tour only ever appears within
 *   (see the capture-phase listener in src/auth/AuthProvider.tsx).
 * - It auto-opens every time a visitor is logged out and about to hit the
 *   Login/Register gate (once per page load, not once per browser) — see
 *   the auto-open effect below. "Skip Demo" or finishing it hands off to
 *   the Login modal immediately; a "Watch Demo" button on that modal (see
 *   LoginModal.tsx) also replays it on demand within the same visit.
 */
export function ProductTour() {
  const { isConfigured, initializing, user } = useAuth();
  const tourOpen = useTourStore((s) => s.tourOpen);
  const autoOpenChecked = useTourStore((s) => s.autoOpenChecked);
  const markAutoOpenChecked = useTourStore((s) => s.markAutoOpenChecked);
  const resetAutoOpenChecked = useTourStore((s) => s.resetAutoOpenChecked);
  const markSeen = useTourStore((s) => s.markSeen);
  const openTour = useTourStore((s) => s.openTour);
  const closeTour = useTourStore((s) => s.closeTour);

  // Logging out inside the SPA doesn't reload the page, so without this the
  // one-time-per-load `autoOpenChecked` guard below would stay tripped and
  // the tour would never auto-play again until a hard refresh. Watching for
  // a logged-in → logged-out transition and re-arming the guard makes the
  // tour auto-play on every logout too, not just the very first page load.
  const prevUserRef = useRef(user);
  useEffect(() => {
    if (prevUserRef.current && !user) {
      resetAutoOpenChecked();
    }
    prevUserRef.current = user;
  }, [user, resetAutoOpenChecked]);

  // Auto-open once per "logged-out session": as soon as we know for certain
  // this is a logged-out visitor, play the tour automatically instead of
  // going straight to the Login modal. `autoOpenChecked` only guards
  // against re-triggering on every re-render — a fresh page load or a
  // logout (see above) both reset it, so the tour plays every time.
  useEffect(() => {
    if (autoOpenChecked || initializing) return;
    markAutoOpenChecked();
    if (isConfigured && !user) {
      openTour();
    }
  }, [autoOpenChecked, initializing, isConfigured, user, markAutoOpenChecked, openTour]);

  // Safety: if a session appears while the tour is open (shouldn't happen —
  // the editor is locked out while it plays — but guards against e.g. an
  // already-authenticated tab regaining focus), close it immediately.
  useEffect(() => {
    if (tourOpen && (!isConfigured || user)) closeTour();
  }, [tourOpen, isConfigured, user, closeTour]);

  const [sceneIdx, setSceneIdx] = useState(0); // 0..TOUR_SCENES.length-1, or length = CTA
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [caption, setCaption] = useState<string | null>(null);

  // Reset playback state fresh every time the overlay opens (including
  // repeat "Watch Demo" plays), so it always starts from Brush → CTA.
  useEffect(() => {
    if (tourOpen) {
      setSceneIdx(0);
      setElapsed(0);
      setPaused(false);
      setCaption(null);
    }
  }, [tourOpen]);

  const finished = sceneIdx >= TOUR_SCENES.length;

  // Clear the caption immediately on every scene change so stale text from
  // the previous scene never lingers into the next one's first frame; the
  // new scene's own effect reports its first waypoint's caption right away.
  useEffect(() => {
    setCaption(null);
  }, [sceneIdx]);

  // Drive playback off real elapsed time via requestAnimationFrame instead
  // of a fixed-period setInterval. A 50ms setInterval only *requests* a
  // tick every 50ms — it doesn't guarantee one arrives on time. The moment
  // the main thread is briefly busy (a paint, a GC pause, a Chromium
  // backdrop-filter/filter repaint — see the CSS fallbacks below), queued
  // interval callbacks pile up and then fire in a burst, which is exactly
  // what reads as "patah-patah" (stutter/jump) rather than a smooth glide.
  // rAF instead asks the browser "call me right before the next paint",
  // so it naturally coalesces to whatever the real frame rate is, never
  // queues up backlog, and automatically pauses when the tab is
  // backgrounded/throttled. Progress is computed from a timestamp delta
  // each frame rather than accumulated tick counts, so a slow frame just
  // produces one bigger (still correct) jump instead of a cascade of
  // stale, bunched-up updates.
  useEffect(() => {
    if (!tourOpen || finished || paused) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      setElapsed((prev) => {
        const next = prev + dt;
        if (next >= SCENE_DURATION_MS) {
          setSceneIdx((s) => s + 1);
          return 0;
        }
        return next;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tourOpen, finished, paused]);

  // Pause the automated playback (not visible/interactive time shouldn't
  // silently burn through the demo) whenever the tab isn't visible.
  useEffect(() => {
    const onVisibility = () => setPaused(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const finish = () => {
    markSeen();
    closeTour();
  };

  if (!tourOpen) return null;

  const progress = Math.min(1, elapsed / SCENE_DURATION_MS);
  const jumpTo = (idx: number) => {
    setSceneIdx(idx);
    setElapsed(0);
  };

  return (
    <div className="pt-backdrop" role="dialog" aria-modal="true" aria-label="FontSeru product tour">
      <button type="button" className="pt-skip-btn" onClick={finish} data-testid="tour-skip-btn">
        <X size={14} /> Skip Demo
      </button>

      <div className="pt-window">
        <header className="pt-header">
          <FontSeruLogo />
          <div className="pt-progress-track">
            {TOUR_SCENES.map((scene, i) => (
              <button
                key={scene.id}
                type="button"
                className={`pt-progress-dot${i === sceneIdx ? " pt-progress-dot-active" : ""}${
                  i < sceneIdx || finished ? " pt-progress-dot-done" : ""
                }`}
                onClick={() => jumpTo(i)}
                data-testid={`tour-dot-${scene.id}`}
              >
                <scene.icon size={13} />
                <span>{scene.title}</span>
              </button>
            ))}
          </div>
          <div className="pt-header-spacer" />
        </header>

        <div className="pt-scene-bar">
          <div
            className="pt-scene-bar-fill"
            style={{
              width: `${((finished ? TOUR_SCENES.length : sceneIdx + progress) / TOUR_SCENES.length) * 100}%`,
            }}
          />
        </div>

        <div className="pt-body">
          {!finished ? (
            <div key={sceneIdx} className="pt-scene-fade">
              {(() => {
                const Scene = TOUR_SCENES[sceneIdx].Component;
                return <Scene progress={progress} onCaption={setCaption} />;
              })()}
            </div>
          ) : (
            <div className="pt-cta">
              <div className="pt-cta-icon">
                <Sparkles size={26} />
              </div>
              <h2>Ready to create your own font?</h2>
              <p>Brush your letters, generate a full family, test the typography, and ship OpenType features — all in the browser.</p>
              <button type="button" className="pt-cta-btn" onClick={finish} data-testid="tour-start-creating-btn">
                Start Creating
              </button>
            </div>
          )}
        </div>

        {!finished && (
          <div className="pt-caption-bar">
            {caption && (
              <span key={caption} className="pt-caption-text">
                {caption}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
