import { Type, Clapperboard } from "lucide-react";
import { useAppModeStore, type AppMode } from "@/mode/appModeStore";

const TABS: { mode: AppMode; label: string; icon: typeof Type }[] = [
  { mode: "font", label: "Font", icon: Type },
  { mode: "motion", label: "Motion", icon: Clapperboard },
];

/**
 * Segmented persona switcher (Font / Motion) shown at the top-left of the
 * bar, right next to the logo — the same idea as Affinity's Vector/Pixel
 * persona tabs. Self-contained: reads/writes only the tiny appMode store, so
 * it can be dropped into either the FontSeru top bar or the Motion Studio top
 * bar without pulling in either side's state.
 *
 * Styling lives in `modeTabs.css` (imported globally in main.tsx) and uses
 * only CSS variables that BOTH `.fm-root` and `.mfs-root` define
 * (--accent / --accent-soft / --text / --text-dim), so it looks native in
 * both modes and in both light/dark themes.
 */
export function ModeTabs() {
  const appMode = useAppModeStore((s) => s.appMode);
  const setAppMode = useAppModeStore((s) => s.setAppMode);

  return (
    <div className="fm-mode-tabs" role="tablist" aria-label="Editor mode" data-testid="mode-tabs">
      {TABS.map(({ mode, label, icon: Icon }) => {
        const active = appMode === mode;
        return (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={active}
            className={`fm-mode-tab ${active ? "active" : ""}`}
            onClick={() => setAppMode(mode)}
            title={mode === "font" ? "Mode Font — desain & ekspor huruf" : "Mode Motion — animasi teks jadi video"}
            data-testid={`mode-tab-${mode}`}
          >
            <Icon size={15} strokeWidth={2} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
