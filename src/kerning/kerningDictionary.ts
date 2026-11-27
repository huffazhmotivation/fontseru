import type { FontMetrics } from "@/types/font";
import type { GlyphMap } from "@/types/glyph";
import { hasOutline } from "@/types/glyph";
import { opticalPairGap } from "./autoKern";

/**
 * Test Lab "Kamus Kerning": every pair of the glyphs you have drawn, grouped
 * the way type designers proof kerning, plus a filter that finds the pairs
 * that actually need attention.
 *
 * How "needs checking" is decided — kerning is what's left after spacing:
 *  1. The optical gap of every pair (tightest real distance between the two
 *     letterforms, `opticalPairGap`) is measured.
 *  2. An additive spacing model gap(a,b) ≈ R[a] + L[b] is fitted with
 *     medians (robust): R[a] is how much room glyph `a` usually leaves on its
 *     right, L[b] how much `b` usually leaves on its left. A well-spaced pair
 *     like "nn", "HO" or "oo" matches the model — its side bearings already
 *     do the job.
 *  3. Pairs whose gap (with their current kerning) is far from the model —
 *     AV, To, LT, r. … — are exactly the ones kerning exists for. The
 *     suggestion is the amount that brings the pair back to the model,
 *     never letting the two shapes touch.
 * (A plain "differs from the auto-kern target" test flagged ~85% of all
 * pairs on real fonts; this flags the 10–15% that matter.)
 */

export type DictGroupId = "UU" | "Ul" | "ll" | "lU" | "dd" | "Up" | "lp" | "Lq" | "ds" | "pp";

export interface DictGroup {
  id: DictGroupId;
  label: string;
  pairs: [string, string][];
  /** Control characters each pair is shown between (left, right), 1–2 variants. */
  frames: [string, string][];
}

export interface PairResult {
  gap: number;
  want: number;
  /** Kerning value that brings the pair to the model (font units, multiple of 5). */
  suggest: number;
}

const UC_BASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LC_BASE = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const PUNCT = ".,:;!?-–—/&*…";
const QUOTES = "'\"‘’“”‚„()[]{}«»‹›";
const SYMBOLS = "$€£¥¢%‰#+−×÷=<>°@§©®™^~|\\_";

const isUpper = (c: string) => c.length === 1 && c !== c.toLowerCase() && c === c.toUpperCase();
const isLower = (c: string) => c.length === 1 && c !== c.toUpperCase() && c === c.toLowerCase();

function cross(a: string[], b: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const x of a) for (const y of b) out.push([x, y]);
  return out;
}
function both(a: string[], b: string[]): [string, string][] {
  return cross(a, b).concat(cross(b, a));
}

/** Characters with real outlines, split by role. `extended` adds accented letters etc. */
export function dictionaryCharsets(glyphs: GlyphMap, extended: boolean) {
  const drawn = new Set(Object.keys(glyphs).filter((c) => [...c].length === 1 && glyphs[c] && hasOutline(glyphs[c])));
  const pick = (list: string) => [...list].filter((c) => drawn.has(c));
  let uc = pick(UC_BASE);
  let lc = pick(LC_BASE);
  if (extended) {
    for (const c of drawn) {
      if (isUpper(c) && !uc.includes(c)) uc.push(c);
      else if (isLower(c) && !lc.includes(c)) lc.push(c);
    }
  }
  return {
    uc,
    lc,
    digits: pick(DIGITS),
    punct: pick(PUNCT),
    quotes: pick(QUOTES),
    symbols: pick(SYMBOLS),
  };
}

