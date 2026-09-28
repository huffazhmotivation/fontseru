import type { StrokeSample } from "@/types/geometry";

/**
 * Procreate-style live stroke stabilizer for the Brush tool.
 *
 * Two stages run on every raw pointer sample, in real time, and their output
 * IS the stroke — the live preview and the committed geometry are built from
 * the same stabilized stream, so a stroke never changes shape on pen-up.
 *
 *  1. MOTION FILTER — a One-Euro adaptive low-pass (Casiez et al., CHI 2012).
 *     Its cutoff rises with pointer speed: slow, careful movement is filtered
 *     hard (hand tremor disappears), fast confident sweeps pass through with
 *     almost no lag. This speed-awareness is what makes it feel "natural"
 *     rather than rubbery.
 *  2. STREAMLINE — a "pulled string": the brush tip trails the filtered
 *     pointer on a virtual string of length R and only moves when the string
 *     goes taut. Wobbles smaller than the string never reach the ink, and
 *     curves come out long and even. When the pen lifts, the tip catches up
 *     to where the pen actually ended, so the stroke still lands exactly.
 *
 * All distances are in SCREEN pixels (converted with `unitsPerPx`), so the
 * feel is the same at every zoom level. `amount` is the Brush Stabilizer
 * setting, 0..1; 0 passes raw samples straight through.
 */
export class StrokeStabilizer {
  /** Stabilized samples so far (font units). Grows in place. */
  readonly samples: StrokeSample[] = [];

  private readonly amount: number;
  private readonly unitsPerPx: number;
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly stringLen: number;
  private readonly catchUpRate: number;
  private readonly minStep: number;

  private fx: number;
  private fy: number;
  private fp: number;
  private vx = 0;
  private vy = 0;
  private sx: number;
  private sy: number;
  private lastT: number;
  private lastRaw: StrokeSample;

  constructor(amount: number, unitsPerPx: number, first: StrokeSample, timeMs: number) {
    this.amount = Math.max(0, Math.min(1, amount));
    this.unitsPerPx = Math.max(1e-6, unitsPerPx);
    const a = this.amount;
    // Hz. Low cutoff = strong smoothing of slow movement.
    this.minCutoff = 0.5 + 5 * (1 - a) * (1 - a);
    // Per (screen px / s): how quickly speed opens the filter back up.
    this.beta = 0.006 * (1 - 0.5 * a);
    // Screen px of string between pen and ink.
    this.stringLen = 36 * Math.pow(a, 1.5);
    // While the string is slack the tip still drifts toward the pen, so
    // slow drawing keeps moving — slower at higher settings.
    this.catchUpRate = 1.5 + 10 * (1 - a);
    this.minStep = 0.5;
    this.fx = first.x;
    this.fy = first.y;
    this.fp = first.pressure;
    this.sx = first.x;
    this.sy = first.y;
    this.lastT = timeMs;
    this.lastRaw = first;
    this.samples.push({ ...first });
  }

  push(raw: StrokeSample, timeMs: number): void {
    this.lastRaw = raw;
    if (this.amount <= 0) {
      this.samples.push({ ...raw });
      return;
    }
    const dt = Math.max(0.001, Math.min(0.05, (timeMs - this.lastT) / 1000 || 1 / 120));
    this.lastT = timeMs;

    // 1. One-Euro motion filter (speed measured in screen px/s).
    const rvx = (raw.x - this.fx) / dt;
    const rvy = (raw.y - this.fy) / dt;
    const ad = alpha(1, dt);
    this.vx += ad * (rvx - this.vx);
    this.vy += ad * (rvy - this.vy);
    const speedPx = Math.hypot(this.vx, this.vy) / this.unitsPerPx;
    const cutoff = this.minCutoff + this.beta * speedPx;
    const ap = alpha(cutoff, dt);
    this.fx += ap * (raw.x - this.fx);
    this.fy += ap * (raw.y - this.fy);
    this.fp += alpha(this.minCutoff * 1.5 + 2, dt) * (raw.pressure - this.fp);

    // 2. StreamLine string.
    const r = this.stringLen * this.unitsPerPx;
    const dx = this.fx - this.sx;
    const dy = this.fy - this.sy;
    const dist = Math.hypot(dx, dy);
    if (dist > r) {
      const k = 1 - r / dist;
      this.sx += dx * k;
      this.sy += dy * k;
    }
    const drift = Math.min(1, this.catchUpRate * dt);
    this.sx += (this.fx - this.sx) * drift;
    this.sy += (this.fy - this.sy) * drift;
    this.emit(this.sx, this.sy, this.fp);
  }

  /** Samples that carry the tip from where it trails to where the pen
   * lifted — append on pen-up (Procreate's end-of-stroke catch-up). */
  finish(): StrokeSample[] {
    if (this.amount <= 0) return [];
    const last = this.samples[this.samples.length - 1];
    const end = this.lastRaw;
    const gap = Math.hypot(end.x - last.x, end.y - last.y) / this.unitsPerPx;
    if (gap < this.minStep) return [];
    const steps = Math.max(1, Math.ceil(gap / 3));
    const out: StrokeSample[] = [];
    // Ease in along the filtered direction first so the catch-up joins the
    // curve smoothly instead of kinking toward the lift point.
    const mx = (this.fx + end.x) / 2;
    const my = (this.fy + end.y) / 2;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      out.push({
        x: u * u * last.x + 2 * u * t * mx + t * t * end.x,
        y: u * u * last.y + 2 * u * t * my + t * t * end.y,
        pressure: last.pressure + (this.fp - last.pressure) * t,
      });
    }
    return out;
  }

  private emit(x: number, y: number, pressure: number): void {
    const last = this.samples[this.samples.length - 1];
    if (Math.hypot(x - last.x, y - last.y) < this.minStep * this.unitsPerPx) {
      last.pressure = pressure;
      return;
    }
    this.samples.push({ x, y, pressure });
  }
}

function alpha(cutoffHz: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
}
