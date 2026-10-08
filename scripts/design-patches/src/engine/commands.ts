import { getS, useStore } from '../store/store';
import type { Doc, SceneNode, TextNode, ImageAsset } from '../model/types';
import { runBoolean, canBoolean, separateCompound, BOOL_LABEL, type BoolOp } from './boolean';
import { toast, setJob } from '../ui/toast';
import { instancesOf, detachInstanceIn, makeMask, releaseMask, makeComponent, placeSvgText } from '../lib/place';
import { announceCopy, externalSvgIfNewer, hasExternalClip } from '../lib/seruBridge';
import { relayoutText } from './text';
import { offerReplace } from '../tools/replaceOffer';
import { convertSelectedTexts, textsIn } from '../lib/textcurves';
import {
  cloneTree,
  convertToCurves,
  groupNodes,
  pasteTrees,
  bumpFrameNames,
  refreshAllGroups,
  removeNodes,
  reorder,
  topLevel,
  ungroup,
  flatOrder,
  descendants,
} from '../model/doc';
import { isEditable, dropSelected } from './editpts';
import { unionBox, worldAABB, normalizePath, hasGeometry, mapNodePoints, nodeMatrix, applyM, cmdsToAnchors, shapeCmds } from './geometry';
import { translateTree, rotateNodes, scaleLeaf, groupsIn } from './transform';
import { worldPivot, isCustomPivot, makePivot, withPivot } from './pivot';
import { expandStrokeNode } from './stroke';
import { insertNode, childrenOf } from '../model/doc';
import { frameAt } from './hit';
import type { Pt, Box } from './geometry';
import { contentAABB } from '../lib/export';

let clipboard: SceneNode[][] = [];
/** frame asal salinan (posisi dunia): dipakai agar tempel ke frame lain mempertahankan posisi x,y relatif terhadap frame */
let clipFrame: { id: string; x: number; y: number } | null = null;
const CLIP_META = 'designseru:clipmeta';

/** frame terdekat yang memuat node (dari rantai induk), atau null bila berada di kanvas bebas */
function frameOf(doc: Doc, id: string): SceneNode | null {
  for (let p = doc.nodes[id]?.parentId; p; p = doc.nodes[p]?.parentId) {
    const n = doc.nodes[p];
    if (n?.type === 'frame') return n;
  }
  return null;
}

const sel = () => topLevel(getS().doc, getS().selection);

export function deleteSelection() {
  const s = getS();
  if (s.editPathId && s.selAnchors.length) return deleteAnchors();
  if (!s.selection.length) return;
  let detached = 0;
  s.mutate('Hapus', (d) => {
    // master komponen dihapus → instance-nya dijadikan salinan biasa dulu
    const gone = new Set(topLevel(d, s.selection).flatMap((id) => [id, ...descendants(d, id)]));
    for (const id of gone) {
      const n = d.nodes[id];
      if ((n?.type === 'group' || n?.type === 'frame') && n.isComponent)
        for (const inst of instancesOf(d, id)) if (!gone.has(inst)) detachInstanceIn(d, inst) && detached++;
    }
    removeNodes(d, s.selection);
  });
  s.set({ selection: [], editPathId: null });
  if (detached) toast(`${detached} instance dilepas dari komponen yang dihapus`);
}

export function deleteAnchors() {
  const s = getS();
  const id = s.editPathId!;
  const n = s.doc.nodes[id];
  if (!n || !isEditable(n)) return;
  const next = dropSelected(n, s.selAnchors);
  s.mutate('Hapus titik', (d) => {
    if (!next) removeNodes(d, [id]);
    else d.nodes[id] = normalizePath(next);
    refreshAllGroups(d, [id]);
  });
  const still = !!getS().doc.nodes[id];
  s.set({ selAnchors: [], editContour: 0, editPathId: still ? id : null, selection: still ? [id] : [] });
}

/** data gambar yang dipakai objek di clipboard: gambar disimpan per halaman (doc.images), jadi tanpa ini objek gambar yang
 *  ditempel di halaman lain tampil kosong (node ada di daftar layer, kanvasnya tidak menggambar apa-apa) */
let clipImages: Record<string, ImageAsset> = {};
const imageRefs = (n: SceneNode): string[] => {
  const out: string[] = [];
  const r = n as { imageId?: string; crop?: { imageId?: string } };
  if (r.imageId) out.push(r.imageId);
  if (r.crop?.imageId) out.push(r.crop.imageId);
  return out;
};
/** lengkapi doc.images tujuan dengan gambar dari clipboard yang belum ada */
function withClipImages(d: Doc, nodes: SceneNode[][]) {
  let add: Record<string, ImageAsset> | null = null;
  for (const list of nodes)
    for (const n of list)
      for (const id of imageRefs(n))
        if (!d.images?.[id] && clipImages[id]) (add ??= {})[id] = clipImages[id];
  if (add) d.images = { ...(d.images ?? {}), ...add };
}

export function copy() {
  const { doc } = getS();
  clipboard = sel().map((id) => {
    const all = [id, ...descendants(doc, id)];
    return all.map((x) => structuredClone(doc.nodes[x]));
  });
  clipImages = {};
  for (const list of clipboard) for (const n of list) for (const id of imageRefs(n)) if (doc.images?.[id]) clipImages[id] = doc.images[id];
  copiedIds = sel();
  const fr = copiedIds.length ? frameOf(doc, copiedIds[0]) : null;
  clipFrame = fr ? { id: fr.id, x: fr.x, y: fr.y } : null;
  offerReplace(true);
  announceCopy(doc, copiedIds); // SVG ke clipboard sistem + ke tab Font
  try {
    localStorage.setItem('designseru:clip', JSON.stringify(clipboard));
    localStorage.setItem(CLIP_META, JSON.stringify(clipFrame));
  } catch {
    /* abaikan */
  }
}

/** id yang baru disalin (untuk tawaran "tempel untuk mengganti") */
let copiedIds: string[] = [];
export const lastCopiedIds = () => copiedIds;

export function cut() {
  copy();
  deleteSelection();
}

function clipSource(): SceneNode[][] {
  if (clipboard.length) return clipboard;
  try {
    const raw = localStorage.getItem('designseru:clip');
    if (raw) return JSON.parse(raw);
  } catch {
    /* abaikan */
  }
  return [];
}

function clipOrigin(): { id: string; x: number; y: number } | null {
  if (clipboard.length) return clipFrame;
  try {
    return JSON.parse(localStorage.getItem(CLIP_META) ?? 'null');
  } catch {
    return null;
  }
}

