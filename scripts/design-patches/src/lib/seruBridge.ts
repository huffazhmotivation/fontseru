/**
 * Jembatan salin-tempel SVG antara DesignSeru (tab Design, di iframe) dan FontSeru (tab Font, halaman induk).
 *
 *  Salin di Design  → (1) SVG berwarna lengkap ke clipboard sistem (bisa ditempel ke Figma / Affinity / dll),
 *                     (2) SVG "outline" (isi + garis tepi sudah dijadikan bentuk berisi, teks jadi kurva) dikirim
 *                         lewat postMessage ke FontSeru supaya langsung bisa ditempel jadi objek vektor di glyph.
 *  Tempel di Design ← SVG dari clipboard sistem, atau salinan terakhir dari tab Font (postMessage) bila lebih baru
 *                     daripada salinan internal Design.
 *
 *  Setiap SVG yang kita tulis diberi penanda `data-seru-clip="<id>"` agar tempel di aplikasi yang sama memakai
 *  clipboard internalnya (presisi penuh: gambar, efek, grup) dan bukan mengimpor ulang SVG-nya.
 */
import type { Doc, SceneNode } from '../model/types';
import { exportSVG, exportBox } from './export';
import { cmdsToSvgD, nodeMatrix, shapeCmds, round2 } from '../engine/geometry';
import { strokeToShape } from '../engine/stroke';
import { instanceMatrix } from '../engine/draw';
import { textToCurves } from './textcurves';
import { uid } from '../model/doc';

const EMBEDDED = typeof window !== 'undefined' && window.parent !== window;
const MSG = 'seru:clip';

interface Clip {
  id: string;
  ts: number;
}
/** salinan terakhir yang dibuat di Design */
let internal: Clip = { id: '', ts: 0 };
/** salinan terakhir dari tab Font (diterima lewat postMessage) */
let external: (Clip & { svg: string }) | null = null;
/** teks SVG yang menunggu ditulis ke clipboard oleh event "copy" native (sinkron, tanpa izin) */
let pending: { svg: string; at: number } | null = null;

/* ---------------- penanda ---------------- */

export const isSvgText = (t: string) => {
  const s = t.trim();
  return s.startsWith('<svg') || (s.startsWith('<?xml') && s.includes('<svg'));
};
const markerId = (svg: string): string => /data-seru-clip="([^"]+)"/.exec(svg.slice(0, 600))?.[1] ?? '';
const tag = (svg: string, id: string) => svg.replace(/<svg\b/, `<svg data-seru-clip="${id}" data-seru-origin="design"`);

/* ---------------- ekspor outline (untuk FontSeru) ---------------- */

/** SVG sederhana: hanya <path> berisi, dalam koordinat dunia. Strokes → bentuk berisi, teks → kurva, gambar diabaikan. */
async function outlineSvg(doc: Doc, ids: string[], id: string): Promise<string | null> {
  const parts: string[] = [];
  const push = (d: string, rule?: 'evenodd') => {
    if (d && d.length > 3) parts.push(`<path d="${d}" fill="#111111"${rule ? ' fill-rule="evenodd"' : ''}/>`);
  };
  const leaf = async (n: SceneNode, m?: DOMMatrix, depth = 0): Promise<void> => {
    if (!n || !n.visible || depth > 5) return;
    if (n.type === 'group' || n.type === 'frame') {
      const kids = n.type === 'group' && n.mask ? n.children.slice(1) : n.children;
      for (const c of kids) await leaf(doc.nodes[c], m, depth + 1);
      return;
    }
    if (n.type === 'instance') {
      const master = doc.nodes[n.componentId];
      const im = instanceMatrix(doc, n);
      if (master && im) await leaf({ ...master, visible: true }, m ? m.multiply(im) : im, depth + 1);
      return;
    }
    if (n.type === 'image') return;
    if (n.type === 'text') {
      try {
        const c = await textToCurves(n);
        if (c) await leaf(c, m, depth + 1);
      } catch {
        /* teks pada path / font gagal dibentuk → lewati */
      }
      return;
    }
    const cmds = shapeCmds(n);
    if (!cmds.length) return;
    const base = nodeMatrix(n);
    const mat = m ? m.multiply(base) : base;
    const brushOnly = n.type === 'path' && !!n.brush;
    if (n.fill.enabled && n.type !== 'line' && !brushOnly) push(cmdsToSvgD(cmds, mat), n.type === 'compound' && n.fillRule === 'evenodd' ? 'evenodd' : undefined);
    if (n.stroke.enabled && n.stroke.width > 0 && !m) {
      try {
        const sh = strokeToShape(n);
        if (sh) push(sh.pathData, undefined);
      } catch {
        /* garis gagal diubah → lewati */
      }
    }
  };
  for (const rid of ids) await leaf(doc.nodes[rid]);
  if (!parts.length) return null;
  const box = exportBox(doc, ids) ?? { x: 0, y: 0, w: 100, h: 100 };
  const vb = `${round2(box.x)} ${round2(box.y)} ${round2(Math.max(1, box.w))} ${round2(Math.max(1, box.h))}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" data-seru-clip="${id}" data-seru-origin="design" viewBox="${vb}" width="${round2(Math.max(1, box.w))}" height="${round2(Math.max(1, box.h))}">\n${parts.join('\n')}\n</svg>\n`;
}

