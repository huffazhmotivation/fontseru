import { Type, Clapperboard, PenTool } from "lucide-react";
import { useAppModeStore, type AppMode } from "@/mode/appModeStore";
import { PrayerIcon, openPrayerSettings } from "@/prayer/PrayerReminder";

const TABS: { mode: AppMode; label: string; icon: typeof Type }[] = [
  { mode: "font", label: "Font", icon: Type },
  { mode: "design", label: "Design", icon: PenTool },
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
// Mulai memuat iframe Design begitu tab-nya didekati/disentuh, jadi sudah setengah jalan saat diklik.
const warmDesign = () => window.dispatchEvent(new Event("fontseru:warm-design"));

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
            onPointerEnter={mode === "design" ? warmDesign : undefined}
            onPointerDown={mode === "design" ? warmDesign : undefined}
            title={mode === "font" ? "Mode Font — desain & ekspor huruf" : mode === "design" ? "Mode Design — editor desain vektor, gambar & mockup" : "Mode Motion — animasi teks jadi video"}
            data-testid={`mode-tab-${mode}`}
          >
            <Icon size={15} strokeWidth={2} />
            <span>{label}</span>
          </button>
        );
      })}
      {/* Pengingat sholat — pengaturan lokasi/jadwal; berlaku untuk semua mode. */}
      <button
        type="button"
        className="fm-mode-tab fm-mode-prayer"
        onClick={openPrayerSettings}
        title="Pengingat waktu sholat"
        aria-label="Pengingat waktu sholat"
        data-testid="prayer-settings-btn"
      >
        <PrayerIcon size={15} />
      </button>
    </div>
  );
}