/** frame tujuan tempel: frame yang dipilih, atau frame yang memuat objek terpilih */
function pasteTarget(doc: Doc, selection: string[]): string | null {
  if (selection.length !== 1) return null;
  const n = doc.nodes[selection[0]];
  if (!n) return null;
  return n.type === 'frame' ? n.id : (frameOf(doc, n.id)?.id ?? null);
}

/**
 * Tempel. Bila tujuannya sebuah frame (frame/objek di dalamnya sedang dipilih): posisi x,y RELATIF terhadap frame dipertahankan,
 * jadi menyalin dari frame A lalu menempel di frame B jatuh di titik yang sama di dalam frame B.
 */
export function paste(offset = 16) {
  // salinan terbaru berasal dari tab Font → tempel sebagai SVG vektor
  const ext = externalSvgIfNewer();
  if (ext) {
    try {
      placeSvgText(ext, 'SVG dari Font');
    } catch {
      /* SVG tidak valid */
    }
    return;
  }
  const src = clipSource();
  if (!src.length) return;
  const s = getS();
  const target = pasteTarget(s.doc, s.selection);
  const origin = clipOrigin();
  const tf = target ? s.doc.nodes[target] : null;
  // dx,dy: selisih posisi frame tujuan terhadap frame asal; frame yang sama → geser sedikit seperti biasa
  let dx = offset,
    dy = offset;
  if (tf) {
    if (origin && origin.id !== tf.id) (dx = tf.x - origin.x), (dy = tf.y - origin.y);
    else if (origin) (dx = offset), (dy = offset);
    else (dx = 0), (dy = 0);
  }
  offerReplace(false);
  let ids: string[] = [];
  s.mutate('Tempel', (d) => {
    withClipImages(d, src);
    const trees = src.map((nodes) => {
      const rec: Record<string, SceneNode> = {};
      nodes.forEach((n) => (rec[n.id] = n));
      return cloneTree(rec, nodes[0].id, dx, dy);
    });
    ids = pasteTrees(d, trees, target);
    bumpFrameNames(d, ids);
  });
  s.set({ selection: ids });
}

/**
 * Tempel di sini: isi clipboard ditaruh tepat di titik dunia `at` (pusat kotak pembatasnya berada di titik itu),
 * masuk ke frame yang berada di titik tersebut.
 */
export function pasteAt(at: Pt) {
  const ext = externalSvgIfNewer();
  if (ext) {
    try {
      placeSvgText(ext, 'SVG dari Font', { at });
    } catch {
      /* SVG tidak valid */
    }
    return;
  }
  const src = clipSource();
  if (!src.length) return;
  const s = getS();
  const box = unionBox(src.map((nodes) => worldAABB(nodes[0])));
  if (!box) return;
  const dx = at.x - (box.x + box.w / 2),
    dy = at.y - (box.y + box.h / 2);
  const parent = frameAt(s.doc, at);
  offerReplace(false);
  let ids: string[] = [];
  s.mutate('Tempel di sini', (d) => {
    withClipImages(d, src);
    const trees = src.map((nodes) => {
      const rec: Record<string, SceneNode> = {};
      nodes.forEach((n) => (rec[n.id] = n));
      return cloneTree(rec, nodes[0].id, dx, dy);
    });
    ids = pasteTrees(d, trees, parent);
    bumpFrameNames(d, ids);
  });
  s.set({ selection: ids });
}

/** apakah ada sesuatu yang bisa ditempel */
export const hasClipboard = () => clipSource().length > 0 || hasExternalClip();

/**
 * Tempel untuk mengganti: objek di clipboard menggantikan objek terpilih — di induk & urutan tumpukan yang sama,
 * berpusat di posisi objek yang diganti.
 */
export function pasteReplace() {
  const src = clipSource();
  const s = getS();
  const targets = sel().filter((id) => !s.doc.nodes[id]?.locked);
  if (!src.length) return toast('Salin objek dulu, lalu pilih objek yang ingin diganti', 'err');
  if (!targets.length) return toast('Pilih objek yang ingin diganti', 'err');
  const roots = src.map((nodes) => nodes[0]);
  const srcBox = unionBox(roots.map((n) => worldAABB(n)))!;
  const sc = { x: srcBox.x + srcBox.w / 2, y: srcBox.y + srcBox.h / 2 };
  const out: string[] = [];
  s.mutate('Tempel untuk mengganti', (d) => {
    withClipImages(d, src);
    for (const tid of targets) {
      const t = d.nodes[tid];
      if (!t) continue;
      const tb = worldAABB(t);
      const dx = tb.x + tb.w / 2 - sc.x,
        dy = tb.y + tb.h / 2 - sc.y;
      const parentId = t.parentId;
      const arr = () => (parentId ? (d.nodes[parentId] as { children: string[] }).children : d.root);
      const at = arr().indexOf(tid);
      const trees = src.map((nodes) => {
        const rec: Record<string, SceneNode> = {};
        nodes.forEach((n) => (rec[n.id] = n));
        return cloneTree(rec, nodes[0].id, dx, dy);
      });
      const ids = pasteTrees(d, trees, parentId);
      // pindahkan ke posisi objek lama
      const list = arr();
      for (const id of ids) list.splice(list.indexOf(id), 1);
      list.splice(Math.max(0, list.indexOf(tid)), 0, ...ids);
      void at;
      removeNodes(d, [tid]);
      out.push(...ids);
    }
  });
  offerReplace(false);
  s.set({ selection: out });
}

/**
 * Duplikat ala Affinity: salinan pertama tepat di atas aslinya (posisi X/Y sama).
 * Bila salinan itu digeser/diputar/diskala lalu Duplikat dipanggil lagi, salinan berikutnya
 * mengulang transform yang sama (transform ulang) — lihat repeatPlan().
 */
let lastDup: { src: string[]; out: string[] } | null = null;

export function rememberDup(src: string[], out: string[]) {
  lastDup = { src, out };
}

const normDeg = (v: number) => {
  let r = v % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return Math.abs(r) < 1e-6 ? 0 : r;
};

/** daun transformasi (bukan grup) dari satu akar, urutan DFS — urutan sama untuk akar & salinannya */
function leafIds(doc: Doc, root: string): string[] {
  return [root, ...descendants(doc, root)].filter((id) => doc.nodes[id] && doc.nodes[id].type !== 'group');
}

/** langkah transform satu daun (asli → salinan) yang akan diulang pada salinan berikutnya */
interface RepeatStep {
  /** selisih rotasi (derajat) */
  dRot: number;
  /** rasio lebar & tinggi lokal */
  kw: number;
  kh: number;
  /** rotasi daun asli (sumbu skala lokal) */
  th0: number;
  /** pusat daun asli & pusat salinannya (dunia) */
  c0: Pt;
  c1: Pt;
}
type RepeatPlan = { kind: 'move'; dx: number; dy: number } | { kind: 'leaf'; steps: RepeatStep[] };

