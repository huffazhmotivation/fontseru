import { create } from "zustand";
import type { CaptureInterval, OutputResolution, PlaybackSpeed } from "./types";

/**
 * Purely UI-local state for the Timelapse panel (is it open, what capture
 * settings are selected before recording, what playback speed is selected
 * for reviewing a finished recording).
 * Deliberately a separate tiny store instead of new fields on the main
 * `AppState` in `glyph/store.ts` — this feature doesn't need undo/redo,
 * persistence, or any of that store's machinery, so keeping it isolated
 * means zero changes to the large existing store interface.
 */
interface TimelapseUiState {
  open: boolean;
  speed: PlaybackSpeed;
  /** How often a frame is sampled while recording — the main timelapse
   * "compression" knob. Locked once recording starts. */
  captureInterval: CaptureInterval;
  /** Longest-edge quality ceiling for the encoded video. Locked once
   * recording starts. */
  resolution: OutputResolution;
  openPanel: () => void;
  closePanel: () => void;
  setSpeed: (speed: PlaybackSpeed) => void;
  setCaptureInterval: (captureInterval: CaptureInterval) => void;
  setResolution: (resolution: OutputResolution) => void;
}

export const useTimelapseUiStore = create<TimelapseUiState>((set) => ({
  open: false,
  speed: 1,
  captureInterval: 2000,
  resolution: "1080p",
  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
  setSpeed: (speed) => set({ speed }),
  setCaptureInterval: (captureInterval) => set({ captureInterval }),
  setResolution: (resolution) => set({ resolution }),
}));
