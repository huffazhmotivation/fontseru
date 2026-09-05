import { Circle } from "lucide-react";
import { useScreenRecorderState } from "./useTimelapse";
import { useTimelapseUiStore } from "./timelapseUiStore";

function formatClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Small floating indicator mounted inside the canvas area so it's obvious
 * a screen recording is in progress. Clicking it opens the Timelapse
 * panel (e.g. to stop). Renders nothing when a recording isn't active. */
export function RecordingBadge() {
  const { status, elapsedMs } = useScreenRecorderState();
  const openPanel = useTimelapseUiStore((s) => s.openPanel);

  if (status !== "recording") return null;

  return (
    <button
      type="button"
      className="fm-timelapse-badge"
      onClick={openPanel}
      title="Screen recording in progress — click to open"
      data-testid="timelapse-rec-badge"
    >
      <Circle size={9} className="fm-timelapse-badge-dot" fill="currentColor" />
      <span>REC</span>
      <span className="fm-timelapse-badge-count">{formatClock(elapsedMs)}</span>
    </button>
  );
}
