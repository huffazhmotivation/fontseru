import { Circle, Pause, Play } from "lucide-react";
import { screenRecorder } from "./ScreenRecorder";
import { useScreenRecorderState } from "./useTimelapse";
import { useTimelapseUiStore } from "./timelapseUiStore";

function formatClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Small floating indicator mounted inside the canvas area so it's obvious
 * a screen recording is in progress. The REC/PAUSED label opens the
 * Timelapse panel; the separate pause/resume icon pauses or resumes in
 * place (stopPropagation so it doesn't also open the panel) without
 * needing to stop the recording — e.g. to step away mid-session and pick
 * the timelapse back up later. Renders nothing when no recording is
 * active or being finished. */
export function RecordingBadge() {
  const { status, elapsedMs } = useScreenRecorderState();
  const openPanel = useTimelapseUiStore((s) => s.openPanel);

  if (status !== "recording" && status !== "paused") return null;
  const paused = status === "paused";

  return (
    <div className={`fm-timelapse-badge ${paused ? "is-paused" : ""}`} data-testid="timelapse-rec-badge">
      <button
        type="button"
        className="fm-timelapse-badge-pause"
        onClick={(e) => {
          e.stopPropagation();
          if (paused) screenRecorder.resume();
          else screenRecorder.pause();
        }}
        title={paused ? "Resume recording" : "Pause recording"}
        data-testid="timelapse-badge-pause-toggle"
      >
        {paused ? <Play size={11} fill="currentColor" /> : <Pause size={11} fill="currentColor" />}
      </button>
      <button
        type="button"
        className="fm-timelapse-badge-label"
        onClick={openPanel}
        title="Screen recording — click to open"
        data-testid="timelapse-badge-open"
      >
        <Circle size={9} className="fm-timelapse-badge-dot" fill="currentColor" />
        <span>{paused ? "PAUSED" : "REC"}</span>
        <span className="fm-timelapse-badge-count">{formatClock(elapsedMs)}</span>
      </button>
    </div>
  );
}
