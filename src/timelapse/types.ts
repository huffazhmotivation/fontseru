/**
 * Timelapse Recording — real screen/tab capture (getDisplayMedia), NOT an
 * event-based vector replay. This intentionally captures actual on-screen
 * pixels — every panel, menu, and cursor move — exactly as it looked while
 * the person worked, at the cost of needing a one-time browser "share this
 * tab" permission per recording and producing a real video file instead of
 * a tiny data log.
 *
 * Two capture strategies, chosen automatically per-browser at record time:
 *  - "fast" (preferred): the display stream is sampled frame-by-frame at
 *    `captureIntervalMs` and each sampled frame is encoded via WebCodecs
 *    (through the `mediabunny` wrapper) directly into a real MP4 (H.264)
 *    or, if H.264 encode isn't available, WebM (VP9/VP8) — packing the
 *    frames tightly at `OUTPUT_FPS` so the file is an actual timelapse
 *    (a long session compresses into a short clip), not a real-time
 *    recording that merely gets `playbackRate`-sped-up afterwards.
 *  - "legacy" fallback: browsers without WebCodecs support fall back to
 *    the original real-time `MediaRecorder` + WebM capture. There the
 *    exported file plays back at the speed it was recorded; the in-app
 *    "Speed" buttons only change `<video>.playbackRate` for review/export
 *    convenience, they don't shrink the file.
 */
export type ScreenRecordingStatus =
  | "idle"
  | "requesting"
  | "recording"
  | "processing"
  | "ready"
  | "error";

export type TimelapseStrategy = "fast" | "legacy";
export type OutputFormat = "mp4" | "webm";

/** How often (ms) a frame is sampled from the live display stream while
 * recording. Combined with the fixed `OUTPUT_FPS` output framerate, this
 * sets the effective timelapse speed-up, e.g. 2000ms capture interval at
 * 30fps output = 60x. */
export type CaptureInterval = 500 | 1000 | 2000 | 5000;

/** Longest-edge target for the encoded video. Never upscales past the
 * source tab/screen's real resolution — "1080p"/"720p" are ceilings, not
 * forced canvas sizes, so the original aspect ratio is always kept and no
 * letterboxing is ever introduced. */
export type OutputResolution = "1080p" | "720p" | "source";

export interface ScreenRecorderSnapshot {
  status: ScreenRecordingStatus;
  /** Wall-clock ms since recording started (only meaningful while "recording"). */
  elapsedMs: number;
  /** Object URL for the finished recording, once `status === "ready"`. */
  videoUrl: string | null;
  /** Set when `status === "error"` (or a non-fatal permission note). */
  errorMessage: string | null;
  /** Which capture strategy produced (or will produce) the current/last
   * recording. Null before the browser's capability has been probed. */
  strategy: TimelapseStrategy | null;
  /** Container/codec of the finished (or in-progress) recording. */
  outputFormat: OutputFormat | null;
  /** Encoded pixel size actually used, once known (post `loadedmetadata`). */
  outputWidth: number | null;
  outputHeight: number | null;
  /** Frames encoded so far — only meaningful for the "fast" strategy. */
  frameCount: number;
  /** Estimated finished-video duration in ms (frameCount / OUTPUT_FPS),
   * i.e. what the timelapse will actually play back as. Only meaningful
   * for the "fast" strategy; "legacy" recordings play at 1x = elapsedMs. */
  estimatedOutputMs: number;
}

export type PlaybackSpeed = 1 | 2 | 4 | 8;

/** Fixed output framerate for the "fast" strategy's encoded video. Not
 * user-configurable — the timelapse speed-up is controlled entirely via
 * `CaptureInterval` instead, which is the more meaningful knob. */
export const OUTPUT_FPS = 30;
