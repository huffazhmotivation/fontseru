import { memo, useRef } from "react";
import type { Contour } from "@/types/geometry";
import { contourToPath } from "./pathBuilder";

/** Finalized spray dots per <path> element. */
const CHUNK = 300;

/**
 * Filled live brush preview.
 *
 * `outline` is whatever changes frame to frame (the stroke body, and for
 * Spray Brush the dots still settling near the pen). `frozen` is Spray
 * Brush's append-only list of finished halo dots — the same array every
 * frame of one stroke, only ever growing. Rebuilding one giant path string
 * from ALL dots on every pointer move was what made Spray Brush crawl (tens
 * of thousands of coordinates formatted, and the whole path re-parsed and
 * re-rasterised, 60× a second). Here finished dots are converted to path
 * text once, into chunks of CHUNK dots; completed chunks keep the very same
 * string, so React leaves those <path> elements untouched and only the last
 * chunk and the small live part are updated per frame.
 *
 * Everything sits in one group with the preview opacity, so overlapping
 * pieces composite exactly like the single path they replace.
 */
export const LiveBrushFill = memo(function LiveBrushFill({
  outline,
  frozen,
  ascender,
}: {
  outline: Contour[];
  frozen?: Contour[] | null;
  ascender: number;
}) {
  const cache = useRef<{ arr: Contour[] | null; asc: number; chunks: string[]; done: number }>({ arr: null, asc: NaN, chunks: [], done: 0 });
  let chunks: string[] = [];
  if (frozen && frozen.length) {
    const c = cache.current;
    if (c.arr !== frozen || c.asc !== ascender || frozen.length < c.done) {
      cache.current = { arr: frozen, asc: ascender, chunks: [], done: 0 };
    }
    const cc = cache.current;
    if (cc.done < frozen.length) {
      // Only chunks that receive new dots get a new string.
      const parts = new Map<number, string[]>();
      for (let i = cc.done; i < frozen.length; i++) {
        const k = Math.floor(i / CHUNK);
        const arr = parts.get(k) ?? [];
        arr.push(contourToPath(frozen[i], ascender));
        parts.set(k, arr);
      }
      for (const [k, arr] of parts) cc.chunks[k] = cc.chunks[k] ? `${cc.chunks[k]} ${arr.join(" ")}` : arr.join(" ");
      cc.done = frozen.length;
    }
    chunks = cc.chunks;
  } else if (cache.current.arr) {
    cache.current = { arr: null, asc: NaN, chunks: [], done: 0 };
  }
  if (!outline.length && !chunks.length) return null;
  return (
    <g opacity={0.9}>
      {chunks.map((d, k) => (
        <path key={k} d={d} className="obj-fill" fillRule="nonzero" />
      ))}
      {outline.length > 0 && (
        <path d={outline.map((c) => contourToPath(c, ascender)).join(" ")} className="obj-fill" fillRule="nonzero" />
      )}
    </g>
  );
});
