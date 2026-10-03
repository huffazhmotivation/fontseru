import { useState } from "react";
import { ModeTabs } from "@/mode/ModeTabs";
import { FontSeruLogo } from "@/components/FontSeruLogo";

/**
 * Design mode: the DesignSeru editor, hosted as a separate static app in
 * `public/design` and shown full-screen in an iframe under a slim bar that
 * keeps the Font / Design / Motion switcher reachable.
 *
 * An iframe (rather than merging the code) is deliberate: DesignSeru ships
 * its own Tailwind reset, global styles, keyboard shortcuts and storage, and
 * none of that may leak into — or be broken by — the font editor. Rebuild it
 * with `scripts/build-design.sh` when the design app changes.
 */
export function DesignStudio({ theme }: { theme: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="fm-root fm-design-shell" data-theme={theme}>
      <div className="fm-design-bar">
        <FontSeruLogo />
        <ModeTabs />
        <span className="fm-design-hint">{loaded ? "" : "Memuat DesignSeru…"}</span>
      </div>
      <iframe
        className="fm-design-frame"
        title="DesignSeru"
        src={`${import.meta.env.BASE_URL}design/index.html`}
        allow="clipboard-read; clipboard-write; fullscreen; camera; microphone"
        onLoad={() => setLoaded(true)}
        data-testid="design-frame"
      />
    </div>
  );
}