function lastDupMatches(doc: Doc, ids: string[]): boolean {
  const L = lastDup;
  if (!L || L.out.length !== ids.length || !ids.every((id) => L.out.includes(id))) return false;
  return [...L.src, ...L.out].every((id) => doc.nodes[id]);
}

/**
 * Transform yang dipakai asli → salinan, dibaca dari objeknya: geser, putar (mengelilingi sumbu mana pun),
 * dan skala. Salinan berikutnya = salinan terakhir ditransform dengan peta yang sama
 * (pusat' = pusat + L·(pusat − pusat asli); rotasi & ukuran dikalikan/ditambah sama), sehingga hasilnya
 * berputar mengelilingi sumbu yang sama, atau terus mengecil/membesar dengan rasio yang sama.
 */
function repeatPlan(doc: Doc, id: string): RepeatPlan {
  const none: RepeatPlan = { kind: 'move', dx: 0, dy: 0 };
  const L = lastDup;
  if (!L) return none;
  const k = L.out.indexOf(id);
  const srcId = k >= 0 ? L.src[k] : undefined;
  if (!srcId || !doc.nodes[srcId] || !doc.nodes[id]) return none;
  const a = leafIds(doc, srcId),
    b = leafIds(doc, id);
  const sameShape = a.length === b.length && a.every((x, i) => doc.nodes[x].type === doc.nodes[b[i]].type);
  if (!sameShape || b.some((x) => doc.nodes[x].type === 'frame')) {
    // frame / struktur berbeda: ulangi geseran saja
    const A = worldAABB(doc.nodes[srcId]),
      B = worldAABB(doc.nodes[id]);
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return { kind: 'move', dx: r(B.x - A.x), dy: r(B.y - A.y) };
  }
  const near1 = (v: number) => (Math.abs(v - 1) < 1e-9 ? 1 : v);
  const steps = a.map((x, i): RepeatStep => {
    const o0 = doc.nodes[x],
      o1 = doc.nodes[b[i]];
    return {
      dRot: normDeg((o1.rotation || 0) - (o0.rotation || 0)),
      kw: o0.w > 1e-6 ? near1(o1.w / o0.w) : 1,
      kh: o0.h > 1e-6 ? near1(o1.h / o0.h) : 1,
      th0: o0.rotation || 0,
      c0: { x: o0.x + o0.w / 2, y: o0.y + o0.h / 2 },
      c1: { x: o1.x + o1.w / 2, y: o1.y + o1.h / 2 },
    };
  });
  return { kind: 'leaf', steps };
}

/** terapkan langkah ulang pada salinan baru (salinan persis dari objek terakhir, belum digeser) */
function applyRepeat(d: Doc, newRoot: string, plan: Extract<RepeatPlan, { kind: 'leaf' }>) {
  const leaves = leafIds(d, newRoot);
  if (leaves.length !== plan.steps.length) return;
  const rad = Math.PI / 180;
  leaves.forEach((id, i) => {
    const st = plan.steps[i];
    const n0 = d.nodes[id];
    // L = R(θ0+Δθ) · diag(kw,kh) · R(−θ0)
    const A = st.th0 * rad,
      B = (st.th0 + st.dRot) * rad;
    const ca = Math.cos(A),
      sa = Math.sin(A),
      cb = Math.cos(B),
      sb = Math.sin(B);
    const L00 = st.kw * cb * ca + st.kh * sb * sa,
      L01 = st.kw * cb * sa - st.kh * sb * ca,
      L10 = st.kw * sb * ca - st.kh * cb * sa,
      L11 = st.kw * sb * sa + st.kh * cb * ca;
    const vx = st.c1.x - st.c0.x,
      vy = st.c1.y - st.c0.y;
    const r4 = (v: number) => Math.round(v * 10000) / 10000;
    const c2 = { x: r4(st.c1.x + L00 * vx + L01 * vy), y: r4(st.c1.y + L10 * vx + L11 * vy) };
    let n: SceneNode = st.kw !== 1 || st.kh !== 1 ? scaleLeaf(n0, st.kw, st.kh) : { ...n0 };
    n = { ...n, rotation: Math.round(normDeg((n0.rotation || 0) + st.dRot) * 100) / 100, x: c2.x - n.w / 2, y: c2.y - n.h / 2 } as SceneNode;
    d.nodes[id] = n;
  });
  // grup di salinan ikut berputar sebesar langkahnya (sama seperti rotateNodes), supaya kotaknya tetap sejajar isinya
  const dRot = plan.steps[0]?.dRot ?? 0;
  if (dRot) for (const g of groupsIn(d, [newRoot])) d.nodes[g] = { ...d.nodes[g], rotation: Math.round(normDeg((d.nodes[g].rotation || 0) + dRot) * 100) / 100 };
  refreshAllGroups(d, leaves);
}

export function duplicate() {
  const s = getS();
  const ids = sel();
  if (!ids.length) return;
  const doc0 = s.doc;
  const repeat = lastDupMatches(doc0, ids);
  // sumbu kustom tetap di titik dunia yang sama pada salinan (orbit salinan berikutnya mengelilingi sumbu yang sama)
  const pw = isCustomPivot(doc0, ids, s.pivot) ? worldPivot(doc0, ids, s.pivot) : null;
  const out: string[] = [];
  s.mutate('Duplikat', (d) => {
    for (const id of ids) {
      const n = d.nodes[id];
      const plan: RepeatPlan = repeat ? repeatPlan(d, id) : { kind: 'move', dx: 0, dy: 0 };
      const tree = plan.kind === 'move' ? cloneTree(d.nodes, id, plan.dx, plan.dy) : cloneTree(d.nodes, id);
      const [root] = pasteTrees(d, [tree], n.parentId);
      if (plan.kind === 'leaf') applyRepeat(d, root, plan);
      out.push(root);
    }
    bumpFrameNames(d, out);
  });
  rememberDup(ids, out);
  s.set({ selection: out, pivot: pw ? withPivot(getS().pivot, out, makePivot(getS().doc, out, pw)) : getS().pivot });
}

export function group() {
  const s = getS();
  if (sel().length < 1) return;
  let gid: string | null = null;
  s.mutate('Grupkan', (d) => (gid = groupNodes(d, s.selection)));
  if (gid) s.set({ selection: [gid] });
}

