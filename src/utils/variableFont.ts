/**
 * Variable font building blocks (TrueType / gvar flavour).
 *
 * FontSeru's family styles (Regular, Bold, Italic and custom families) become
 * the *masters* of one variable font. Each master sits at a location in the
 * design space — `wght` from its style name, `slnt` when it is an italic —
 * and Regular is the default. The interpolation model and the binary tables
 * below follow the OpenType 1.9 spec; the model is a port of fontTools'
 * `varLib.models.VariationModel`, so any master layout fontTools accepts
 * (on-axis masters, corners like Bold Italic) is handled the same way.
 *
 * Everything here is pure: no store, no DOM. fontIO.ts glues it to the export.
 */

export type AxisTag = "wght" | "slnt";

export interface VariationAxis {
  tag: AxisTag;
  name: string;
  min: number;
  defaultValue: number;
  max: number;
}

/** A user-space location, e.g. { wght: 700, slnt: -12 }. */
export type UserLocation = Partial<Record<AxisTag, number>>;
/** A normalized location in [-1, 1] per axis; axes at their default are omitted. */
export type NormLocation = Partial<Record<AxisTag, number>>;
type Triple = [number, number, number];
export type Support = Partial<Record<AxisTag, Triple>>;

// ---------------------------------------------------------------- naming

const WEIGHT_NAMES: Array<[number, string]> = [
  [100, "Thin"], [200, "ExtraLight"], [300, "Light"], [400, "Regular"], [500, "Medium"],
  [600, "SemiBold"], [700, "Bold"], [800, "ExtraBold"], [900, "Black"],
];

export function weightName(weight: number): string {
  const exact = WEIGHT_NAMES.find(([w]) => w === weight);
  return exact ? exact[1] : `W${Math.round(weight)}`;
}

/** Same name → weight rule the static exporter uses for usWeightClass. */
export function weightFromStyleName(styleName: string): number {
  const style = styleName.toLowerCase().replace(/[-_]+/g, " ");
  if (/\b(thin|hairline)\b/.test(style)) return 100;
  if (/\b(extra ?light|ultra ?light)\b/.test(style)) return 200;
  if (/\blight\b/.test(style)) return 300;
  if (/\bmedium\b/.test(style)) return 500;
  if (/\b(semi ?bold|demi ?bold)\b/.test(style)) return 600;
  if (/\b(extra ?bold|ultra ?bold)\b/.test(style)) return 800;
  if (/\b(black|heavy)\b/.test(style)) return 900;
  if (/\bbold\b/.test(style)) return 700;
  return 400;
}

export function isItalicStyleName(styleName: string): boolean {
  return /\b(italic|oblique|slanted)\b/i.test(styleName);
}

/** Quick, name-only preview of the axes a set of styles would give (for the
 *  Export dialog). Regular must be among them. The real placement happens at
 *  export time and also reads the geometry (e.g. the italic angle). */
export function planVariableAxes(styleNames: string[]): { weight: [number, number] | null; slant: boolean } | null {
  if (styleNames.length < 2) return null;
  const weights = styleNames.map(weightFromStyleName);
  const slant = styleNames.some(isItalicStyleName);
  const min = Math.min(...weights), max = Math.max(...weights);
  const weight: [number, number] | null = min !== max ? [min, max] : null;
  return weight || slant ? { weight, slant } : null;
}

// ---------------------------------------------------------------- model

export function normalizeValue(value: number, axis: VariationAxis): number {
  if (value === axis.defaultValue) return 0;
  if (value < axis.defaultValue) {
    const span = axis.defaultValue - axis.min;
    return span > 0 ? Math.max(-1, (value - axis.defaultValue) / span) : 0;
  }
  const span = axis.max - axis.defaultValue;
  return span > 0 ? Math.min(1, (value - axis.defaultValue) / span) : 0;
}

export function normalizeLocation(location: UserLocation, axes: VariationAxis[]): NormLocation {
  const out: NormLocation = {};
  for (const axis of axes) {
    const v = normalizeValue(location[axis.tag] ?? axis.defaultValue, axis);
    if (v !== 0) out[axis.tag] = v;
  }
  return out;
}

export function supportScalar(location: NormLocation, support: Support): number {
  let scalar = 1;
  for (const tag of Object.keys(support) as AxisTag[]) {
    const [lower, peak, upper] = support[tag]!;
    if (peak === 0) continue;
    if (lower > peak || peak > upper) continue;
    if (lower < 0 && upper > 0) continue;
    const v = location[tag] ?? 0;
    if (v === peak) continue;
    if (v <= lower || upper <= v) return 0;
    scalar *= v < peak ? (v - lower) / (peak - lower) : (v - upper) / (peak - upper);
  }
  return scalar;
}

