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
import { placeSvgText, placeInstance, placeTemplate, placeImage } from './place';
import { useLib, placeUpload } from './library';
import { placePhoto, type Photo } from './photos';
import { readImageFile } from '../engine/images';
import { toast } from '../ui/toast';
import { zoomToFit } from '../engine/commands';

export const DRAG_TYPE = 'application/x-designseru-asset';

export interface IconOpts {
  color: string;
  stroke: number;
  size: number;
}
export const iconOpts: IconOpts = { color: '#2B2B2E', stroke: 2, size: 96 };
/** logo brand (Simple Icons, CC0) & ikon Tabler (MIT): file kecil di public/icons, dimuat per ikon saat tampil/ditaruh */
export const brandIconUrl = (slug: string) => new URL(`icons/brand/${slug}.svg`, document.baseURI).href;
export const tablerIconUrl = (name: string) => new URL(`icons/tabler/${name}.svg`, document.baseURI).href;
/** emoji berwarna (Microsoft Fluent Emoji Flat, MIT) */
export const emojiUrl = (code: string) => new URL(`emoji/${code}.svg`, document.baseURI).href;
/** bendera negara (flag-icons, MIT), rasio 4:3 */
export const flagUrl = (code: string) => new URL(`flags/${code}.svg`, document.baseURI).href;
/** logo brand ditaruh dengan warna aslinya (bawaan) atau warna ikon yang dipilih */
export const brandOpts = { original: true };
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
/** Dapur & Bahan Masak (200 foto WebP transparan): gambar penuh di public/kuliner/<id>.webp (hanya diunduh saat ditaruh),
    thumbnail kecil di public/kuliner/t/<id>.webp (dipakai grid panel) */
/** Siluet (328 siluet monokrom: hewan & pohon): file di public/siluet/<id>.svg, dimuat per aset saat tampil/ditaruh; warna isi = INK supaya bisa diganti */
export const siluetUrl = (id: string) => new URL(`siluet/${id}.svg`, document.baseURI).href;
/** Ornamen (monokrom: pembatas, hiasan kepala/penutup, bingkai, fleuron; domain publik/CC0): file di public/ornamen/<id>.svg, warna isi = INK */
export const ornamenUrl = (id: string) => new URL(`ornamen/${id}.svg`, document.baseURI).href;
export const kulinerUrl = (id: string) => new URL(`kuliner/${id}.webp`, document.baseURI).href;
/** Tekstur & Batik (foto tekstur ambientCG CC0 & batik domain publik): gambar penuh saat ditaruh, thumbnail untuk grid */
export const teksturUrl = (id: string) => new URL(`tekstur/${id}.webp`, document.baseURI).href;
export const teksturThumbUrl = (id: string) => new URL(`tekstur/t/${id}.webp`, document.baseURI).href;
export const kulinerThumbUrl = (id: string) => new URL(`kuliner/t/${id}.webp`, document.baseURI).href;

/* ---- unduhan aset: disimpan di memori & dimulai lebih awal ----
   Dulu tiap klik menunggu unduhan file elemen (±150–450 ms ke server) sebelum objek muncul. Kini file mulai diunduh saat
   tile disorot / ditekan (prefetchPayload), dan hasilnya disimpan di memori: klik → objek langsung muncul. */
const assetCache = new Map<string, Promise<Blob>>();
const ASSET_CACHE_MAX = 80;
function cachedFetch(url: string): Promise<Response> {
  let p = assetCache.get(url);
  if (p) {
    // urutan Map = urutan pemakaian (LRU)
    assetCache.delete(url);
    assetCache.set(url, p);
  } else {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.blob();
    });
    p.catch(() => assetCache.delete(url));
    assetCache.set(url, p);
    while (assetCache.size > ASSET_CACHE_MAX) assetCache.delete(assetCache.keys().next().value as string);
  }
  return p.then(
    (b) => new Response(b, { status: 200 }),
    () => new Response(null, { status: 404 }),
  );
}

