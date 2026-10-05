/* Satu pintu untuk menaruh aset (klik atau seret ke kanvas) */
import { getS } from '../store/store';
import type { Pt } from '../engine/geometry';
import { insertAsset } from '../ui/assets';
import { lucideSvg, iconifySvg, loadLucide } from './icons';
import { ILLUSTRATIONS } from './illustrations';
import { tintSvg, INK } from './elements/meta';
import { insertPreset } from './frames';
import { placeDeco } from './decor';
import { TEMPLATES } from './templates';
import { placeSvgText, placeInstance, placeTemplate } from './place';
import { useLib, placeUpload } from './library';
import { placePhoto, type Photo } from './photos';
import { toast } from '../ui/toast';
import { zoomToFit } from '../engine/commands';

export const DRAG_TYPE = 'application/x-designseru-asset';

export interface IconOpts {
  color: string;
  stroke: number;
  size: number;
}
export const iconOpts: IconOpts = { color: '#2B2B2E', stroke: 2, size: 96 };
/** warna tinta untuk elemen monokrom */
export const elementOpts = { color: INK };

/** warna aksen ilustrasi unDraw (bawaan unDraw = ungu #6C63FF); diganti saat ilustrasi ditaruh di kanvas */
export const UNDRAW_DEFAULT = '#6C63FF';
export const undrawOpts = { color: UNDRAW_DEFAULT };
export const undrawUrl = (id: string) => new URL(`undraw/${id}.svg`, document.baseURI).href;
/** Flat Assets (Humaaans, CC0): file di public/flat/<id>.svg, dimuat per aset saat dibutuhkan */
export const flatUrl = (id: string) => new URL(`flat/${id}.svg`, document.baseURI).href;
/** Doodle Art (151 doodle berwarna): file di public/doodleart/<id>.svg, dimuat per aset saat dibutuhkan */
export const doodleArtUrl = (id: string) => new URL(`doodleart/${id}.svg`, document.baseURI).href;
/** Objek Line Art (26 objek garis): file di public/objectart/<id>.svg, dimuat per aset saat dibutuhkan */
export const objectArtUrl = (id: string) => new URL(`objectart/${id}.svg`, document.baseURI).href;

export async function placePayload(payload: string, at?: Pt) {
  const i = payload.indexOf(':');
  const kind = i < 0 ? 'asset' : payload.slice(0, i);
  const id = i < 0 ? payload : payload.slice(i + 1);
  try {
    switch (kind) {
      case 'asset':
        return insertAsset(id, at);
      case 'icon':
        await loadLucide();
        return placeSvgText(lucideSvg(id, iconOpts.color, iconOpts.stroke), id.replace(/([a-z0-9])([A-Z])/g, '$1 $2'), { at, size: iconOpts.size });
      case 'iconify': {
        const svg = await iconifySvg(id);
        if (!svg) throw new Error('Ikon gagal diunduh');
        return placeSvgText(svg.replace(/currentColor/g, iconOpts.color), id.split(':')[1], { at, size: iconOpts.size });
      }
      case 'svgel': {
        const { elementById } = await import('./elements');
        const el = elementById(id);
        if (el) placeSvgText(tintSvg(el, elementOpts.color), el.name, { at, size: el.cat === 'pemandangan' ? 560 : 200 });
        return;
      }
      case 'undraw': {
        const res = await fetch(undrawUrl(id));
        if (!res.ok) throw new Error('Ilustrasi gagal dimuat (file public/undraw tidak ditemukan)');
        let svg = await res.text();
        if (undrawOpts.color.toUpperCase() !== UNDRAW_DEFAULT) svg = svg.replace(/#6c63ff/gi, undrawOpts.color);
        // lebar 360 px, ilustrasi berupa satu group yang bisa di-ungroup & diedit per bagian
        placeSvgText(svg, id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), { at, size: 360 });
        return;
      }
      case 'flat': {
        const res = await fetch(flatUrl(id));
        if (!res.ok) throw new Error('Aset gagal dimuat (file public/flat tidak ditemukan)');
        // karakter & potongan ditaruh berukuran asli (satu skala, jadi kepala/badan/celana pas dirakit); scene diperkecil
        placeSvgText(await res.text(), id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), { at, size: id.startsWith('scene-') ? 560 : undefined });
        return;
      }
      case 'doodleart': {
        const res = await fetch(doodleArtUrl(id));
        if (!res.ok) throw new Error('Doodle gagal dimuat (file public/doodleart tidak ditemukan)');
        // viewBox sudah dipotong ke batas gambar → sisi terpanjang 240 px; satu group vektor yang bisa di-ungroup & diwarnai per bagian
        placeSvgText(await res.text(), 'Doodle ' + id.replace(/^da-/, ''), { at, size: 240 });
        return;
      }
      case 'objectart': {
        const res = await fetch(objectArtUrl(id));
        if (!res.ok) throw new Error('Objek gagal dimuat (file public/objectart tidak ditemukan)');
        // viewBox sudah dipotong ke batas gambar → sisi terpanjang 360 px; satu group vektor, garis & warna bisa diubah per bagian
        placeSvgText(await res.text(), id.replace(/^ob-/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), { at, size: 360 });
        return;
      }
      case 'deco':
        return placeDeco(id, at);
      case 'frame': {
        const [pid, o] = id.split(':');
        insertPreset(pid, o === 'l', at);
        return;
      }
      case 'illo': {
        const il = ILLUSTRATIONS.find((x) => x.id === id);
        if (il) placeSvgText(il.svg, il.name, { at, size: 240 });
        return;
      }
      case 'tpl': {
        const t = TEMPLATES.find((x) => x.id === id);
        if (!t) return;
        placeTemplate(t.build(), t.name);
        requestAnimationFrame(() => zoomToFit(true));
        return;
      }
      case 'upload': {
        const u = useLib.getState().uploads.find((x) => x.id === id);
        if (u) placeUpload(u, at);
        return;
      }
      case 'logo': {
        const u = useLib.getState().brand.logos.find((x) => x.id === id);
        if (u) placeUpload(u, at);
        return;
      }
      case 'comp':
        if (getS().doc.nodes[id]) placeInstance(id, at);
        return;
      case 'photo':
        await placePhoto(JSON.parse(id) as Photo, at);
        return;
    }
  } catch (e) {
    toast((e as Error).message || 'Aset gagal ditambahkan', 'err');
  }
}