export function ungroupSel() {
  const s = getS();
  const out: string[] = [];
  s.mutate('Pisah grup', (d) => {
    for (const id of sel()) {
      if (d.nodes[id]?.type === 'group') out.push(...ungroup(d, id));
      else out.push(id);
    }
  });
  s.set({ selection: out });
}

export function arrange(how: 'front' | 'back' | 'forward' | 'backward') {
  const s = getS();
  if (!s.selection.length) return;
  s.mutate('Urutkan', (d) => reorder(d, s.selection, how));
}

export function selectAll() {
  const s = getS();
  const parent = s.selection.length ? s.doc.nodes[s.selection[0]]?.parentId ?? null : null;
  const list = parent ? (s.doc.nodes[parent] as { children: string[] }).children : s.doc.root;
  s.select(list.filter((id) => s.doc.nodes[id].visible && !s.doc.nodes[id].locked));
}

export function nudge(dx: number, dy: number) {
  const s = getS();
  const ids = sel().filter((id) => !s.doc.nodes[id].locked);
  if (!ids.length) return;
  const orig = s.doc;
  s.mutate(
    'Geser',
    (d) => {
      ids.forEach((id) => translateTree(d, orig, id, dx, dy));
      refreshAllGroups(d, ids);
    },
    'nudge',
  );
}

/** bentuk parametris → path yang bisa diedit node-nya; teks (juga di dalam grup/frame terpilih) → kurva majemuk dari kontur glyph font */
export function toCurves() {
  const s = getS();
  const ids = sel();
  const shapeIds = ids.filter((id) => {
    const t = s.doc.nodes[id]?.type;
    return !!t && !['path', 'group', 'frame', 'compound', 'text', 'image', 'instance'].includes(t);
  });
  const hasText = textsIn(ids, true).length > 0;
  if (!shapeIds.length && !hasText) {
    if (ids.length) toast('Objek ini sudah berupa kurva atau tidak bisa dikonversi', 'err');
    return;
  }
  if (shapeIds.length) {
    s.mutate('Konversi ke kurva', (d) => {
      for (const id of shapeIds) convertToCurves(d, id);
    });
    if (ids.length === 1) s.set({ tool: 'node', editPathId: ids[0], selAnchors: [] });
  }
  if (hasText) void convertSelectedTexts(true, ids);
}

/** node bergaris (termasuk di dalam grup) yang bisa di-expand */
function strokedIn(ids: string[]): string[] {
  const s = getS();
  const out: string[] = [];
  for (const id of ids) {
    for (const x of [id, ...descendants(s.doc, id)]) {
      const n = s.doc.nodes[x];
      if (n && !['group', 'frame', 'image', 'instance', 'text'].includes(n.type) && n.stroke.enabled && n.stroke.width > 0) out.push(x);
    }
  }
  return out;
}
export const hasStroke = (ids: string[]) => strokedIn(ids).length > 0 || textsIn(ids, false).some((t) => t.stroke.enabled && t.stroke.width > 0);

/** Expand stroke: garis tepi dijadikan bentuk berisi (fill). Bila objek juga punya isi, keduanya dikelompokkan. */
export async function expandStroke() {
  const s0 = getS();
  const ids = sel();
  if (!ids.length) return;
  // teks ber-stroke: jadikan kurva dulu agar garisnya punya bentuk
  const texts = textsIn(ids, false).filter((t) => t.stroke.enabled && t.stroke.width > 0);
  if (texts.length) await convertSelectedTexts(true, texts.map((t) => t.id));
  const targets = strokedIn(ids);
  if (!targets.length) {
    toast('Pilih objek yang punya garis (stroke) dulu', 'err');
    return;
  }
  const made: string[] = [];
  let failed = 0;
  // bentuk rumit (teks, banyak titik) bisa memakan beberapa detik: beri indikator dulu
  setJob({ text: 'Mengubah garis jadi bentuk…' });
  await new Promise((r) => setTimeout(r, 30));
  try {
    s0.mutate('Expand stroke', (d) => {
      for (const id of targets) {
        const n = d.nodes[id];
        if (!n) continue;
        let out: SceneNode | null = null;
        try {
          out = expandStrokeNode(n);
        } catch (e) {
          console.error('expand stroke', e);
        }
        if (!out) {
          failed++;
          continue;
        }
        const parent = n.parentId;
        const idx = childrenOf(d, parent).indexOf(id);
        const hasFill = n.fill.enabled && n.type !== 'line' && !(n.type === 'path' && (n.brush || n.stroke.profile !== 'uniform' && !n.closed)) && n.fill.opacity > 0;
        Object.assign(out, { locked: n.locked, visible: n.visible });
        if (hasFill) {
          // isi tetap; garis menjadi bentuk sendiri di atasnya; keduanya dikelompokkan
          d.nodes[id] = { ...n, stroke: { ...n.stroke, enabled: false } } as SceneNode;
          insertNode(d, out, parent, idx + 1);
          const g = groupNodes(d, [id, out.id]);
          if (g) {
            d.nodes[g] = { ...d.nodes[g], name: n.name || 'Bentuk' } as SceneNode;
            made.push(g);
          }
        } else {
          // hanya garis: bentuk hasil menggantikan objek (efek bayangan/fx ikut pindah)
          Object.assign(out, { shadows: n.shadows, fx: n.fx, fade: n.fade });
          removeNodes(d, [id]);
          insertNode(d, out, parent, idx);
          made.push(out.id);
        }
      }
    });
  } finally {
    setJob(null);
  }
  if (made.length) s0.set({ selection: made });
  if (failed) toast(`${failed} objek tidak bisa di-expand`, 'err');
  else toast(made.length > 1 ? `${made.length} garis diubah jadi bentuk` : 'Garis diubah jadi bentuk', 'ok');
}

export function toggleLock() {
  const s = getS();
  const ids = sel();
  if (!ids.length) return;
  const lock = !s.doc.nodes[ids[0]].locked;
  s.updateNodes(ids, (n) => ({ ...n, locked: lock }), lock ? 'Kunci' : 'Buka kunci');
  if (lock) s.select([]);
}
export function toggleHide() {
  const s = getS();
  const ids = sel();
  if (!ids.length) return;
  const vis = !s.doc.nodes[ids[0]].visible;
  s.updateNodes(ids, (n) => ({ ...n, visible: vis }), vis ? 'Tampilkan' : 'Sembunyikan');
}