/**
 * fontTools-compatible variation model. `locations[0]` must be the default
 * (an empty normalized location). Masters are re-ordered internally; deltas
 * come back in that internal order together with each one's support region.
 */
export class VariationModel {
  readonly locations: NormLocation[];
  readonly order: number[];
  readonly supports: Support[];
  private readonly deltaWeights: Array<Map<number, number>>;

  constructor(locations: NormLocation[]) {
    const axisPoints = new Map<AxisTag, Set<number>>();
    for (const loc of locations) {
      const keys = Object.keys(loc) as AxisTag[];
      if (keys.length !== 1) continue;
      const set = axisPoints.get(keys[0]) ?? new Set([0]);
      set.add(loc[keys[0]]!);
      axisPoints.set(keys[0], set);
    }
    const sign = (v: number) => (v < 0 ? -1 : v > 0 ? 1 : 0);
    const keyOf = (loc: NormLocation): Array<number | string> => {
      const axes = (Object.keys(loc) as AxisTag[]).sort();
      const onPoint = axes.filter((a) => axisPoints.get(a)?.has(loc[a]!)).length;
      return [axes.length, -onPoint, axes.join(","), ...axes.map((a) => sign(loc[a]!)), ...axes.map((a) => Math.abs(loc[a]!))];
    };
    const cmp = (a: Array<number | string>, b: Array<number | string>) => {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i], y = b[i];
        if (x === y) continue;
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        return x < y ? -1 : 1;
      }
      return 0;
    };
    this.order = locations.map((_, i) => i).sort((i, j) => cmp(keyOf(locations[i]), keyOf(locations[j])));
    this.locations = this.order.map((i) => locations[i]);
    if (Object.keys(this.locations[0]).length !== 0) throw new Error("Variable font: the default master is missing.");
    this.supports = this.computeSupports();
    this.deltaWeights = this.locations.map((loc, i) => {
      const weights = new Map<number, number>();
      for (let j = 0; j < i; j++) {
        const s = supportScalar(loc, this.supports[j]);
        if (s) weights.set(j, s);
      }
      return weights;
    });
  }

  private computeSupports(): Support[] {
    const minV: NormLocation = {};
    const maxV: NormLocation = {};
    for (const loc of this.locations) {
      for (const tag of Object.keys(loc) as AxisTag[]) {
        const v = loc[tag]!;
        minV[tag] = Math.min(v, minV[tag] ?? v);
        maxV[tag] = Math.max(v, maxV[tag] ?? v);
      }
    }
    const regions: Support[] = this.locations.map((loc) => {
      const region: Support = {};
      for (const tag of Object.keys(loc) as AxisTag[]) {
        const v = loc[tag]!;
        region[tag] = v > 0 ? [0, v, maxV[tag]!] : [minV[tag]!, v, 0];
      }
      return region;
    });
    regions.forEach((region, i) => {
      const locAxes = Object.keys(region).sort().join(",");
      for (const prev of regions.slice(0, i)) {
        if (Object.keys(prev).sort().join(",") !== locAxes) continue;
        let relevant = true;
        for (const tag of Object.keys(region) as AxisTag[]) {
          const [lower, peak, upper] = region[tag]!;
          const pv = prev[tag]![1];
          if (!(pv === peak || (lower < pv && pv < upper))) { relevant = false; break; }
        }
        if (!relevant) continue;
        let bestRatio = -1;
        let bestAxes: Support = {};
        for (const tag of Object.keys(prev) as AxisTag[]) {
          const val = prev[tag]![1];
          const [lower, locV, upper] = region[tag]!;
          let newLower = lower, newUpper = upper, ratio: number;
          if (val < locV) { newLower = val; ratio = (val - locV) / (lower - locV); }
          else if (locV < val) { newUpper = val; ratio = (val - locV) / (upper - locV); }
          else continue;
          if (ratio > bestRatio) { bestAxes = {}; bestRatio = ratio; }
          if (ratio === bestRatio) bestAxes[tag] = [newLower, locV, newUpper];
        }
        Object.assign(region, bestAxes);
      }
    });
    return regions;
  }

  /** `masterValues` in the ORIGINAL master order; returns deltas in internal order. */
  getDeltas(masterValues: number[]): number[] {
    const out: number[] = [];
    this.deltaWeights.forEach((weights, i) => {
      let delta = masterValues[this.order[i]];
      weights.forEach((w, j) => { delta -= out[j] * w; });
      out.push(delta);
    });
    return out;
  }
}