/** url file yang dibutuhkan payload (null = tidak perlu unduhan) */
function payloadUrl(payload: string): string | null {
  const i = payload.indexOf(':');
  if (i < 0) return null;
  const kind = payload.slice(0, i),
    id = payload.slice(i + 1);
  switch (kind) {
    case 'brand':
      return brandIconUrl(id.split('|')[0]);
    case 'emoji':
      return emojiUrl(id);
    case 'flag':
      return flagUrl(id);
    case 'tabler':
      return tablerIconUrl(id);
    case 'undraw':
      return undrawUrl(id);
    case 'flat':
      return flatUrl(id);
    case 'doodleart':
      return doodleArtUrl(id);
    case 'objectart':
      return objectArtUrl(id);
    case 'siluet':
      return siluetUrl(id);
    case 'ornamen':
      return ornamenUrl(id);
    case 'kuliner':
      return kulinerUrl(id);
    case 'tekstur':
      return teksturUrl(id);
    default:
      return null;
  }
}

/** mulai unduh file aset lebih awal (saat tile disorot/ditekan); aman dipanggil berulang */
export function prefetchPayload(payload: string) {
  const u = payloadUrl(payload);
  if (u && !assetCache.has(u)) void cachedFetch(u);
}

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
      case 'brand': {
        const [slug, hex] = id.split('|');
        const res = await cachedFetch(brandIconUrl(slug));
        if (!res.ok) throw new Error('Logo gagal dimuat');
        const fill = brandOpts.original && /^[0-9a-f]{6}$/i.test(hex ?? '') ? '#' + hex : iconOpts.color;
        return placeSvgText((await res.text()).replace('<path ', `<path fill="${fill}" `), 'Logo ' + slug, { at, size: iconOpts.size });
      }
      case 'emoji': {
        const res = await cachedFetch(emojiUrl(id));
        if (!res.ok) throw new Error('Emoji gagal dimuat');
        // vektor berwarna: satu group yang bisa di-ungroup & diwarnai per bagian
        return placeSvgText(await res.text(), 'Emoji', { at, size: 120 });
      }
      case 'flag': {
        const res = await cachedFetch(flagUrl(id));
        if (!res.ok) throw new Error('Bendera gagal dimuat');
        return placeSvgText(await res.text(), 'Bendera ' + id.toUpperCase(), { at, size: 240 });
      }
      case 'tabler': {
        const res = await cachedFetch(tablerIconUrl(id));
        if (!res.ok) throw new Error('Ikon gagal dimuat');
        const svg = (await res.text()).replace(/currentColor/g, iconOpts.color).replace('stroke-width="2"', `stroke-width="${iconOpts.stroke}"`);
        return placeSvgText(svg, id.replace(/-/g, ' '), { at, size: iconOpts.size });
      }
      case 'svgel': {
        const { elementById } = await import('./elements');
        const el = elementById(id);
        if (el) placeSvgText(tintSvg(el, elementOpts.color), el.name, { at, size: el.cat === 'pemandangan' ? 560 : 200 });
        return;
      }
      case 'undraw': {
        const res = await cachedFetch(undrawUrl(id));
        if (!res.ok) throw new Error('Ilustrasi gagal dimuat (file public/undraw tidak ditemukan)');
        let svg = await res.text();
        if (undrawOpts.color.toUpperCase() !== UNDRAW_DEFAULT) svg = svg.replace(/#6c63ff/gi, undrawOpts.color);
        // lebar 360 px, ilustrasi berupa satu group yang bisa di-ungroup & diedit per bagian
        placeSvgText(svg, id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), { at, size: 360 });
        return;
      }
      case 'flat': {
        const res = await cachedFetch(flatUrl(id));
        if (!res.ok) throw new Error('Aset gagal dimuat (file public/flat tidak ditemukan)');
        // karakter & potongan ditaruh berukuran asli (satu skala, jadi kepala/badan/celana pas dirakit); scene diperkecil
        placeSvgText(await res.text(), id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), { at, size: id.startsWith('scene-') ? 560 : undefined });
        return;
      }
      case 'doodleart': {
        const res = await cachedFetch(doodleArtUrl(id));
        if (!res.ok) throw new Error('Doodle gagal dimuat (file public/doodleart tidak ditemukan)');
        // viewBox sudah dipotong ke batas gambar → sisi terpanjang 240 px; satu group vektor yang bisa di-ungroup & diwarnai per bagian
        placeSvgText(await res.text(), 'Doodle ' + id.replace(/^da-/, ''), { at, size: 240 });
        return;
      }
      case 'objectart': {
        const res = await cachedFetch(objectArtUrl(id));
        if (!res.ok) throw new Error('Objek gagal dimuat (file public/objectart tidak ditemukan)');
        // viewBox sudah dipotong ke batas gambar → sisi terpanjang 360 px; satu group vektor, garis & warna bisa diubah per bagian
        placeSvgText(await res.text(), id.replace(/^ob-/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), { at, size: 360 });
        return;
      }
      case 'siluet': {
        const res = await cachedFetch(siluetUrl(id));
        if (!res.ok) throw new Error('Siluet gagal dimuat (file public/siluet tidak ditemukan)');
        let svg = await res.text();
        // satu path monokrom berisi INK: ganti dengan warna "elemen monokrom" yang dipilih di panel
        if (elementOpts.color.toUpperCase() !== INK) svg = svg.replace(/#1c1c1c/gi, elementOpts.color);
        // viewBox sudah dipotong ke batas gambar → sisi terpanjang 300 px (pohon 420 px); satu path yang bisa diwarnai/diedit titiknya
        placeSvgText(svg, id.replace(/^sl-/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), { at, size: id.startsWith('sl-pohon') ? 420 : 300 });
        return;
      }
      case 'ornamen': {
        const res = await cachedFetch(ornamenUrl(id));
        if (!res.ok) throw new Error('Ornamen gagal dimuat (file public/ornamen tidak ditemukan)');
        let svg = await res.text();
        // nu-… = Iluminasi Nusantara (berwarna asli, tidak diwarnai ulang)
        if (!id.startsWith('nu-') && elementOpts.color.toUpperCase() !== INK) svg = svg.replace(/#1c1c1c/gi, elementOpts.color);
        // viewBox sudah dipotong ke batas gambar → sisi terpanjang 320 px; satu group vektor monokrom yang bisa diwarnai/diedit
        placeSvgText(svg, id.replace(/^(or|nu)-/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), { at, size: 320 });
        return;
      }
      case 'kuliner': {
        const res = await cachedFetch(kulinerUrl(id));
        if (!res.ok) throw new Error('Foto gagal dimuat (file public/kuliner tidak ditemukan)');
        // byte WebP asli dipakai apa adanya (tanpa dikodekan ulang); gambar yang sama dipakai ulang di dokumen
        const img = await readImageFile(new Blob([await res.blob()], { type: 'image/webp' }), 2400, true);
        placeImage({ ...img, name: 'Kuliner ' + id.replace(/^kl-/, '').replace(/-/g, ' ') }, at, 360);
        return;
      }
      case 'tekstur': {
        const res = await cachedFetch(teksturUrl(id));
        if (!res.ok) throw new Error('Tekstur gagal dimuat');
        const img = await readImageFile(new Blob([await res.blob()], { type: 'image/webp' }), 2400, true);
        // dijatuhkan ke atas bentuk = mengisi bentuk itu (sama seperti foto); selain itu ditaruh sebagai gambar 600 px
        placeImage({ ...img, name: 'Tekstur ' + id.replace(/^(tx|bt)-/, '').replace(/-/g, ' ') }, at, 600);
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
