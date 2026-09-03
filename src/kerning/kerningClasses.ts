import type { GlyphMap } from "@/types/glyph";
import type { FontMetrics } from "@/types/font";
import { outlineBounds } from "@/editor/objectOps";
import { inkExtentAtY } from "@/kerning/autoKern";
import {
  kerningKey,
  classPairKey,
  type KerningClass,
  type KerningClasses,
  type KerningPairs,
  type KerningManualFlags,
} from "@/types/kerning";

const PROFILE_SAMPLES = 14;
// Two glyphs join the same class when their normalized edge profiles differ
// by less than this (fraction of unitsPerEm). Loose enough that e.g. "O"
// and "Q" (which only differ by a small tail) still cluster together, tight
// enough that "O" and "L" don't.
const CLUSTER_THRESHOLD = 0.055;

/**
 * Samples a glyph's silhouette against `edge` ("right" = distance from the
 * glyph's own advance width in to its ink, i.e. what a following glyph
 * would meet; "left" = distance from x=0 out to its ink, i.e. what a
 * preceding glyph would meet), at a fixed set of heights shared by every
 * glyph being compared (0..unitsPerEm, not each glyph's own bounds) so the
 * resulting vectors are directly comparable across different letterforms.
 * Falls back to a flat profile from lsb/rsb/advanceWidth for glyphs with no
 * outline drawn yet, so ungrouped/undrawn glyphs still get a sensible
 * (if coarse) initial classification instead of being skipped.
 */
function edgeProfile(glyphs: GlyphMap, metrics: FontMetrics, ch: string, edge: "left" | "right"): number[] | null {
  const g = glyphs[ch];
  if (!g) return null;
  const upm = metrics.unitsPerEm || 1000;
  const bounds = outlineBounds(g.outline);

  if (!bounds) {
    const flat = edge === "right" ? g.rsb / upm : g.lsb / upm;
    return new Array(PROFILE_SAMPLES).fill(Math.max(0, Math.min(1, flat)));
  }

  const profile: number[] = [];
  for (let i = 0; i < PROFILE_SAMPLES; i++) {
    const t = PROFILE_SAMPLES === 1 ? 0.5 : i / (PROFILE_SAMPLES - 1);
    const y = upm * t;
    const ink = inkExtentAtY(g.outline, y);
    let value: number;
    if (!ink) {
      // No ink at this height (e.g. below "T"'s crossbar) — treat as fully
      // open, same as the widest gap this glyph can show, rather than 0
      // which would falsely read as "touching".
      value = 1;
    } else {
      value = edge === "right" ? (g.advanceWidth - ink.max) / upm : ink.min / upm;
    }
    profile.push(Math.max(-1, Math.min(1, value)));
  }
  return profile;
}

function profileDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum / a.length);
}

/** Greedy nearest-centroid clustering — simple and deterministic, which
 * matters here so re-running Auto-Generate on unchanged glyphs gives
 * predictable, reviewable results rather than shuffling groupings. */
function clusterByProfile(
  chars: string[],
  profiles: Map<string, number[]>,
  side: "left" | "right",
  idPrefix: string
): KerningClass[] {
  interface Cluster { members: string[]; sum: number[] }
  const clusters: Cluster[] = [];

  for (const ch of chars) {
    const profile = profiles.get(ch);
    if (!profile) continue;

    let best: Cluster | null = null;
    let bestDist = Infinity;
    for (const cluster of clusters) {
      const centroid = cluster.sum.map((v) => v / cluster.members.length);
      const dist = profileDistance(profile, centroid);
      if (dist < bestDist) { bestDist = dist; best = cluster; }
    }

    if (best && bestDist <= CLUSTER_THRESHOLD) {
      best.members.push(ch);
      best.sum = best.sum.map((v, i) => v + profile[i]);
    } else {
      clusters.push({ members: [ch], sum: [...profile] });
    }
  }

  return clusters
    .filter((c) => c.members.length >= 2) // singletons stay ungrouped — no noise from one-glyph "classes"
    .map((c, i) => ({
      id: `${idPrefix}-${i}`,
      name: autoClassName(c.members),
      side,
      members: c.members,
      auto: true,
    }));
}