// ---------------------------------------------------------------- binary

class W {
  private b: number[] = [];
  get length() { return this.b.length; }
  u8(v: number) { this.b.push(v & 0xff); return this; }
  u16(v: number) { const x = v & 0xffff; this.b.push(x >> 8, x & 0xff); return this; }
  i16(v: number) { return this.u16(Math.max(-32768, Math.min(32767, Math.round(v)))); }
  u32(v: number) { const x = v >>> 0; this.b.push(x >>> 24, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff); return this; }
  fixed(v: number) { return this.u32(Math.round(v * 65536) | 0); }
  f2dot14(v: number) { return this.u16(Math.max(-32768, Math.min(32767, Math.round(v * 16384)))); }
  tag(t: string) { for (let i = 0; i < 4; i++) this.u8(t.charCodeAt(i) || 0x20); return this; }
  raw(bytes: Uint8Array | number[]) { for (const x of bytes) this.b.push(x & 0xff); return this; }
  pad2() { if (this.b.length % 2) this.u8(0); return this; }
  bytes() { return Uint8Array.from(this.b); }
}

export interface NamedInstance { nameID: number; location: UserLocation }

export function buildFvar(axes: VariationAxis[], axisNameIDs: number[], instances: NamedInstance[]): Uint8Array {
  const w = new W();
  w.u16(1).u16(0).u16(16).u16(2).u16(axes.length).u16(20).u16(instances.length).u16(4 + 4 * axes.length);
  axes.forEach((axis, i) => {
    w.tag(axis.tag).fixed(axis.min).fixed(axis.defaultValue).fixed(axis.max).u16(0).u16(axisNameIDs[i]);
  });
  for (const inst of instances) {
    w.u16(inst.nameID).u16(0);
    for (const axis of axes) w.fixed(inst.location[axis.tag] ?? axis.defaultValue);
  }
  return w.bytes();
}

export interface StatValue { axisIndex: number; value: number; nameID: number; elidable: boolean }

export function buildStat(axes: VariationAxis[], axisNameIDs: number[], values: StatValue[], elidedFallbackNameID: number): Uint8Array {
  const headerSize = 20;
  const axesSize = axes.length * 8;
  const offsetsStart = headerSize + axesSize;
  const w = new W();
  w.u16(1).u16(1).u16(8).u16(axes.length).u32(headerSize).u16(values.length).u32(values.length ? offsetsStart : 0).u16(elidedFallbackNameID);
  axes.forEach((axis, i) => w.tag(axis.tag).u16(axisNameIDs[i]).u16(i));
  const offsetsSize = values.length * 2;
  values.forEach((_, i) => w.u16(offsetsSize + i * 12));
  for (const v of values) w.u16(1).u16(v.axisIndex).u16(v.elidable ? 0x0002 : 0).u16(v.nameID).fixed(v.value);
  return w.bytes();
}

/** One variation region per non-default master, in the order of `supports`. */
function regionTuple(support: Support, axes: VariationAxis[]): { peak: number[]; start: number[]; end: number[]; intermediate: boolean } {
  const peak: number[] = [], start: number[] = [], end: number[] = [];
  let intermediate = false;
  for (const axis of axes) {
    const t = support[axis.tag];
    if (!t) { peak.push(0); start.push(0); end.push(0); continue; }
    peak.push(t[1]); start.push(t[0]); end.push(t[2]);
    if (t[0] !== Math.min(t[1], 0) || t[2] !== Math.max(t[1], 0)) intermediate = true;
  }
  return { peak, start, end, intermediate };
}

/** Packed deltas: runs of zero / byte / word values, at most 64 per run. */
function packDeltas(values: number[], w: W) {
  const kind = (v: number) => (v === 0 ? 0 : v >= -128 && v <= 127 ? 1 : 2);
  let i = 0;
  while (i < values.length) {
    const k = kind(values[i]);
    let j = i;
    while (j < values.length && j - i < 64 && kind(values[j]) === k) j++;
    const run = j - i;
    if (k === 0) w.u8(0x80 | (run - 1));
    else if (k === 1) { w.u8(run - 1); for (let x = i; x < j; x++) w.u8(values[x]); }
    else { w.u8(0x40 | (run - 1)); for (let x = i; x < j; x++) w.i16(values[x]); }
    i = j;
  }
}

/**
 * gvar for `glyphDeltas[gid]`: one entry per glyph (including .notdef), each an
 * array with one {x, y} delta list per non-default support (internal model
 * order, supports[1..]). Every list covers all outline points + 4 phantom
 * points; a glyph whose deltas are all zero gets no variation data.
 */
