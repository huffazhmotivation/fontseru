import { useEffect, useRef } from "react";
import { X, Circle, Download, Film, Loader2, RotateCcw, MonitorPlay } from "lucide-react";
import { screenRecorder } from "./ScreenRecorder";
import { useScreenRecorderState } from "./useTimelapse";
import { useTimelapseUiStore } from "./timelapseUiStore";
import type { CaptureInterval, OutputResolution, PlaybackSpeed } from "./types";
import { OUTPUT_FPS } from "./types";

const SPEEDS: PlaybackSpeed[] = [1, 2, 4, 8];
const CAPTURE_INTERVALS: CaptureInterval[] = [500, 1000, 2000, 5000];
const RESOLUTIONS: { value: OutputResolution; label: string }[] = [
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "source", label: "Source" },
];

function formatClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** e.g. 2000ms capture interval @ 30fps output = "60x". */
function speedupLabel(captureIntervalMs: CaptureInterval): string {
  return `${Math.round((captureIntervalMs / 1000) * OUTPUT_FPS)}x`;
}

export function TimelapseOverlay() {
  const open = useTimelapseUiStore((s) => s.open);
  const close = useTimelapseUiStore((s) => s.closePanel);
  const speed = useTimelapseUiStore((s) => s.speed);
  const setSpeed = useTimelapseUiStore((s) => s.setSpeed);
  const captureInterval = useTimelapseUiStore((s) => s.captureInterval);
  const setCaptureInterval = useTimelapseUiStore((s) => s.setCaptureInterval);
  const resolution = useTimelapseUiStore((s) => s.resolution);
  const setResolution = useTimelapseUiStore((s) => s.setResolution);

  const { status, elapsedMs, videoUrl, errorMessage, strategy, outputFormat, outputWidth, outputHeight, frameCount, estimatedOutputMs } =
    useScreenRecorderState();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const supported = screenRecorder.isSupported();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Keep the <video>'s actual playback rate in sync with the speed toggle
  // whenever either changes (or a fresh recording loads into the player).
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, videoUrl]);

  if (!open) return null;

  function handleDownload() {
    if (!videoUrl) return;
    const ext = outputFormat === "mp4" ? "mp4" : "webm";
    const a = document.createElement("a");
    a.href = videoUrl;
    a.download = `fontseru-timelapse.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div
      className="fm-lab-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      data-testid="timelapse-overlay"
    >
      <div className="fm-lab-modal fm-timelapse-modal">
        <div className="fm-lab-head">
          <div className="fm-lab-title">
            <Film size={14} />
            <span>Timelapse Recording</span>
          </div>
          <div className="fm-spacer" />
          <button className="fm-theme-toggle" onClick={close} title="Close (Esc)" data-testid="timelapse-close-btn">
            <X size={16} />
          </button>
        </div>

        <div className="fm-lab-body fm-timelapse-body">
          {!supported && (
            <div className="fm-timelapse-stage">
              <div className="fm-timelapse-empty">
                Screen recording isn't supported in this browser. Try the latest Chrome, Edge, or Firefox.
              </div>
            </div>
          )}

          {supported && status === "idle" && (
            <>
              <div className="fm-timelapse-stage">
                <div className="fm-timelapse-empty">
                  <MonitorPlay size={22} />
                  <br />
                  <br />
                  Press <strong>Start Recording</strong>, then choose <strong>this tab</strong> when your browser asks what
                  to share. Everything you do afterwards — switching panels, drawing, opening menus — gets captured exactly
                  as it looks on screen, then compressed into a real timelapse video (MP4 where the browser supports it).
                </div>
              </div>

              <div className="fm-timelapse-speed-row">
                <span className="fm-timelapse-label">Speed-up</span>
                <div className="fm-align-group" role="group" aria-label="Capture interval">
                  {CAPTURE_INTERVALS.map((ms) => (
                    <button
                      key={ms}
                      type="button"
                      className={`fm-timelapse-speed-btn ${captureInterval === ms ? "is-active" : ""}`}
                      onClick={() => setCaptureInterval(ms)}
                      title={`Sample a frame every ${ms / 1000}s`}
                      data-testid={`timelapse-interval-${ms}`}
                    >
                      {speedupLabel(ms)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="fm-timelapse-speed-row">
                <span className="fm-timelapse-label">Quality</span>
                <div className="fm-align-group" role="group" aria-label="Output resolution">
                  {RESOLUTIONS.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      className={`fm-timelapse-speed-btn ${resolution === r.value ? "is-active" : ""}`}
                      onClick={() => setResolution(r.value)}
                      data-testid={`timelapse-resolution-${r.value}`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>

              {errorMessage && <div className="fm-timelapse-export-note">{errorMessage}</div>}
              <div className="fm-timelapse-record-row">
                <button
                  type="button"
                  className="fm-timelapse-record-btn"
                  onClick={() => screenRecorder.start(captureInterval, resolution)}
                  data-testid="timelapse-record-toggle"
                >
                  <Circle size={13} fill="currentColor" />
                  Start Recording
                </button>
              </div>
            </>
          )}

          {status === "requesting" && (
            <div className="fm-timelapse-stage">
              <div className="fm-timelapse-empty">
                <Loader2 size={20} className="fm-spin" />
                <br />
                <br />
                Waiting for you to pick a tab to share…
              </div>
            </div>
          )}

          {status === "recording" && (
            <>
              <div className="fm-timelapse-stage">
                <div className="fm-timelapse-empty">
                  Recording in progress. Go do the work you want captured — you can close this panel, it keeps running
                  until you hit <strong>Stop Recording</strong> (or stop sharing from your browser's own toolbar).
                </div>
              </div>
              <div className="fm-timelapse-frame-meta">
                <span className="fm-timelapse-action-pill">
                  {strategy === "fast" ? (outputFormat === "mp4" ? "MP4" : "WEBM") : "WEBM · real-time"}
                </span>
                {strategy === "fast" && outputWidth && outputHeight && (
                  <span>
                    {outputWidth}×{outputHeight}
                  </span>
                )}
                {strategy === "fast" && (
                  <span>
                    {frameCount} frames captured · ~{formatClock(estimatedOutputMs)} video so far
                  </span>
                )}
              </div>
              <div className="fm-timelapse-record-row">
                <button
                  type="button"
                  className="fm-timelapse-record-btn is-recording"
                  onClick={() => screenRecorder.stop()}
                  data-testid="timelapse-record-toggle"
                >
                  <Circle size={13} fill="currentColor" />
                  Recording…
                </button>
                <div className="fm-spacer" />
                <div className="fm-timelapse-stats">
                  <span>{formatClock(elapsedMs)}</span>
                </div>
              </div>
            </>
          )}

          {status === "processing" && (
            <div className="fm-timelapse-stage">
              <div className="fm-timelapse-empty">
                <Loader2 size={20} className="fm-spin" />
                <br />
                <br />
                Finishing up…
              </div>
            </div>
          )}

          {status === "error" && errorMessage && (
            <>
              <div className="fm-timelapse-stage">
                <div className="fm-timelapse-empty">{errorMessage}</div>
              </div>
              <div className="fm-timelapse-record-row">
                <button
                  type="button"
                  className="fm-timelapse-icon-btn"
                  onClick={() => screenRecorder.clear()}
                  data-testid="timelapse-clear-btn"
                >
                  <RotateCcw size={14} /> Try again
                </button>
              </div>
            </>
          )}

          {status === "ready" && videoUrl && (
            <>
              <div className="fm-timelapse-stage fm-timelapse-video-stage">
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video ref={videoRef} src={videoUrl} controls className="fm-timelapse-video" data-testid="timelapse-video" />
              </div>

              <div className="fm-timelapse-frame-meta">
                <span className="fm-timelapse-action-pill">{outputFormat === "mp4" ? "MP4" : "WEBM"}</span>
                {strategy === "fast" && outputWidth && outputHeight && (
                  <span>
                    {outputWidth}×{outputHeight}
                  </span>
                )}
                {strategy === "legacy" && (
                  <span>This browser recorded in real-time — use Speed below to play it back faster.</span>
                )}
              </div>

              <div className="fm-timelapse-speed-row">
                <span className="fm-timelapse-label">Speed</span>
                <div className="fm-align-group" role="group" aria-label="Playback speed">
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`fm-timelapse-speed-btn ${speed === s ? "is-active" : ""}`}
                      onClick={() => setSpeed(s)}
                      data-testid={`timelapse-speed-${s}x`}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
                <div className="fm-spacer" />
                <button
                  type="button"
                  className="fm-timelapse-icon-btn"
                  onClick={() => screenRecorder.clear()}
                  title="Discard and record again"
                  data-testid="timelapse-clear-btn"
                >
                  <RotateCcw size={14} /> Record again
                </button>
                <button
                  type="button"
                  className="fm-timelapse-record-btn fm-timelapse-export-btn"
                  onClick={handleDownload}
                  data-testid="timelapse-export-btn"
                >
                  <Download size={14} /> Download {outputFormat === "mp4" ? "MP4" : "WEBM"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