export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export function align(kind: AlignKind) {
  const s = getS();
  const ids = sel();
  if (!ids.length) return;
  const orig = s.doc;
  let ref;
  if (ids.length === 1) {
    const p = orig.nodes[ids[0]].parentId;
    if (!p) return;
    ref = worldAABB(orig.nodes[p]);
  } else ref = unionBox(ids.map((id) => worldAABB(orig.nodes[id])))!;
  s.mutate('Ratakan', (d) => {
    for (const id of ids) {
      const b = worldAABB(orig.nodes[id]);
      let dx = 0,
        dy = 0;
      if (kind === 'left') dx = ref.x - b.x;
      if (kind === 'right') dx = ref.x + ref.w - (b.x + b.w);
      if (kind === 'hcenter') dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
      if (kind === 'top') dy = ref.y - b.y;
      if (kind === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
      if (kind === 'vcenter') dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
      translateTree(d, orig, id, dx, dy);
    }
    refreshAllGroups(d, ids);
  });
}

export function distribute(axis: 'h' | 'v') {
  const s = getS();
  const ids = sel();
  if (ids.length < 3) return;
  const orig = s.doc;
  const items = ids.map((id) => ({ id, b: worldAABB(orig.nodes[id]) }));
  items.sort((a, b) => (axis === 'h' ? a.b.x - b.b.x : a.b.y - b.b.y));
  const first = items[0].b,
    last = items[items.length - 1].b;
  const total = items.reduce((acc, i) => acc + (axis === 'h' ? i.b.w : i.b.h), 0);
  const span = axis === 'h' ? last.x + last.w - first.x : last.y + last.h - first.y;
  const gap = (span - total) / (items.length - 1);
  s.mutate('Distribusi', (d) => {
    let cur = axis === 'h' ? first.x : first.y;
    for (const it of items) {
      const delta = cur - (axis === 'h' ? it.b.x : it.b.y);
      translateTree(d, orig, it.id, axis === 'h' ? delta : 0, axis === 'v' ? delta : 0);
      cur += (axis === 'h' ? it.b.w : it.b.h) + gap;
    }
    refreshAllGroups(d, ids);
  });
}

/** jarak antar objek terpilih menurut sumbu: angka bila seragam, 'mixed' bila beda, null bila < 2 objek */
type GapItem = { id: string; b: { x: number; y: number; w: number; h: number } };
/** kelompokkan objek menjadi baris (urut atas → bawah), tiap baris urut kiri → kanan, seperti deteksi grid Figma */
function gridRows(items: GapItem[]): GapItem[][] {
  const byCy = [...items].sort((p, q) => p.b.y + p.b.h / 2 - (q.b.y + q.b.h / 2));
  const rows: { top: number; bottom: number; items: GapItem[] }[] = [];
  for (const it of byCy) {
    const cy = it.b.y + it.b.h / 2;
    const r = rows[rows.length - 1];
    if (r && cy <= r.bottom) {
      r.items.push(it);
      r.top = Math.min(r.top, it.b.y);
      r.bottom = Math.max(r.bottom, it.b.y + it.b.h);
    } else rows.push({ top: it.b.y, bottom: it.b.y + it.b.h, items: [it] });
  }
  return rows.map((r) => r.items.sort((p, q) => p.b.x - q.b.x));
}
const isGrid = (rows: GapItem[][]) => rows.length > 1 && rows.some((r) => r.length > 1);
const uniform = (gaps: number[]) => (!gaps.length ? null : gaps.every((g) => Math.abs(g - gaps[0]) < 0.05) ? gaps[0] : 'mixed');

/** jarak antar objek per sumbu. Seleksi berbentuk grid: jarak dalam baris (h) dan antar baris (v). */
function gapsOf(items: GapItem[], axis: 'h' | 'v'): number[] {
  const rows = gridRows(items);
  if (isGrid(rows)) {
    if (axis === 'h') return rows.flatMap((r) => r.slice(1).map((it, i) => it.b.x - (r[i].b.x + r[i].b.w)));
    const span = rows.map((r) => ({ top: Math.min(...r.map((i) => i.b.y)), bottom: Math.max(...r.map((i) => i.b.y + i.b.h)) }));
    return span.slice(1).map((r, i) => r.top - span[i].bottom);
  }
  const sorted = [...items].sort((p, q) => (axis === 'h' ? p.b.x - q.b.x : p.b.y - q.b.y));
  return sorted.slice(1).map((q, i) => (axis === 'h' ? q.b.x - (sorted[i].b.x + sorted[i].b.w) : q.b.y - (sorted[i].b.y + sorted[i].b.h)));
}

export function currentGap(doc: Doc, ids: string[], axis: 'h' | 'v'): number | 'mixed' | null {
  ids = ids.filter((id) => doc.nodes[id]); // seleksi bisa tertinggal satu render dari dokumen
  if (ids.length < 2) return null;
  return uniform(gapsOf(ids.map((id) => ({ id, b: worldAABB(doc.nodes[id]) })), axis));
}

/**
 * Atur jarak antar objek menjadi persis `gap`, seperti Figma.
 * - Seleksi berbentuk grid (beberapa baris & kolom): dirapikan menjadi grid, kolom sejajar kiri, baris sejajar atas;
 *   sumbu yang diubah memakai `gap`, sumbu lain mempertahankan jaraknya (rata-rata bila belum seragam).
 * - Selain itu: diratakan berurutan di satu sumbu; objek pertama (kiri/atas) tetap di tempat.
 */
export function distributeGap(axis: 'h' | 'v', gap: number) {
  const s = getS();
  const orig = s.doc;
  const ids = sel().filter((id) => orig.nodes[id]);
  if (ids.length < 2 || !isFinite(gap)) return;
  const items: GapItem[] = ids.map((id) => ({ id, b: worldAABB(orig.nodes[id]) }));
  const rows = gridRows(items);
  const moves: { id: string; dx: number; dy: number }[] = [];
  if (isGrid(rows)) {
    const keep = (ax: 'h' | 'v') => {
      const g = gapsOf(items, ax);
      const u = uniform(g);
      return typeof u === 'number' ? u : Math.max(0, Math.round(g.reduce((a, b) => a + b, 0) / g.length));
    };
    const gh = axis === 'h' ? gap : keep('h');
    const gv = axis === 'v' ? gap : keep('v');
    const cols = Math.max(...rows.map((r) => r.length));
    const colW = Array.from({ length: cols }, (_, c) => Math.max(0, ...rows.map((r) => r[c]?.b.w ?? 0)));
    const rowH = rows.map((r) => Math.max(...r.map((i) => i.b.h)));
    const x0 = Math.min(...items.map((i) => i.b.x));
    const y0 = Math.min(...items.map((i) => i.b.y));
    let y = y0;
    rows.forEach((r, ri) => {
      let x = x0;
      r.forEach((it, c) => {
        moves.push({ id: it.id, dx: x - it.b.x, dy: y - it.b.y });
        x += colW[c] + gh;
      });
      y += rowH[ri] + gv;
    });
  } else {
    const sorted = [...items].sort((a, b) => (axis === 'h' ? a.b.x - b.b.x : a.b.y - b.b.y));
    let cur = axis === 'h' ? sorted[0].b.x : sorted[0].b.y;
    for (const it of sorted) {
      const delta = cur - (axis === 'h' ? it.b.x : it.b.y);
      moves.push({ id: it.id, dx: axis === 'h' ? delta : 0, dy: axis === 'v' ? delta : 0 });
      cur += (axis === 'h' ? it.b.w : it.b.h) + gap;
    }
  }
  s.mutate(
    'Atur jarak',
    (d) => {
      for (const m of moves) if (Math.abs(m.dx) > 1e-6 || Math.abs(m.dy) > 1e-6) translateTree(d, orig, m.id, m.dx, m.dy);
      refreshAllGroups(d, ids);
    },
    'gap-' + axis,
  );
}

/** daun yang ikut ditransformasi: grup & frame diurai ke isinya */
function leafTargets(doc: Doc, ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n || n.locked) continue;
    if (n.type === 'group' || n.type === 'frame') out.push(...descendants(doc, id).filter((c) => doc.nodes[c].type !== 'group' && !doc.nodes[c].locked));
    else out.push(id);
  }
  return [...new Set(out)];
}

