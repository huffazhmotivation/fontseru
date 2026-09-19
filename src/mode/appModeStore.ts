import { create } from "zustand";

/**
 * Global "persona" switch for the app — Font mode (the main FontSeru editor)
 * vs Motion mode (the Motion Font Studio engine). Inspired by Affinity's
 * Vector/Pixel persona tabs.
 *
 * Kept as its own tiny, self-contained store on purpose: it must be readable
 * from BOTH the FontSeru side (which uses the big `@/glyph/store`) and the
 * Motion engine (which has its own internal reducer state) without either
 * side depending on the other. Nothing here touches the existing font store,
 * so switching modes can never disturb the glyph/project state.
 */
export type AppMode = "font" | "motion";

const STORAGE_KEY = "fontseru.appMode";

function readInitialMode(): AppMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "motion" || saved === "font") return saved;
  } catch {
    /* localStorage may be unavailable (private mode, blocked) — ignore. */
  }
  return "font";
}

interface AppModeState {
  appMode: AppMode;
  setAppMode: (mode: AppMode) => void;
}

export const useAppModeStore = create<AppModeState>((set) => ({
  appMode: readInitialMode(),
  setAppMode: (mode) => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore persistence failures */
    }
    set({ appMode: mode });
  },
}));
