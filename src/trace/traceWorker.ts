/// <reference lib="webworker" />
// Runs the precision tracer off the main thread so the Trace Image panel
// (sliders, magnifier, glyph list) stays responsive while a large photo is
// being traced.
import { precisionOptionsFor, traceRGBA, type PrecisionDetail } from "./precisionTrace";

interface Req {
  id: number;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  detail: PrecisionDetail;
  threshold: number;
  invert: boolean;
  upscale: number;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, rgba, width, height, detail, threshold, invert, upscale } = e.data;
  try {
    const opts = precisionOptionsFor(detail, threshold, invert, Math.max(width, height), upscale);
    const { objects } = traceRGBA(rgba, width, height, opts);
    (self as unknown as Worker).postMessage({ id, objects });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
