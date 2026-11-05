import type { Glyph } from "@/types/glyph";
import { isCombiningMark, isMarkGlyph } from "@/glyph/anchors";

/**
 * OpenType mark positioning from glyph anchors:
 *  - GPOS lookup type 4 (MarkToBase)  → feature `mark`
 *  - GPOS lookup type 6 (MarkToMark)  → feature `mkmk`
 *  - GDEF glyph classes (base = 1, mark = 3)
 *
 * Conventions: a base glyph has anchor "top"; a mark glyph has "_top" (the
 * point that lands on the base's "top") and optionally "top" so a second mark
 * can stack on it. Anchor names are free-form: every name X that has both a
 * "_X" on some mark and an "X" on some base becomes one mark class.
 */

export interface MarkLayout {
  /** Lookup subtables (type 4) — empty when no base/mark pair exists. */
  markToBase: Uint8Array[];
  /** Lookup subtables (type 6). */
  markToMark: Uint8Array[];
  /** Complete GDEF table bytes. */
  gdef: Uint8Array | null;
}

class W {
  private b: number[] = [];
  get length() { return this.b.length; }
  u16(v: number): this { this.b.push((v >> 8) & 0xff, v & 0xff); return this; }
  i16(v: number): this { return this.u16(v < 0 ? v + 0x10000 : v); }
  raw(bytes: Uint8Array): this { for (let i = 0; i < bytes.length; i++) this.b.push(bytes[i]); return this; }
  bytes(): Uint8Array { return new Uint8Array(this.b); }
}

const clamp16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));

function anchorTable(x: number, y: number): Uint8Array {
  return new W().u16(1).i16(clamp16(x)).i16(clamp16(y)).bytes();
}

function coverage(gids: number[]): Uint8Array {
  const w = new W().u16(1).u16(gids.length);
  for (const g of gids) w.u16(g);
  return w.bytes();
}

interface Entry { gid: number; anchors: Map<string, { x: number; y: number }> }

/** [classCount offsets per record] + anchor tables, offsets relative to array start. */
function recordArray(entries: Entry[], classes: string[], useAttach: boolean): Uint8Array {
  const count = entries.length;
  const headSize = 2 + count * classes.length * 2;
  const tables: Uint8Array[] = [];
  const offsets: number[] = [];
  let cursor = headSize;
  for (const e of entries) {
    for (const cls of classes) {
      const a = e.anchors.get(useAttach ? `_${cls}` : cls);
      if (!a) { offsets.push(0); continue; }
      const t = anchorTable(a.x, a.y);
      offsets.push(cursor);
      tables.push(t);
      cursor += t.length;
    }
  }
  const w = new W().u16(count);
  for (const o of offsets) w.u16(o);
  for (const t of tables) w.raw(t);
  return w.bytes();
}

function markArray(marks: Entry[], classes: string[]): Uint8Array {
  const count = marks.length;
  const headSize = 2 + count * 4;
  const tables: Uint8Array[] = [];
  const w = new W().u16(count);
  let cursor = headSize;
  for (const m of marks) {
    const ci = classes.findIndex((c) => m.anchors.has(`_${c}`));
    const a = m.anchors.get(`_${classes[ci]}`)!;
    const t = anchorTable(a.x, a.y);
    w.u16(ci).u16(cursor);
    tables.push(t);
    cursor += t.length;
  }
  for (const t of tables) w.raw(t);
  return w.bytes();
}

/** MarkBasePos / MarkMarkPos format 1 share this exact layout. */
function attachSubtable(attachers: Entry[], targets: Entry[], classes: string[]): Uint8Array {
  const cov1 = coverage(attachers.map((e) => e.gid));
  const cov2 = coverage(targets.map((e) => e.gid));
  const arr1 = markArray(attachers, classes);
  const arr2 = recordArray(targets, classes, false);
  const header = 12;
  const off1 = header;
  const off2 = off1 + cov1.length;
  const off3 = off2 + cov2.length;
  const off4 = off3 + arr1.length;
  return new W().u16(1).u16(off1).u16(off2).u16(classes.length).u16(off3).u16(off4)
    .raw(cov1).raw(cov2).raw(arr1).raw(arr2).bytes();
}

