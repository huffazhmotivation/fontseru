let counter = 0;

// One timestamp per session (module load), not per call. The old version
// called Date.now().toString(36) for EVERY id — fine for a handful of
// objects, but a Spray Brush stroke creates 100k+ node ids at once, and that
// call was ~18% of the whole build time on its own. Uniqueness is unchanged:
// within a session the counter never repeats, and across sessions the stamp
// differs (it is the load time), which is what kept ids from colliding with
// ones already saved in a project before.
const SESSION_STAMP = Date.now().toString(36);

/** Fast, collision-safe-enough id for in-session objects (nodes, contours). */
export function shortId(prefix: string): string {
  counter += 1;
  return `${prefix}_${SESSION_STAMP}_${counter.toString(36)}`;
}