export function buildDictionaryGroups(glyphs: GlyphMap, extended: boolean): DictGroup[] {
  const cs = dictionaryCharsets(glyphs, extended);
  const has = (c: string) => !!glyphs[c] && hasOutline(glyphs[c]);
  const first = (...cands: string[]) => cands.find((s) => [...s].every(has)) ?? "";
  const H = first("HH", "II", "ll");
  const O = first("OO", "oo");
  const n = first("nn", "ll", "HH");
  const o = first("oo", "OO");
  const zero = first("00", "OO", "oo");
  const one = first("11", "HH", "nn");
  const frames = (...f: [string, string][]) => {
    const seen = new Set<string>();
    return f.filter(([l, r]) => {
      const k = l + "|" + r;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const letters = cs.uc.concat(cs.lc);
  const marks = cs.punct.concat(cs.quotes);
  // The standard proofing set: every case combination, figures, and each
  // class against punctuation, quotes/brackets and symbols, in the order
  // type designers usually work through them.
  const groups: DictGroup[] = [
    { id: "UU", label: "Kapital + Kapital", pairs: cross(cs.uc, cs.uc), frames: frames([H, H], [O, O]) },
    { id: "Ul", label: "Kapital + kecil", pairs: cross(cs.uc, cs.lc), frames: frames([H, n], [O, o]) },
    { id: "ll", label: "kecil + kecil", pairs: cross(cs.lc, cs.lc), frames: frames([n, n], [o, o]) },
    { id: "lU", label: "kecil + Kapital", pairs: cross(cs.lc, cs.uc), frames: frames([n, H], [o, O]) },
    { id: "dd", label: "Angka", pairs: cross(cs.digits, cs.digits), frames: frames([zero, zero], [one, one]) },
    { id: "Up", label: "Kapital + tanda baca", pairs: both(cs.uc, cs.punct), frames: frames([H, H], [O, O]) },
    { id: "lp", label: "kecil + tanda baca", pairs: both(cs.lc, cs.punct), frames: frames([n, n], [o, o]) },
    { id: "Lq", label: "Kutip & kurung", pairs: both(letters.concat(cs.digits), cs.quotes), frames: frames([n, n], [H, H]) },
    { id: "ds", label: "Angka + simbol", pairs: both(cs.digits, cs.punct.concat(cs.symbols)), frames: frames([zero, zero]) },
    { id: "pp", label: "Tanda baca + tanda baca", pairs: cross(marks, marks).filter(([a, b]) => a !== b || a === "." || a === "'"), frames: frames([n, n]) },
  ];
  return groups.filter((g) => g.pairs.length > 0);
}

export const pairId = (l: string, r: string) => `${l}\u0000${r}`;

/** Deviation (font units) above which a pair is listed as "Perlu dicek". */
export const needsCheckThreshold = (metrics: FontMetrics) => metrics.unitsPerEm * 0.04;

const median = (vals: number[]): number => {
  const v = vals.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Measures every pair of every group (chunked so the UI stays responsive)
 * and fits the spacing model. Resolves with a map pairId → result, or null
 * when cancelled via `signal`.
 */
export async function analyseDictionary(
  glyphs: GlyphMap,
  metrics: FontMetrics,
  groups: DictGroup[],
  onProgress?: (done: number, total: number) => void,
  signal?: { cancelled: boolean },
): Promise<Map<string, PairResult> | null> {
  // Every glyph that appears anywhere, and the letter/figure "reference"
  // set the model's medians are taken over (punctuation behaves too
  // differently to define what normal spacing is).
  const all = new Set<string>();
  for (const g of groups) for (const [l, r] of g.pairs) { all.add(l); all.add(r); }
  // Spacing depends on what's next to a glyph: "T" leaves a big gap before
  // "H" but tucks lowercase under its bar, so one "right side of T" number
  // can't describe both. The model therefore keeps two sides per glyph —
  // facing capitals/figures/punctuation ("U") and facing lowercase ("l") —
  // each estimated from a small fixed sample of everyday shapes (straight,
  // round, diagonal). ~25 references keep it as stable as using every
  // letter while measuring a fraction of the pairs.
  const drawnHas = (c: string) => all.has(c) || (!!glyphs[c] && hasOutline(glyphs[c]));
  const REF_U = [..."HIOEDNBU01"].filter(drawnHas);
  const REF_L = [..."noadbpqcehlmrsuv"].filter(drawnHas);
  const cls = (c: string): "U" | "l" => (isLower(c) ? "l" : "U");
  const refs: Record<"U" | "l", string[]> = {
    U: REF_U.length >= 3 ? REF_U : REF_L,
    l: REF_L.length >= 3 ? REF_L : REF_U,
  };
  if (!refs.U.length) {
    const fallback = [...all].slice(0, 24);
    refs.U = fallback;
    refs.l = fallback;
  }
  const refList = [...new Set(refs.U.concat(refs.l))];

  // Pairs to measure: every dictionary pair + every (x, ref) and (ref, x).
  const need = new Map<string, [string, string]>();
  for (const g of groups) for (const [l, r] of g.pairs) need.set(pairId(l, r), [l, r]);
  for (const x of all) for (const y of refList) {
    need.set(pairId(x, y), [x, y]);
    need.set(pairId(y, x), [y, x]);
  }
  const gaps = new Map<string, number>();
  const total = need.size;
  let done = 0;
  let t0 = performance.now();
  for (const [id, [l, r]] of need) {
    gaps.set(id, opticalPairGap(glyphs, metrics, l, r));
    done++;
    if (performance.now() - t0 > 12) {
      onProgress?.(done, total);
      await yieldToBrowser();
      if (signal?.cancelled) return null;
      t0 = performance.now();
    }
  }
  onProgress?.(total, total);

  // Additive model gap(a,b) ≈ R[a][cls(b)] + L[b][cls(a)], fitted by
  // alternating medians.
  const key = (c: string, k: "U" | "l") => c + "\u0001" + k;
  const R = new Map<string, number>();
  const L = new Map<string, number>();
  const sides = ["U", "l"] as const;
  for (let it = 0; it < 3; it++) {
    for (const a of all) for (const k of sides) {
      R.set(key(a, k), median(refs[k].map((b) => (gaps.get(pairId(a, b)) ?? NaN) - (L.get(key(b, cls(a))) ?? 0))));
    }
    for (const b of all) for (const k of sides) {
      L.set(key(b, k), median(refs[k].map((a) => (gaps.get(pairId(a, b)) ?? NaN) - (R.get(key(a, cls(b))) ?? 0))));
    }
  }
  // Cross-case sides must NOT be learned per glyph: "T" faces every
  // lowercase letter with the same big gap (its bar overhangs them), so a
  // per-glyph median would call that normal and hide To/Ta/Ty. Instead a
  // glyph's side toward the other case = its side toward its own case plus
  // the font-wide case-transition offset measured on the reference shapes
  // (straight/round letters that need no kerning).
  const deltaR: Record<string, number> = {};
  const deltaL: Record<string, number> = {};
  for (const c of sides) for (const k of sides) {
    if (c === k) continue;
    deltaR[c + k] = median(refs[c].map((h) => (R.get(key(h, k)) ?? NaN) - (R.get(key(h, c)) ?? NaN)));
    deltaL[c + k] = median(refs[c].map((h) => (L.get(key(h, k)) ?? NaN) - (L.get(key(h, c)) ?? NaN)));
  }
  for (const x of all) {
    const c = cls(x);
    for (const k of sides) {
      if (k === c) continue;
      R.set(key(x, k), (R.get(key(x, c)) ?? 0) + (deltaR[c + k] ?? 0));
      L.set(key(x, k), (L.get(key(x, c)) ?? 0) + (deltaL[c + k] ?? 0));
    }
  }
  const wantOf = (l: string, r: string) => (R.get(key(l, cls(r))) ?? 0) + (L.get(key(r, cls(l))) ?? 0);

  const minSafe = metrics.unitsPerEm * 0.014;
  const out = new Map<string, PairResult>();
  for (const g of groups) for (const [l, r] of g.pairs) {
    const id = pairId(l, r);
    const gap = gaps.get(id) ?? NaN;
    if (!Number.isFinite(gap)) continue;
    const want = wantOf(l, r);
    let suggest = Math.round((want - gap) / 5) * 5;
    // never close the pair past the touching floor
    if (gap + suggest < minSafe) suggest = Math.ceil((minSafe - gap) / 5) * 5;
    out.set(id, { gap, want, suggest });
  }
  return out;
}

/** How far the pair currently is from the model, given its current kerning. */
export function pairDeviation(res: PairResult, current: number): number {
  return Math.abs(res.gap + current - res.want);
}
