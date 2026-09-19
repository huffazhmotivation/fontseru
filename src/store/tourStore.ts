import { create } from "zustand";

/**
 * State for the pre-login automated product tour (see
 * src/components/ProductTour). This store is intentionally separate from
 * the main editor store (`src/glyph/store.ts`): it never touches glyph
 * data, never persists to IndexedDB/Supabase, and the only thing written to
 * `localStorage` is a single "has this browser seen the tour" flag.
 */

const STORAGE_KEY = "fontseru_tour_seen_v1";

function readSeenFromStorage(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Private browsing / disabled storage: fall back to "not seen", which
    // just means the tour may auto-play again next visit. Never throws.
    return false;
  }
}

interface TourStoreState {
  /** Persisted "seen" flag, mirrored from localStorage. Kept for potential
   * future analytics — it no longer gates auto-play (see ProductTour.tsx,
   * which now auto-opens every time a visitor is logged out). */
  hasSeenTour: boolean;
  /** Whether the tour overlay is currently mounted/visible. */
  tourOpen: boolean;
  /** Guards the one-time-per-load auto-open check so it only ever runs
   * once per render cycle rather than on every render of ProductTour.
   * Reset back to false on logout so the tour plays again without needing
   * a full page reload. */
  autoOpenChecked: boolean;
  markAutoOpenChecked: () => void;
  resetAutoOpenChecked: () => void;
  /** Marks the tour as seen (persisted to localStorage). Does not by
   * itself close the overlay — callers close it separately. */
  markSeen: () => void;
  openTour: () => void;
  closeTour: () => void;
}

export const useTourStore = create<TourStoreState>((set) => ({
  hasSeenTour: readSeenFromStorage(),
  tourOpen: false,
  autoOpenChecked: false,
  markAutoOpenChecked: () => set({ autoOpenChecked: true }),
  resetAutoOpenChecked: () => set({ autoOpenChecked: false }),
  markSeen: () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* ignore — see readSeenFromStorage() */
    }
    set({ hasSeenTour: true });
  },
  openTour: () => set({ tourOpen: true }),
  closeTour: () => set({ tourOpen: false }),
}));
