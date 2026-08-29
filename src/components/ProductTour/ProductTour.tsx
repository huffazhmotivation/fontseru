import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { useTourStore } from "@/store/tourStore";
import { FontSeruLogo } from "@/components/FontSeruLogo";
import { TOUR_SCENES } from "./tourScenes";
import "./productTour.css";

const SCENE_DURATION_MS = 6500;
const TICK_MS = 50;

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
  const markSeen = useTourStore((s) => s.markSeen);
  const openTour = useTourStore((s) => s.openTour);
  const closeTour = useTourStore((s) => s.closeTour);

  // Auto-open once per page load: as soon as we know for certain this is a
  // logged-out visitor, play the tour automatically instead of going
  // straight to the Login modal. `autoOpenChecked` only guards against
  // re-triggering on every re-render within this same load — a fresh page
  // load (or logout) resets it, so the tour plays every time.
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

  // Reset playback state fresh every time the overlay opens (including
  // repeat "Watch Demo" plays), so it always starts from Brush → CTA.
  useEffect(() => {
    if (tourOpen) {
      setSceneIdx(0);
      setElapsed(0);
      setPaused(false);
    }
  }, [tourOpen]);

  const finished = sceneIdx >= TOUR_SCENES.length;

  useEffect(() => {
    if (!tourOpen || finished || paused) return;
    const id = window.setInterval(() => {
      setElapsed((prev) => {
        const next = prev + TICK_MS;
        if (next >= SCENE_DURATION_MS) {
          setSceneIdx((s) => s + 1);
          return 0;
        }
        return next;
      });
    }, TICK_MS);
    return () => window.clearInterval(id);
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
                return <Scene progress={progress} />;
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
      </div>
    </div>
  );
}