const normRot = (r: number) => {
  let v = r % 360;
  if (v > 180) v -= 360;
  if (v <= -180) v += 360;
  return Math.round(v * 100) / 100;
};

/**
 * Balik (cermin) seleksi sebagai satu kesatuan, seperti Affinity:
 * posisi dicerminkan terhadap pusat seleksi, geometri tiap objek dicerminkan,
 * rotasi dibalik. Frame yang dipilih: isinya dibalik di dalam frame.
 */
export function flip(axis: 'h' | 'v') {
  const s = getS();
  const top = sel().filter((id) => !s.doc.nodes[id].locked);
  if (!top.length) return;
  const orig = s.doc;
  const box = unionBox(top.map((id) => worldAABB(orig.nodes[id])))!;
  const cx = box.x + box.w / 2,
    cy = box.y + box.h / 2;
  const leaves = leafTargets(orig, top);
  if (!leaves.length) return;
  s.mutate(axis === 'h' ? 'Balik horizontal' : 'Balik vertikal', (d) => {
    for (const id of leaves) {
      const n = orig.nodes[id];
      const ncx = n.x + n.w / 2,
        ncy = n.y + n.h / 2;
      const tx = axis === 'h' ? 2 * cx - ncx : ncx,
        ty = axis === 'v' ? 2 * cy - ncy : ncy;
      let out: SceneNode = { ...n, x: tx - n.w / 2, y: ty - n.h / 2, ...(n.lin ? { lin: [n.lin[0], -n.lin[1], -n.lin[2], n.lin[3]] as [number, number, number, number] } : {}) } as SceneNode;
      const rot = n.type === 'frame' ? n.rotation : normRot(-n.rotation);
      if (hasGeometry(n) && n.type !== 'text') {
        out = mapNodePoints(out, (pts) =>
          pts.map((p) =>
            axis === 'h'
              ? { ...p, x: n.w - p.x, ix: n.w - p.ix, ox: n.w - p.ox }
              : { ...p, y: n.h - p.y, iy: n.h - p.iy, oy: n.h - p.oy },
          ),
        );
        if (out.type === 'path' && out.brush) out = { ...out, brush: { ...out.brush, widths: [...out.brush.widths] } };
        out = { ...out, rotation: rot } as SceneNode;
      } else if (n.type === 'text' && n.onPath) {
        out = mapNodePoints(out, (pts) =>
          pts.map((p) =>
            axis === 'h'
              ? { ...p, x: n.w - p.x, ix: n.w - p.ix, ox: n.w - p.ox }
              : { ...p, y: n.h - p.y, iy: n.h - p.iy, oy: n.h - p.oy },
          ),
        );
        out = { ...out, rotation: rot } as SceneNode;
      } else if (n.type === 'rect') {
        const [tl, tr, br, bl] = n.radius;
        out = { ...out, rotation: rot, radius: axis === 'h' ? [tr, tl, bl, br] : [bl, br, tr, tl] } as SceneNode;
      } else if (n.type === 'polygon' || n.type === 'star') {
        // simetris terhadap sumbu tegak lokal: balik vertikal = putar 180°
        out = { ...out, rotation: axis === 'h' ? rot : normRot(rot + 180) } as SceneNode;
      } else if (n.type === 'image') {
        out = { ...out, rotation: rot, ...(axis === 'h' ? { flipX: !n.flipX } : { flipY: !n.flipY }) } as SceneNode;
      } else if (n.type !== 'frame') {
        // teks, elips, instance: posisi & rotasi dicerminkan (isi tetap terbaca)
        out = { ...out, rotation: rot } as SceneNode;
      }
      d.nodes[id] = out;
    }
    // kerangka grup ikut tercermin: sudutnya dibalik
    for (const g of groupsIn(orig, top)) d.nodes[g] = { ...d.nodes[g], rotation: normRot(-orig.nodes[g].rotation) };
    refreshAllGroups(d, leaves);
  });
}

/** putar seleksi sekian derajat terhadap pusat seleksi */
export function rotateBy(deg: number) {
  const s = getS();
  const ids = sel().filter((id) => !s.doc.nodes[id].locked && s.doc.nodes[id].type !== 'frame');
  if (!ids.length) {
    if (sel().some((id) => s.doc.nodes[id].type === 'frame')) toast('Frame tidak diputar. Tukar lebar & tinggi di panel Properti untuk mengganti orientasi.');
    return;
  }
  const orig = s.doc;
  const b = unionBox(ids.map((id) => worldAABB(orig.nodes[id])))!;
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  s.mutate(`Putar ${deg > 0 ? '+' : ''}${deg}°`, (d) => rotateNodes(d, orig, ids, c, deg));
}