/* ---------------- salin ---------------- */

/** dipanggil setiap kali Design menyalin (Ctrl/Cmd+C, tombol Salin tablet, menu klik kanan) */
export function announceCopy(doc: Doc, ids: string[]) {
  if (!ids.length) return;
  const id = uid();
  internal = { id, ts: Date.now() };
  const ts = internal.ts;
  // 1) SVG berwarna ke clipboard sistem
  let rich = '';
  try {
    rich = tag(exportSVG(doc, ids), id);
  } catch {
    rich = '';
  }
  if (rich && rich.length < 12_000_000) {
    pending = { svg: rich, at: ts };
    try {
      void navigator.clipboard?.writeText(rich).catch(() => undefined);
    } catch {
      /* tanpa izin: event "copy" native di bawah yang menulis */
    }
  }
  // 2) SVG outline ke FontSeru
  if (EMBEDDED) {
    void outlineSvg(doc, ids, id)
      .then((svg) => {
        if (svg && internal.id === id) window.parent.postMessage({ type: MSG, from: 'design', id, ts, svg }, location.origin);
      })
      .catch(() => undefined);
  }
}

/* ---------------- tempel ---------------- */

/** SVG dari tab Font bila lebih baru daripada salinan internal Design; selain itu null */
export function externalSvgIfNewer(): string | null {
  return external && external.ts > internal.ts ? external.svg : null;
}
export const hasExternalClip = () => !!external;

/**
 * Teks SVG dari clipboard sistem. true = sudah ditempel; false = SVG ini salinan Design sendiri
 * (pemanggil memakai clipboard internal supaya hasilnya presisi penuh).
 */
export function classifyClipText(text: string): 'own' | 'import' {
  const id = markerId(text);
  return id && id === internal.id ? 'own' : 'import';
}

/* ---------------- pendengar ---------------- */

let started = false;
export function initSeruBridge() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.origin !== location.origin) return;
    const d = e.data as { type?: string; from?: string; id?: string; ts?: number; svg?: string } | null;
    if (d?.type === MSG && d.from === 'font' && typeof d.svg === 'string' && d.id) external = { id: d.id, ts: d.ts ?? Date.now(), svg: d.svg };
  });
  // event "copy"/"cut" native: tulis SVG sinkron ke clipboard (jalur andal di iPad / dalam iframe)
  const onNativeCopy = (e: ClipboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (pending && Date.now() - pending.at < 1500 && e.clipboardData) {
      e.clipboardData.setData('text/plain', pending.svg);
      e.preventDefault();
    }
  };
  window.addEventListener('copy', onNativeCopy, true);
  window.addEventListener('cut', onNativeCopy, true);
  // minta salinan terakhir dari tab Font (bila sudah ada sebelum Design selesai dimuat)
  if (EMBEDDED) window.parent.postMessage({ type: 'seru:hello', from: 'design' }, location.origin);
}
