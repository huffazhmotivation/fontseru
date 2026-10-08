import { useSyncExternalStore } from "react";

/**
 * A tiny observable value for per-frame live previews (brush/pencil strokes
 * in progress, pen rubber-band hover). Writing to it re-renders ONLY the
 * small component subscribed via `usePreviewValue` — not the whole canvas
 * that owns the tool hook — which is the point: a full GlyphCanvas render
 * per pointer frame was the dominant cost of drawing on a busy glyph.
 */
export interface PreviewStore<T> {
  get: () => T;
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPreviewStore<T>(initial: T): PreviewStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function usePreviewValue<T>(store: PreviewStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