export function buildGvar(
  axes: VariationAxis[],
  supports: Support[],
  glyphDeltas: Array<Array<{ x: number[]; y: number[] }>>,
): Uint8Array {
  const glyphCount = glyphDeltas.length;
  const tuples = supports.slice(1).map((s) => regionTuple(s, axes));
  const blobs: Uint8Array[] = glyphDeltas.map((perTuple) => {
    const used = perTuple
      .map((d, ti) => ({ d, ti }))
      .filter(({ d }) => d.x.some((v) => v !== 0) || d.y.some((v) => v !== 0));
    if (!used.length) return new Uint8Array(0);
    // Serialized data: shared point numbers "all points" (single 0 byte),
    // then for each tuple its x and y deltas.
    const serialized = new W();
    serialized.u8(0);
    const sizes: number[] = [];
    for (const { d } of used) {
      const before = serialized.length;
      packDeltas(d.x.map(Math.round), serialized);
      packDeltas(d.y.map(Math.round), serialized);
      sizes.push(serialized.length - before);
    }
    // The shared point-number byte belongs to the serialized data block but not
    // to any tuple's variationDataSize.
    const headerSize = 4 + used.reduce((n, { ti }) => n + 4 + axes.length * 2 * (tuples[ti].intermediate ? 3 : 1), 0);
    const w = new W();
    w.u16(0x8000 | used.length).u16(headerSize);
    used.forEach(({ ti }, k) => {
      const t = tuples[ti];
      w.u16(sizes[k]).u16(0x8000 | (t.intermediate ? 0x4000 : 0));
      for (const v of t.peak) w.f2dot14(v);
      if (t.intermediate) { for (const v of t.start) w.f2dot14(v); for (const v of t.end) w.f2dot14(v); }
    });
    w.raw(serialized.bytes());
    w.pad2();
    return w.bytes();
  });

  const headerLen = 20 + (glyphCount + 1) * 4;
  const w = new W();
  w.u16(1).u16(0).u16(axes.length).u16(0).u32(headerLen).u16(glyphCount).u16(1).u32(headerLen);
  let offset = 0;
  for (const blob of blobs) { w.u32(offset); offset += blob.length; }
  w.u32(offset);
  for (const blob of blobs) w.raw(blob);
  return w.bytes();
}

/** HVAR with an implicit glyph → delta-set mapping (outer 0, inner = glyph id). */
export function buildHvar(axes: VariationAxis[], supports: Support[], advanceDeltas: number[][]): Uint8Array {
  const regions = supports.slice(1).map((s) => regionTuple(s, axes));
  const regionCount = regions.length;
  const rows = advanceDeltas.map((row) => row.map(Math.round));
  const needsWords = rows.some((row) => row.some((v) => v < -128 || v > 127));
  const wordCount = needsWords ? regionCount : 0;

  const regionList = new W();
  regionList.u16(axes.length).u16(regionCount);
  for (const r of regions) for (let a = 0; a < axes.length; a++) regionList.f2dot14(r.start[a]).f2dot14(r.peak[a]).f2dot14(r.end[a]);

  const data = new W();
  data.u16(rows.length).u16(wordCount).u16(regionCount);
  for (let i = 0; i < regionCount; i++) data.u16(i);
  for (const row of rows) for (let i = 0; i < regionCount; i++) (needsWords ? data.i16(row[i] ?? 0) : data.u8(row[i] ?? 0));

  const storeHeader = 2 + 4 + 2 + 4; // format, regionListOffset, dataCount, one data offset
  const store = new W();
  store.u16(1).u32(storeHeader).u16(1).u32(storeHeader + regionList.length);
  store.raw(regionList.bytes()).raw(data.bytes());

  const w = new W();
  w.u16(1).u16(0).u32(20).u32(0).u32(0).u32(0);
  w.raw(store.bytes());
  return w.bytes();
}

// ---------------------------------------------------------------- geometry

export interface SimplePoint { x: number; y: number }

/** Least-squares horizontal shear between two compatible point sets (Italic vs
 *  Regular), in degrees; positive leans right like FontSeru's auto-italic. */
export function estimateShearDegrees(base: SimplePoint[], slanted: SimplePoint[]): number {
  let num = 0, den = 0;
  for (let i = 0; i < base.length && i < slanted.length; i++) {
    const y = base[i].y;
    num += (slanted[i].x - base[i].x) * y;
    den += y * y;
  }
  if (den <= 0) return 0;
  return (Math.atan(num / den) * 180) / Math.PI;
}