/** Short, human-scannable name from a cluster's members, e.g. "O·Q·C·G+2". */
function autoClassName(members: string[]): string {
  const shown = members.slice(0, 4).join("·");
  return members.length > 4 ? `${shown}+${members.length - 4}` : shown;
}

/**
 * Clusters the current glyph set into Left-position and Right-position
 * kerning classes purely from drawn shape (see `edgeProfile`). Excludes the
 * space glyph for the same reason the geometry-based pair auto-kern does —
 * it has no ink to classify and already has its own dedicated Word Spacing
 * control.
 */
export function autoGenerateKerningClasses(glyphs: GlyphMap, metrics: FontMetrics): KerningClasses {
  const chars = Object.keys(glyphs).filter((ch) => glyphs[ch].unicode !== 0x20);

  const rightProfiles = new Map<string, number[]>();
  const leftProfiles = new Map<string, number[]>();
  for (const ch of chars) {
    const rp = edgeProfile(glyphs, metrics, ch, "right");
    const lp = edgeProfile(glyphs, metrics, ch, "left");
    if (rp) rightProfiles.set(ch, rp);
    if (lp) leftProfiles.set(ch, lp);
  }

  const stamp = Date.now().toString(36);
  return {
    // Left-position classes group by the glyph's own RIGHT-edge shape —
    // that's the side that faces (and matters to) whatever comes after it.
    left: clusterByProfile(chars, rightProfiles, "left", `auto-l-${stamp}`),
    // Right-position classes group by the glyph's own LEFT-edge shape —
    // the side that faces whatever came before it.
    right: clusterByProfile(chars, leftProfiles, "right", `auto-r-${stamp}`),
  };
}

/**
 * Flattens every stored class-pair value into ordinary glyph-pair
 * `kerningPairs` entries, skipping any pair already flagged `manual`
 * (hand-tuned pairs always win — identical guarantee to the geometry-based
 * global Auto Kerning pass). A class value of exactly 0 clears any
 * previously class-filled (non-manual) entry instead of writing an
 * explicit 0, keeping persisted state compact.
 *
 * This is the one place class metadata ever touches the real kerning
 * table — every renderer/exporter downstream keeps reading plain
 * `kerningPairs` and needs no changes at all.
 */
export function materializeClassKerning(
  classes: KerningClasses,
  classKerningPairs: Record<string, number>,
  currentPairs: KerningPairs,
  currentManual: KerningManualFlags
): { pairs: KerningPairs; manual: KerningManualFlags; filled: number } {
  const pairs = { ...currentPairs };
  const manual = { ...currentManual };
  let filled = 0;

  for (const [ckey, value] of Object.entries(classKerningPairs)) {
    const sep = ckey.indexOf("::");
    if (sep === -1) continue;
    const leftId = ckey.slice(0, sep);
    const rightId = ckey.slice(sep + 2);
    const leftClass = classes.left.find((c) => c.id === leftId);
    const rightClass = classes.right.find((c) => c.id === rightId);
    if (!leftClass || !rightClass) continue;

    for (const l of leftClass.members) {
      for (const r of rightClass.members) {
        const key = kerningKey(l, r);
        if (manual[key]) continue;
        if (value === 0) {
          if (key in pairs) { delete pairs[key]; filled++; }
        } else {
          if (pairs[key] !== value) filled++;
          pairs[key] = value;
          manual[key] = false;
        }
      }
    }
  }

  return { pairs, manual, filled };
}

/** Convenience for the UI: the class-pair value currently stored for a
 * (leftClassId, rightClassId) combination, or 0 if unset. */
export function getClassKerningValue(classKerningPairs: Record<string, number>, leftId: string, rightId: string): number {
  return classKerningPairs[classPairKey(leftId, rightId)] ?? 0;
}
