/// <reference lib="webworker" />
// Runs the Kamus Kerning analysis (optical gap of every pair + spacing model)
// off the main thread: on brush fonts it outlines every textured stroke and
// measures thousands of pairs, which used to stall the UI for seconds.
import type { FontMetrics } from "@/types/font";
import type { GlyphMap } from "@/types/glyph";
import { analyseDictionary, type DictGroup } from "./kerningDictionary";

let current = { cancelled: false };

self.onmessage = async (e: MessageEvent<{ id: number; glyphs: GlyphMap; metrics: FontMetrics; groups: DictGroup[] }>) => {
  const { id, glyphs, metrics, groups } = e.data;
  current.cancelled = true; // a newer request supersedes the running one
  const signal = { cancelled: false };
  current = signal;
  let lastPost = 0;
  const res = await analyseDictionary(
    glyphs,
    metrics,
    groups,
    (done, total) => {
      const now = performance.now();
      if (now - lastPost > 100 || done === total) {
        lastPost = now;
        (self as unknown as Worker).postMessage({ id, progress: total ? done / total : 1 });
      }
    },
    signal,
  );
  if (!res || signal.cancelled) return;
  (self as unknown as Worker).postMessage({ id, entries: [...res.entries()] });
};