/** kembalikan rotasi setiap objek ke 0° (di pusatnya masing-masing) */
export function resetRotation() {
  const s = getS();
  const orig = s.doc;
  const top = topLevel(orig, sel()).filter((id) => orig.nodes[id] && orig.nodes[id].type !== 'frame');
  // grup yang miring: diputar balik utuh di pusatnya (susunan isinya ikut tegak), bukan tiap anak diluruskan di tempat
  const groups = top.filter((id) => orig.nodes[id].type === 'group' && orig.nodes[id].rotation);
  const others = top.filter((id) => !groups.includes(id));
  const leaves = leafTargets(orig, others).filter((id) => orig.nodes[id].type !== 'frame' && orig.nodes[id].rotation);
  if (!leaves.length && !groups.length) return;
  s.mutate('Hapus rotasi', (d) => {
    for (const g of groups) {
      const n = orig.nodes[g];
      const c = applyM(nodeMatrix(n), { x: n.w / 2, y: n.h / 2 });
      const cur: Doc = { ...d, nodes: { ...d.nodes } };
      rotateNodes(d, cur, [g], c, -n.rotation);
    }
    for (const id of leaves) {
      const n = orig.nodes[id];
      d.nodes[id] = { ...n, rotation: 0 } as SceneNode;
    }
    for (const g of groupsIn(orig, others)) d.nodes[g] = { ...d.nodes[g], rotation: 0 };
    refreshAllGroups(d, leaves);
  });
}

/** letakkan seleksi tepat di tengah frame induknya */
export function centerInParent() {
  const s = getS();
  const ids = sel().filter((id) => !s.doc.nodes[id].locked);
  if (!ids.length) return;
  const orig = s.doc;
  const parentId = orig.nodes[ids[0]].parentId;
  if (!parentId) {
    toast('Objek ini tidak berada di dalam frame');
    return;
  }
  const ref = worldAABB(orig.nodes[parentId]);
  const b = unionBox(ids.map((id) => worldAABB(orig.nodes[id])))!;
  const dx = ref.x + ref.w / 2 - (b.x + b.w / 2),
    dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
  s.mutate('Tengahkan di frame', (d) => {
    ids.forEach((id) => translateTree(d, orig, id, dx, dy));
    refreshAllGroups(d, ids);
  });
}

/* ---------- kamera ---------- */

export function zoomAt(factor: number, sx?: number, sy?: number) {
  const s = getS();
  const { camera, viewport } = s;
  const px = sx ?? viewport.w / 2,
    py = sy ?? viewport.h / 2;
  const z = Math.min(256, Math.max(0.002, camera.zoom * factor));
  const wx = (px - camera.x) / camera.zoom,
    wy = (py - camera.y) / camera.zoom;
  s.set({ camera: { zoom: z, x: px - wx * z, y: py - wy * z } });
}

export function setZoom(z: number) {
  zoomAt(z / getS().camera.zoom);
}

/** kotak konten acuan untuk menaruh objek baru: seleksi, atau objek tingkat atas yang sedang terlihat di layar.
 *  (Dulu frame/palet baru selalu ditaruh di kanan objek PALING kanan di seluruh dokumen: satu objek yang jauh membuat frame
 *  baru jatuh jauh sekali, kamera ikut melompat ke frame kosong itu → seolah semua objek hilang; palet tidak terlihat.) */
export function contextBox(): Box | null {
  const s = getS();
  // seleksi di dalam frame/grup: acuannya induk teratasnya (objek baru tidak ditaruh menumpuk di frame induknya)
  const ids = [...new Set(sel().filter((id) => s.doc.nodes[id]).map((id) => {
    let t = id;
    while (s.doc.nodes[t]?.parentId && s.doc.nodes[s.doc.nodes[t].parentId!]) t = s.doc.nodes[t].parentId!;
    return t;
  }))];
  if (ids.length) return unionBox(ids.map((id) => contentAABB(s.doc, id)));
  const { camera: c, viewport: v } = s;
  const view = { x: -c.x / c.zoom, y: -c.y / c.zoom, w: v.w / c.zoom, h: v.h / c.zoom };
  const vis = s.doc.root
    .filter((id) => s.doc.nodes[id] && s.doc.nodes[id].visible !== false)
    .map((id) => contentAABB(s.doc, id))
    .filter((b) => b.x < view.x + view.w && b.x + b.w > view.x && b.y < view.y + view.h && b.y + b.h > view.y);
  return unionBox(vis);
}

/** pusat untuk objek baru w×h: di kanan konten acuan (sejajar atasnya), atau di tengah layar */
export function nearbySlot(w: number, h: number, gap = 80): { c: Pt; ref: Box | null } {
  const s = getS();
  const ref = contextBox();
  if (ref) {
    // geser ke kanan selama menumpuk objek tingkat atas lain (mis. frame berikutnya di deretan)
    const others = s.doc.root.map((id) => s.doc.nodes[id]).filter((n) => n && n.visible !== false).map(worldAABB);
    let x = ref.x + ref.w + gap;
    const y = ref.y;
    for (let k = 0; k < 200; k++) {
      const hit = others.find((b) => b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y);
      if (!hit) break;
      x = hit.x + hit.w + gap;
    }
    return { c: { x: x + w / 2, y: y + h / 2 }, ref };
  }
  const { camera: cam, viewport: v } = s;
  return { c: { x: (v.w / 2 - cam.x) / cam.zoom, y: (v.h / 2 - cam.y) / cam.zoom }, ref: null };
}

/** pastikan kotak terlihat: bila sudah di dalam layar kamera tidak diubah; bila tidak, kamera menampilkan kotak itu
 *  (beserta konten acuannya bila gabungannya tidak jauh lebih besar) */
export function revealBox(b: Box, ref?: Box | null) {
  const s = getS();
  const { camera: c, viewport: v } = s;
  const view = { x: -c.x / c.zoom, y: -c.y / c.zoom, w: v.w / c.zoom, h: v.h / c.zoom };
  if (b.x >= view.x && b.y >= view.y && b.x + b.w <= view.x + view.w && b.y + b.h <= view.y + view.h) return;
  let t = b;
  if (ref) {
    const u = unionBox([b, ref])!;
    if (u.w * u.h <= b.w * b.h * 6) t = u;
  }
  const pad = 80;
  const z = Math.min(8, Math.max(0.002, Math.min((v.w - pad * 2) / (t.w || 1), (v.h - pad * 2) / (t.h || 1))));
  s.set({ camera: { zoom: z, x: v.w / 2 - (t.x + t.w / 2) * z, y: v.h / 2 - (t.y + t.h / 2) * z } });
}

export function zoomToFit(onlySelection = false) {
  const s = getS();
  const ids = onlySelection && s.selection.length ? sel() : s.doc.root;
  const b = unionBox(ids.map((id) => s.doc.nodes[id]).filter(Boolean).map(worldAABB));
  if (!b) {
    s.set({ camera: { x: s.viewport.w / 2, y: s.viewport.h / 2, zoom: 1 } });
    return;
  }
  const pad = 80;
  const z = Math.min(8, Math.max(0.002, Math.min((s.viewport.w - pad * 2) / (b.w || 1), (s.viewport.h - pad * 2) / (b.h || 1))));
  s.set({
    camera: { zoom: z, x: s.viewport.w / 2 - (b.x + b.w / 2) * z, y: s.viewport.h / 2 - (b.y + b.h / 2) * z },
  });
}

