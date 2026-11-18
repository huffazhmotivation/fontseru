import { create } from "zustand";

/**
 * Test Lab view preferences (UI only, never part of the font project).
 *
 * `outline` — Outline view, like Illustrator's / Glyphs' outline (wireframe)
 * mode: every glyph in the Test Lab is drawn as a hairline of its contours
 * with no fill, so overlaps, counters and the exact gap between neighbours
 * stay visible while kerning. Remembered across sessions on this device.
 */
const KEY = "fontseru:lab-outline-view";

function readOutline(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

interface LabViewState {
  outline: boolean;
  setOutline: (on: boolean) => void;
  toggleOutline: () => void;
}

export const useLabView = create<LabViewState>()((set, get) => ({
  outline: readOutline(),
  setOutline: (on) => {
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* storage blocked: keep it for this session only */
    }
    set({ outline: on });
  },
  toggleOutline: () => get().setOutline(!get().outline),
}));