function gdefTable(classes: Map<number, number>): Uint8Array | null {
  if (!classes.size) return null;
  const sorted = [...classes.entries()].sort((a, b) => a[0] - b[0]);
  const ranges: { start: number; end: number; cls: number }[] = [];
  for (const [gid, cls] of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.cls === cls && last.end + 1 === gid) last.end = gid;
    else ranges.push({ start: gid, end: gid, cls });
  }
  const classDef = new W().u16(2).u16(ranges.length);
  for (const r of ranges) classDef.u16(r.start).u16(r.end).u16(r.cls);
  // version 1.0: glyphClassDef right after the 12-byte header; the rest absent.
  return new W().u16(1).u16(0).u16(12).u16(0).u16(0).u16(0).raw(classDef.bytes()).bytes();
}

export function buildMarkLayout(glyphs: Glyph[], gidByChar: Map<string, number>): MarkLayout | null {
  const entries: Array<Entry & { isMark: boolean; glyph: Glyph }> = [];
  for (const g of glyphs) {
    if (!g.anchors?.length) continue;
    const gid = gidByChar.get(g.char);
    if (gid == null || gid <= 0) continue;
    const anchors = new Map<string, { x: number; y: number }>();
    for (const a of g.anchors) {
      if (a?.name && Number.isFinite(a.x) && Number.isFinite(a.y)) anchors.set(a.name, { x: a.x, y: a.y });
    }
    if (!anchors.size) continue;
    entries.push({ gid, anchors, isMark: isMarkGlyph(g), glyph: g });
  }
  if (!entries.length) return null;

  const marks = entries.filter((e) => e.isMark);
  const bases = entries.filter((e) => !e.isMark);

  // classes = names X where some mark has "_X" and some base has "X".
  const baseNames = new Set<string>();
  for (const b of bases) for (const n of b.anchors.keys()) if (!n.startsWith("_")) baseNames.add(n);
  const markClassSet = new Set<string>();
  for (const m of marks) for (const n of m.anchors.keys()) if (n.startsWith("_") && baseNames.has(n.slice(1))) markClassSet.add(n.slice(1));
  const classes = [...markClassSet].sort();

  const markToBase: Uint8Array[] = [];
  const markToMark: Uint8Array[] = [];
  if (classes.length) {
    const attachers = marks.filter((m) => classes.some((c) => m.anchors.has(`_${c}`))).sort((a, b) => a.gid - b.gid);
    const baseTargets = bases.filter((b) => classes.some((c) => b.anchors.has(c))).sort((a, b) => a.gid - b.gid);
    if (attachers.length && baseTargets.length) markToBase.push(attachSubtable(attachers, baseTargets, classes));

    // mark-to-mark: marks that also expose a plain "X" anchor can carry another mark.
    const mark2 = marks.filter((m) => classes.some((c) => m.anchors.has(c))).sort((a, b) => a.gid - b.gid);
    if (attachers.length && mark2.length) markToMark.push(attachSubtable(attachers, mark2, classes));
  }

  const glyphClass = new Map<number, number>();
  for (const e of entries) glyphClass.set(e.gid, isCombiningMark(e.glyph.unicode) ? 3 : 1);
  // Combining marks without anchors still need the mark class so engines zero their advance.
  for (const g of glyphs) {
    if (!isCombiningMark(g.unicode)) continue;
    const gid = gidByChar.get(g.char);
    if (gid != null && gid > 0) glyphClass.set(gid, 3);
  }

  // No attachable pair → nothing to position, so don't touch the font at all.
  if (!markToBase.length && !markToMark.length) return null;
  return { markToBase, markToMark, gdef: gdefTable(glyphClass) };
}
