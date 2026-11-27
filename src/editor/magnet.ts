/**
 * Magnetic snapping shared by the Select, Node and Pen tools.
 *
 * The old snap was a plain "within N px?" test (6–8 screen px), so it only
 * caught when you were already almost exactly there, and let go again the
 * moment the hand drifted a pixel — it felt weak and slippery. This adds:
 *
 *  • a wider catch radius (SNAP_CATCH_PX), and
 *  • hysteresis: once an axis has locked onto a target it STAYS locked
 *    until the pointer pulls more than SNAP_RELEASE_PX away from it — the
 *    sticky "click into place" feel of Figma / Illustrator / Glyphs.
 *
 * Each axis is independent (an object can sit on the baseline while you
 * slide it sideways). All tolerances are screen pixels; callers convert
 * with hitScale (font units per screen px).
 */
export const SNAP_CATCH_PX = 12;
export const SNAP_RELEASE_PX = 20;

/** Which moving edge locked onto which target on one axis. */
export interface AxisLock {
  edge: number;
  target: number;
}

/**
 * One axis. `edges` are the moving positions (e.g. an object's min/centre/
 * max after the proposed move); `targets` the guide positions. Returns the
 * correction to add on this axis and the new lock (null when free).
 */
export function magnetAxis(
  edges: number[],
  targets: number[],
  catchTol: number,
  releaseTol: number,
  prev: AxisLock | null,
): { correction: number; lock: AxisLock | null } {
  if (!targets.length || !edges.length) return { correction: 0, lock: null };
  // Stay locked while still within the (larger) release distance.
  if (prev && prev.edge < edges.length && Math.abs(edges[prev.edge] - prev.target) <= releaseTol) {
    // …unless another target is now clearly closer (sliding along to the
    // next guide shouldn't need a big tug first).
    const held = Math.abs(edges[prev.edge] - prev.target);
    const best = nearest(edges, targets, catchTol);
    if (!best || best.dist >= held * 0.5) return { correction: prev.target - edges[prev.edge], lock: prev };
    return { correction: best.target - edges[best.edge], lock: { edge: best.edge, target: best.target } };
  }
  const best = nearest(edges, targets, catchTol);
  if (!best) return { correction: 0, lock: null };
  return { correction: best.target - edges[best.edge], lock: { edge: best.edge, target: best.target } };
}

function nearest(edges: number[], targets: number[], tol: number): { edge: number; target: number; dist: number } | null {
  let out: { edge: number; target: number; dist: number } | null = null;
  for (let e = 0; e < edges.length; e++) {
    const v = edges[e];
    for (const t of targets) {
      const d = Math.abs(t - v);
      if (d <= tol && (!out || d < out.dist)) out = { edge: e, target: t, dist: d };
    }
  }
  return out;
}

/** De-duplicated, finite targets (keeps the inner loops short). */
export function uniqTargets(values: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const k = Math.round(v * 100) / 100;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}
