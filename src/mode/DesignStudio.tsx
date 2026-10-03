import { useEffect, useState } from "react";
import { useAppModeStore, type AppMode } from "@/mode/appModeStore";

/**
 * Design mode: the DesignSeru editor, hosted as a separate static app in
 * `public/design` and shown full-screen in an iframe — like Motion mode, it
 * takes over the whole window. Its own top bar carries the Font / Design /
 * Motion tabs and asks us to switch via postMessage.
 *
 * An iframe (rather than merging the code) is deliberate: DesignSeru ships
 * its own Tailwind reset, global styles, keyboard shortcuts and storage, and
 * none of that may leak into — or be broken by — the font editor. Rebuild it
 * with `scripts/build-design.sh` when the design app changes.
 *
 * Always mounted (hidden while another mode is active) and started shortly
 * after the app is idle, so by the time the user opens Design mode it is
 * already loaded: no blank wait, and its state survives mode switches.
 */
export function DesignStudio({ active, theme }: { active: boolean; theme: string }) {
  const [started, setStarted] = useState(active);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (started) return;
    const id = window.setTimeout(() => setStarted(true), 1500);
    return () => clearTimeout(id);
  }, [started]);

  useEffect(() => { if (active) setStarted(true); }, [active]);

  // The embedded app's mode tabs report clicks here.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data as { type?: string; mode?: AppMode } | null;
      if (d?.type === "fontseru:set-mode" && (d.mode === "font" || d.mode === "motion")) {
        useAppModeStore.getState().setAppMode(d.mode);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!started) return null;
  return (
    <div
      className="fm-root fm-design-shell"
      data-theme={theme}
      style={active ? undefined : { display: "none" }}
      aria-hidden={!active}
    >
      <div className="fm-design-stage">
        <iframe
          className="fm-design-frame"
          title="DesignSeru"
          src={`${import.meta.env.BASE_URL}design/index.html?v=${__APP_BUILD_ID__}`}
          allow="clipboard-read; clipboard-write; fullscreen; camera; microphone"
          onLoad={() => setLoaded(true)}
          data-testid="design-frame"
        />
        {!loaded && <div className="fm-design-loading">Memuat DesignSeru…</div>}
      </div>
    </div>
  );
}