export function toggleTheme() {
  const s = getS();
  const theme = s.theme === 'light' ? 'dark' : 'light';
  s.set({ theme });
  try {
    localStorage.setItem('designseru:theme', theme);
  } catch {
    /* abaikan */
  }
}

export function selectNextSibling(dir: 1 | -1) {
  const s = getS();
  const order = flatOrder(s.doc);
  if (!order.length) return;
  const cur = s.selection[0] ? order.indexOf(s.selection[0]) : -1;
  const next = order[(cur + dir + order.length) % order.length];
  s.select([next]);
}

export const useCanUndo = () => useStore((s) => s.past.length > 0);
export const useCanRedo = () => useStore((s) => s.future.length > 0);

/* ---------- Tahap 2 ---------- */

export function booleanOp(op: BoolOp) {
  const s = getS();
  if (!canBoolean(s.doc, s.selection)) {
    toast('Pilih minimal dua bentuk (bukan frame/teks) untuk operasi boolean', 'err');
    return;
  }
  let out: string[] = [];
  s.mutate(BOOL_LABEL[op], (d) => {
    out = runBoolean(d, s.selection, op);
  });
  s.set({ selection: out });
  if (!out.length) toast('Hasilnya kosong — bentuk tidak saling bertumpuk', 'err');
}

export function separateCurves() {
  const s = getS();
  const ids = sel().filter((id) => s.doc.nodes[id]?.type === 'compound');
  if (!ids.length) return;
  const out: string[] = [];
  s.mutate('Pisahkan kurva', (d) => ids.forEach((id) => out.push(...separateCompound(d, id))));
  s.set({ selection: out });
}

/** titik-titik path (koordinat dunia) dari bentuk mana pun yang punya garis */
export function pathOf(shape: SceneNode): { points: import('../model/types').Anchor[]; closed: boolean } {
  const m = nodeMatrix(shape);
  const src =
    shape.type === 'path' || shape.type === 'line'
      ? { points: shape.points, closed: shape.type === 'path' && shape.closed }
      : shape.type === 'compound'
        ? shape.contours[0]
        : cmdsToAnchors(shapeCmds(shape));
  const tw = (x: number, y: number) => applyM(m, { x, y });
  const points = src.points.map((p) => {
    const a = tw(p.x, p.y),
      i = tw(p.ix, p.iy),
      o = tw(p.ox, p.oy);
    return { ...p, x: a.x, y: a.y, ix: i.x, iy: i.y, ox: o.x, oy: o.y };
  });
  return { points, closed: src.closed };
}

export const canHoldText = (n: SceneNode | undefined) => !!n && !['text', 'group', 'frame', 'image', 'instance'].includes(n.type);

/** Pilih satu teks + satu path/garis/bentuk: teks mengikuti garisnya. Garis panduan tetap ada. */
export function textOnPath() {
  const s = getS();
  const ids = sel();
  const text = ids.map((id) => s.doc.nodes[id]).find((n) => n.type === 'text') as TextNode | undefined;
  const shape = ids.map((id) => s.doc.nodes[id]).find(canHoldText);
  if (!text || !shape || ids.length !== 2) {
    toast('Pilih satu teks dan satu path/garis/bentuk', 'err');
    return;
  }
  const { points, closed } = pathOf(shape);
  s.mutate('Teks pada path', (d) => {
    const t: TextNode = { ...text, x: 0, y: 0, rotation: 0, lin: undefined, onPath: { points, closed, offset: 0 } };
    d.nodes[text.id] = normalizePath(t);
    refreshAllGroups(d, [text.id]);
  });
  s.set({ selection: [text.id] });
}

export function detachTextPath() {
  const s = getS();
  const id = sel().find((x) => s.doc.nodes[x]?.type === 'text' && (s.doc.nodes[x] as TextNode).onPath);
  if (!id) return;
  s.updateNodes([id], (n) => {
    const t = n as TextNode;
    return relayoutText({ ...t, onPath: undefined, autoWidth: true, text: t.text });
  }, 'Lepas dari path');
}

export function toggleRulers() {
  getS().setToolOpts((o) => ({ ...o, rulers: !o.rulers }));
}
export function toggleSnap(which: 'snapObjects' | 'snapPixel') {
  getS().setToolOpts((o) => ({ ...o, [which]: !o[which] }));
}
export function clearGuides() {
  const s = getS();
  if (s.doc.guides.length) s.mutate('Hapus semua guide', (d) => (d.guides = []));
}

/* ---------- Tahap 3 ---------- */

export function maskSelection() {
  const ids = sel();
  if (ids.length < 2) {
    toast('Pilih bentuk mask (paling bawah) dan objek yang mau dimasukkan', 'err');
    return;
  }
  makeMask(ids);
}

export function unmaskSelection() {
  const s = getS();
  const g = sel().find((id) => s.doc.nodes[id]?.type === 'group' && (s.doc.nodes[id] as { mask?: boolean }).mask);
  if (g) releaseMask(g);
}

export function componentFromSelection() {
  const ids = sel();
  if (!ids.length) return;
  makeComponent(ids);
  toast('Komponen dibuat — tambahkan instance dari tab Aset › Komponen');
}

export function detachInstances() {
  const s = getS();
  const ids = sel().filter((id) => s.doc.nodes[id]?.type === 'instance');
  if (!ids.length) return;
  const out: string[] = [];
  s.mutate('Lepas instance', (d) => ids.forEach((id) => {
    const r = detachInstanceIn(d, id);
    if (r) out.push(r);
  }));
  s.set({ selection: out });
}

export function goToMaster() {
  const s = getS();
  const one = sel()[0] ? s.doc.nodes[sel()[0]] : null;
  if (!one || one.type !== 'instance' || !s.doc.nodes[one.componentId]) return;
  s.select([one.componentId]);
  zoomToFit(true);
}

export function resetInstanceSize() {
  const s = getS();
  const ids = sel().filter((id) => s.doc.nodes[id]?.type === 'instance');
  s.updateNodes(ids, (n) => {
    const m = n.type === 'instance' ? s.doc.nodes[n.componentId] : null;
    return m ? { ...n, w: m.w, h: m.h } : n;
  }, 'Reset ukuran instance');
}
