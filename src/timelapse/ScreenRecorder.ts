import type {
  CaptureInterval,
  OutputFormat,
  OutputResolution,
  ScreenRecorderSnapshot,
  ScreenRecordingStatus,
  TimelapseStrategy,
} from "./types";
import { OUTPUT_FPS } from "./types";

type Listener = (snapshot: ScreenRecorderSnapshot) => void;

// Real-time fallback only (browsers with no usable WebCodecs video
// encoder). Ordered best-quality-first; the first one this browser's
// MediaRecorder actually supports wins. No MP4 candidate here — MP4
// capture isn't supported by MediaRecorder in any browser, which is the
// whole reason the "fast" WebCodecs strategy below exists.
const LEGACY_MIME_CANDIDATES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

function pickLegacyMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return LEGACY_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

function evenize(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r - 1;
}

/** Scales (sourceW, sourceH) down to fit within `resolution`'s longest
 * edge, preserving aspect ratio exactly — never upscales, never crops,
 * never letterboxes. "source" returns the native size unchanged (just
 * rounded to even numbers, which H.264/VP9 require). */
function computeTargetSize(
  sourceW: number,
  sourceH: number,
  resolution: OutputResolution
): { width: number; height: number } {
  if (resolution === "source") return { width: evenize(sourceW), height: evenize(sourceH) };
  const targetLongEdge = resolution === "1080p" ? 1920 : 1280;
  const sourceLongEdge = Math.max(sourceW, sourceH);
  const scale = Math.min(1, targetLongEdge / sourceLongEdge);
  return { width: evenize(sourceW * scale), height: evenize(sourceH * scale) };
}

/** Thin wrapper around the `mediabunny` module so it's only ever pulled
 * into the bundle when a recording actually starts (same reasoning as the
 * old comment about not bundling ffmpeg.wasm — this keeps the ~10MB
 * unpacked package, tree-shaken and code-split, entirely out of the
 * initial app load). */
async function loadMediabunny() {
  return import("mediabunny");
}

/** Probes what this browser can actually encode, given a target pixel
 * size, and returns the best available "fast" (WebCodecs) strategy, or
 * null if none is usable (caller should fall back to "legacy"). */
async function pickFastFormat(
  mb: Awaited<ReturnType<typeof loadMediabunny>>,
  width: number,
  height: number
): Promise<{ format: OutputFormat; codec: "avc" | "vp9" | "vp8" } | null> {
  const { canEncodeVideo, QUALITY_HIGH } = mb;
  const checkOpts = { width, height, bitrate: QUALITY_HIGH };
  if (await canEncodeVideo("avc", checkOpts)) return { format: "mp4", codec: "avc" };
  if (await canEncodeVideo("vp9", checkOpts)) return { format: "webm", codec: "vp9" };
  if (await canEncodeVideo("vp8", checkOpts)) return { format: "webm", codec: "vp8" };
  return null;
}

/**
 * Records the actual screen/tab — every panel, menu, and cursor move,
 * exactly as it appears — via the browser's own `getDisplayMedia` capture
 * picker. Two ways the captured pixels become a file, decided
 * automatically per browser (see `TimelapseStrategy` in ./types):
 *
 *  - "fast": frames are sampled from the stream on a timer
 *    (`captureIntervalMs`) and encoded directly to MP4/WebM via WebCodecs
 *    (through `mediabunny`), packed at a fixed 30fps — this is what makes
 *    the export an actual timelapse instead of a real-time recording.
 *  - "legacy": real-time `MediaRecorder` capture to WebM, for browsers
 *    without a usable WebCodecs video encoder.
 */
export class ScreenRecorder {
  private status: ScreenRecordingStatus = "idle";
  private stream: MediaStream | null = null;
  private errorMessage: string | null = null;
  private startedAt: number | null = null;
  private elapsedMs = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private videoUrl: string | null = null;
  private strategy: TimelapseStrategy | null = null;
  private outputFormat: OutputFormat | null = null;
  private outputWidth: number | null = null;
  private outputHeight: number | null = null;
  private frameCount = 0;
  private listeners = new Set<Listener>();

