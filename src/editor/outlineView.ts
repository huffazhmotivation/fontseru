import { create } from "zustand";

/**
 * Outline view for the main editing canvases (single glyph, Multi, Drawing):
 * like the outline / wireframe view of pro design apps, every shape is drawn
 * as a 1 px hairline of its contours with no fill, so overlapping contours,
 * counters and exact curve shapes stay visible. Nodes, handles, selection
 * and guides are unaffected. UI only — never stored in the project or export —
 * and remembered on this device. Toggled from the bottom bar.
 */
const KEY = "fontseru:canvas-outline-view";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

interface CanvasOutlineState {
  on: boolean;
  toggle: () => void;
}

export const useCanvasOutline = create<CanvasOutlineState>()((set, get) => ({
  on: read(),
  toggle: () => {
    const on = !get().on;
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* storage blocked: keep it for this session only */
    }
    set({ on });
  },
}));
