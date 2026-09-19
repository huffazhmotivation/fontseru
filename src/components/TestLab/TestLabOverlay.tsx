import { useEffect, useState } from "react";
import { X, FlaskConical, Type, Layers3 } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { SpecimenPanel } from "./SpecimenPanel";

export function TestLabOverlay() {
  const open = useAppStore((s) => s.testLabOpen);
  const close = useAppStore((s) => s.closeTestLab);
  // Lifted out of SpecimenPanel so the Single/Family Test switch can live in
  // the window's top bar instead of the side rail — this component stays
  // mounted (just returns null while closed) so the choice persists across
  // Test Lab opens/closes instead of resetting to Single every time.
  const [kerningMode, setKerningMode] = useState<"single" | "family">("single");

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="fm-lab-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }} data-testid="test-lab-overlay">
      <div className="fm-lab-modal">
        <div className="fm-lab-head">
          <div className="fm-lab-title">
            <FlaskConical size={14} />
            <span>Test Lab</span>
          </div>
          <div className="fm-kern-mode-toggle fm-lab-head-mode-toggle" data-testid="kern-test-mode">
            <button
              className={kerningMode === "single" ? "active" : ""}
              onClick={() => setKerningMode("single")}
              data-testid="kern-single-test"
              title="Single Test"
            >
              <Type size={14} /> <span>Single Test</span>
            </button>
            <button
              className={kerningMode === "family" ? "active" : ""}
              onClick={() => setKerningMode("family")}
              data-testid="kern-family-test"
              title="Family Test"
            >
              <Layers3 size={14} /> <span>Family Test</span>
            </button>
          </div>
          <div className="fm-spacer" />
          <button className="fm-theme-toggle" onClick={close} title="Close (Esc)" data-testid="lab-close-btn">
            <X size={16} />
          </button>
        </div>
        <div className="fm-lab-body">
          <SpecimenPanel kerningMode={kerningMode} setKerningMode={setKerningMode} />
        </div>
      </div>
    </div>
  );
}