  // -- "fast" strategy state --
  private videoEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private canvasCtx: CanvasRenderingContext2D | null = null;
  private mediabunny: Awaited<ReturnType<typeof loadMediabunny>> | null = null;
  private mbOutput: InstanceType<Awaited<ReturnType<typeof loadMediabunny>>["Output"]> | null = null;
  private mbVideoSource: InstanceType<Awaited<ReturnType<typeof loadMediabunny>>["CanvasSource"]> | null = null;
  private captureTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private captureIntervalMs: CaptureInterval = 2000;

  // -- "legacy" strategy state --
  private legacyRecorder: MediaRecorder | null = null;
  private legacyChunks: BlobPart[] = [];
  private legacyMimeType: string | null = null;

  /** See the identical comment in the old TimelineRecorder: `getSnapshot()`
   * must return a stable reference when nothing changed, or React's
   * `useSyncExternalStore` will re-render forever ("Maximum update depth
   * exceeded"). Cache it and only recompute inside `notify()`. */
  private cachedSnapshot: ScreenRecorderSnapshot | null = null;

  isSupported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getDisplayMedia === "function" &&
      (typeof MediaRecorder !== "undefined" || typeof VideoEncoder !== "undefined")
    );
  }

  /** Opens the browser's "choose what to share" picker (must be called
   * from a user gesture, e.g. a button click) and starts recording as
   * soon as the person picks a tab/window/screen.
   *
   * `resolution` only matters for the "fast" strategy (it sets the
   * encoded pixel size); "legacy" always records at the stream's native
   * resolution since MediaRecorder doesn't let us resample it. */
  async start(captureIntervalMs: CaptureInterval, resolution: OutputResolution): Promise<void> {
    if (this.status === "recording" || this.status === "requesting") return;
    this.revokeVideo();
    this.errorMessage = null;
    this.captureIntervalMs = captureIntervalMs;
    this.status = "requesting";
    this.strategy = null;
    this.outputFormat = null;
    this.outputWidth = null;
    this.outputHeight = null;
    this.frameCount = 0;
    this.notify();

    let stream: MediaStream;
    try {
      // `preferCurrentTab`/`selfBrowserSurface` are non-standard Chrome
      // hints that pre-select/prioritize "this tab" in the picker instead
      // of forcing the person to hunt for it manually. Harmless no-ops in
      // browsers that don't recognize them. Frame rate is kept low here —
      // for "fast" strategy we only sample every `captureIntervalMs`
      // anyway (min 500ms = 2fps worth of freshness), so there's no point
      // asking the OS for a smooth 30fps feed. This is also the main knob
      // for keeping the rest of the app responsive while recording: every
      // frame the OS delivers gets decoded and composited by the browser
      // whether we grab it or not, so a lower requested rate here directly
      // cuts the background CPU/GPU load the recording adds on top of the
      // editor while it's running (was 10 ideal/15 max — asked for far more
      // frames than any capture interval could ever use).
      const constraints: Record<string, unknown> = {
        video: { frameRate: { ideal: 4, max: 6 } },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        surfaceSwitching: "include",
      };
      stream = await navigator.mediaDevices.getDisplayMedia(constraints as DisplayMediaStreamOptions);
    } catch (err) {
      this.status = "idle";
      // NotAllowedError/AbortError = the person closed the share picker
      // without choosing anything — not a real error worth surfacing.
      const cancelled = err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError");
      this.errorMessage = cancelled ? null : err instanceof Error ? err.message : "Could not start screen recording.";
      this.notify();
      return;
    }

    this.stream = stream;
    stream.getVideoTracks()[0]?.addEventListener("ended", () => this.stop());

    const startedFast = await this.tryStartFast(stream, resolution);
    if (!startedFast) this.startLegacy(stream);
  }

  /** Attempts the WebCodecs-backed "fast" (real timelapse) path. Returns
   * false (leaving `stream` untouched/still open) if this browser can't
   * do it, so the caller can fall back to "legacy". */
  private async tryStartFast(stream: MediaStream, resolution: OutputResolution): Promise<boolean> {
    if (typeof VideoEncoder === "undefined") return false;

    let mediabunny: Awaited<ReturnType<typeof loadMediabunny>>;
    try {
      mediabunny = await loadMediabunny();
    } catch {
      return false; // e.g. offline on first-ever load before this chunk was cached
    }

    const videoEl = document.createElement("video");
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.srcObject = stream;

    const sourceSize = await new Promise<{ width: number; height: number } | null>((resolve) => {
      videoEl.onloadedmetadata = () => resolve({ width: videoEl.videoWidth, height: videoEl.videoHeight });
      videoEl.onerror = () => resolve(null);
    });
    if (!sourceSize || !sourceSize.width || !sourceSize.height) return false;

    const { width, height } = computeTargetSize(sourceSize.width, sourceSize.height, resolution);
    const picked = await pickFastFormat(mediabunny, width, height);
    if (!picked) return false;

    try {
      await videoEl.play();
    } catch {
      return false;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      videoEl.pause();
      videoEl.srcObject = null;
      return false;
    }

    const { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH } = mediabunny;
    const output = new Output({
      format: picked.format === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(),
      target: new BufferTarget(),
    });
    const videoSource = new CanvasSource(canvas, { codec: picked.codec, bitrate: QUALITY_HIGH });
    output.addVideoTrack(videoSource);
    await output.start();

    this.mediabunny = mediabunny;
    this.videoEl = videoEl;
    this.canvas = canvas;
    this.canvasCtx = ctx;
    this.mbOutput = output;
    this.mbVideoSource = videoSource;
    this.strategy = "fast";
    this.outputFormat = picked.format;
    this.outputWidth = width;
    this.outputHeight = height;
    this.frameCount = 0;

    this.startedAt = performance.now();
    this.elapsedMs = 0;
    this.status = "recording";
    this.tickTimer = setInterval(() => {
      this.elapsedMs = performance.now() - (this.startedAt ?? performance.now());
      this.notify();
    }, 250);
    this.notify();

    this.scheduleNextCapture();
    return true;
  }

  /** Recursive `setTimeout` loop rather than `setInterval`: `add()` on the
   * mediabunny source applies backpressure (its promise only resolves once
   * the encoder is ready for more), and awaiting it before scheduling the
   * next capture prevents frames from queuing up faster than they can be
   * encoded on a slow machine. */
  private scheduleNextCapture(): void {
    this.captureTimeoutId = setTimeout(() => {
      void this.captureOneFrame();
    }, this.captureIntervalMs);
  }

  private async captureOneFrame(): Promise<void> {
    if (this.status !== "recording" || !this.videoEl || !this.canvas || !this.canvasCtx || !this.mbVideoSource) return;
    try {
      this.canvasCtx.drawImage(this.videoEl, 0, 0, this.canvas.width, this.canvas.height);
      const timestamp = this.frameCount / OUTPUT_FPS;
      await this.mbVideoSource.add(timestamp, 1 / OUTPUT_FPS);
      this.frameCount += 1;
      this.notify();
    } catch (err) {
      this.status = "error";
      this.errorMessage = err instanceof Error ? err.message : "Timelapse encoding failed.";
      if (this.tickTimer !== null) {
        clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.notify();
      this.teardownFastCapture();
      return;
    }
    if (this.status === "recording") this.scheduleNextCapture();
  }

  private startLegacy(stream: MediaStream): void {
    const mimeType = pickLegacyMimeType();
    if (!mimeType) {
      this.status = "error";
      this.errorMessage = "This browser can't record video (no WebCodecs or MediaRecorder support).";
      stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.notify();
      return;
    }

    this.legacyMimeType = mimeType;
    this.legacyChunks = [];
    this.strategy = "legacy";
    this.outputFormat = "webm";

    const recorder = new MediaRecorder(stream, { mimeType });
    this.legacyRecorder = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.legacyChunks.push(e.data);
    };
    recorder.onstop = () => this.finalizeLegacy();
    recorder.start();

    this.startedAt = performance.now();
    this.elapsedMs = 0;
    this.status = "recording";
    this.tickTimer = setInterval(() => {
      this.elapsedMs = performance.now() - (this.startedAt ?? performance.now());
      this.notify();
    }, 250);
    this.notify();
  }

  /** Stops capture and starts finalizing the file (encoder flush + mux for
   * "fast", or MediaRecorder's own finalize for "legacy"). */
  stop(): void {
    if (this.status !== "recording") return;
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.status = "processing";
    this.notify();

    if (this.strategy === "fast") {
      if (this.captureTimeoutId !== null) {
        clearTimeout(this.captureTimeoutId);
        this.captureTimeoutId = null;
      }
      void this.finalizeFast();
    } else {
      this.legacyRecorder?.stop();
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  private async finalizeFast(): Promise<void> {
    try {
      if (this.mbOutput) await this.mbOutput.finalize();
      const buffer = (this.mbOutput?.target as { buffer?: ArrayBuffer } | undefined)?.buffer;
      if (buffer) {
        const mime = this.outputFormat === "mp4" ? "video/mp4" : "video/webm";
        const blob = new Blob([buffer], { type: mime });
        this.videoUrl = URL.createObjectURL(blob);
        this.status = "ready";
      } else {
        this.status = "error";
        this.errorMessage = "Recording finished but produced no video data.";
      }
    } catch (err) {
      this.status = "error";
      this.errorMessage = err instanceof Error ? err.message : "Could not finish encoding the timelapse.";
    }
    this.teardownFastCapture();
    this.notify();
  }

  private teardownFastCapture(): void {
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.srcObject = null;
    }
    this.videoEl = null;
    this.canvas = null;
    this.canvasCtx = null;
    this.mbOutput = null;
    this.mbVideoSource = null;
  }

  private finalizeLegacy(): void {
    const blob = new Blob(this.legacyChunks, { type: this.legacyMimeType ?? "video/webm" });
    this.legacyChunks = [];
    this.videoUrl = URL.createObjectURL(blob);
    this.status = "ready";
    this.notify();
  }

  /** Discards the current recording (if any) so a new one can start. */
  clear(): void {
    this.revokeVideo();
    this.status = "idle";
    this.elapsedMs = 0;
    this.errorMessage = null;
    this.strategy = null;
    this.outputFormat = null;
    this.outputWidth = null;
    this.outputHeight = null;
    this.frameCount = 0;
    this.notify();
  }

  private revokeVideo(): void {
    if (this.videoUrl) {
      URL.revokeObjectURL(this.videoUrl);
      this.videoUrl = null;
    }
  }

  getSnapshot(): ScreenRecorderSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    this.cachedSnapshot = {
      status: this.status,
      elapsedMs: this.elapsedMs,
      videoUrl: this.videoUrl,
      errorMessage: this.errorMessage,
      strategy: this.strategy,
      outputFormat: this.outputFormat,
      outputWidth: this.outputWidth,
      outputHeight: this.outputHeight,
      frameCount: this.frameCount,
      estimatedOutputMs: (this.frameCount / OUTPUT_FPS) * 1000,
    };
    return this.cachedSnapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.cachedSnapshot = null;
    const snapshot = this.getSnapshot();
    for (const l of this.listeners) l(snapshot);
  }
}

/** Single app-wide instance, mirroring how there's one undo/redo stack
 * for the whole editor. */
export const screenRecorder = new ScreenRecorder();
