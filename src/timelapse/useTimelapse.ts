import { useSyncExternalStore } from "react";
import { screenRecorder } from "./ScreenRecorder";
import type { ScreenRecorderSnapshot } from "./types";

/** Reactive view of the singleton screen recorder's state (idle/
 * requesting/recording/processing/ready/error, elapsed time, the finished
 * video's object URL). `getSnapshot` returns a cached, stable reference
 * (see `ScreenRecorder.getSnapshot`) so this is safe to use with
 * `useSyncExternalStore` without triggering render loops. */
export function useScreenRecorderState(): ScreenRecorderSnapshot {
  return useSyncExternalStore(
    (cb) => screenRecorder.subscribe(cb),
    () => screenRecorder.getSnapshot(),
    () => screenRecorder.getSnapshot()
  );
}
