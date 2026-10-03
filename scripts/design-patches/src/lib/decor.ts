/* Stiker, tape & prangko yang bisa diedit: teks tetap teks, foto berupa gambar pengganti (ganti dengan
   "Tempel untuk mengganti" atau seret foto ke atasnya). Dibangun sebagai grup di dokumen sementara. */
import { getS } from '../store/store';
import type { Doc, ImageNode, RectNode, SceneNode, TextNode, EllipseNode, StarNode, Shadow } from '../model/types';
import { createNode, emptyDoc, insertNode, defaultFill, defaultStroke, cloneTree, pasteTrees, groupNodes } from '../model/doc';
import { relayoutText, ensureFont } from '../engine/text';
import { importSvg, scaleImport } from '../engine/svgImport';
import { worldAABB, type Pt } from '../engine/geometry';
import { rotateNodes } from '../engine/transform';
import { frameAt } from '../engine/hit';
import { getImage } from '../engine/images';
import { renderRaster } from './export';
import { addImageAsset, viewCenter } from './place';
import { stampD } from './elements/kit';

const INKC = '#2B2B2E';

/** foto pengganti: lanskap pastel bergaya ilustrasi */
const PHOTO_SVG = (a: string, b: string, c: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="${a}"/><circle cx="290" cy="90" r="42" fill="#FFF3C4"/><path d="M0 210 C70 150 130 160 190 200 C250 236 320 170 400 190 V300 H0Z" fill="${b}"/><path d="M0 250 C90 210 170 240 240 250 C300 258 350 236 400 246 V300 H0Z" fill="${c}"/></svg>`;
const PHOTOS = {
  peach: PHOTO_SVG('#FFD9C7', '#F4A6A0', '#C77D8F'),
  sky: PHOTO_SVG('#CFE6FF', '#8FB7F0', '#5F7FD1'),
  mint: PHOTO_SVG('#D8F3E4', '#8FD1AE', '#4F9C7E'),
};
const dataUrl = (s: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);

class B {
  d: Doc = emptyDoc();
  ids: string[] = [];
  private add<T extends SceneNode>(n: T): T {
    insertNode(this.d, n, null);
    this.ids.push(n.id);
    return n;
  }
  rect(x: number, y: number, w: number, h: number, o: { fill?: string | null; r?: number; stroke?: string; sw?: number; name?: string; shadow?: Shadow; op?: number } = {}) {
    const n = createNode('rect', x, y, w, h) as RectNode;
    n.fill = o.fill ? defaultFill(o.fill) : { ...n.fill, enabled: false };
    if (o.r) n.radius = [o.r, o.r, o.r, o.r];
    if (o.stroke) n.stroke = defaultStroke(true, o.stroke, o.sw ?? 3);
    if (o.name) n.name = o.name;
    if (o.shadow) n.shadows = [o.shadow];
    if (o.op !== undefined) n.opacity = o.op;
    return this.add(n);
  }
  ellipse(x: number, y: number, w: number, h: number, o: { fill?: string | null; stroke?: string; sw?: number; name?: string; shadow?: Shadow } = {}) {
    const n = createNode('ellipse', x, y, w, h) as EllipseNode;
    n.fill = o.fill ? defaultFill(o.fill) : { ...n.fill, enabled: false };
    if (o.stroke) n.stroke = defaultStroke(true, o.stroke, o.sw ?? 3);
    if (o.name) n.name = o.name;
    if (o.shadow) n.shadows = [o.shadow];
    return this.add(n);
  }
  star(x: number, y: number, s: number, fill: string, points: number, inner: number, o: { stroke?: string; sw?: number; name?: string } = {}) {
    const n = createNode('star', x, y, s, s) as StarNode;
    n.fill = defaultFill(fill);
    n.points = points;
    n.innerRatio = inner;
    if (o.stroke) n.stroke = defaultStroke(true, o.stroke, o.sw ?? 3);
    n.name = o.name ?? 'Burst';
    return this.add(n);
  }
  text(x: number, y: number, text: string, o: { font?: string; size?: number; weight?: number; color?: string; align?: 'left' | 'center' | 'right'; w?: number; ls?: number; name?: string } = {}) {
    const t = createNode('text', x, y, 10, 10) as TextNode;
    Object.assign(t, {
      text,
      name: o.name ?? text.split('\n')[0].slice(0, 24),
      fontFamily: o.font ?? 'Inter',
      fontSize: o.size ?? 24,
      fontWeight: o.weight ?? 600,
      align: o.align ?? 'left',
      letterSpacing: o.ls ?? 0,
      autoWidth: o.w === undefined,
      w: o.w ?? 10,
      lineHeight: 1.1,
    });
    t.fill = defaultFill(o.color ?? INKC);
    ensureFont(t);
    return this.add(relayoutText(t));
  }
  image(x: number, y: number, w: number, h: number, src: string, name = 'Foto (ganti dengan Tempel untuk mengganti)') {
    const imageId = addImageAsset(this.d, { src, w: 400, h: 300, name });
    const n = createNode('image', x, y, w, h) as ImageNode;
    n.imageId = imageId;
    n.name = name;
    return this.add(n);
  }
  /** bentuk vektor dari SVG (skala terhadap sisi terpanjang) */
  svg(svg: string, x: number, y: number, size: number, name: string, rot = 0) {
    const r = importSvg(svg, name);
    scaleImport(r, size);
    const b = worldAABB(r.doc.nodes[r.rootId]);
    const tree = cloneTree(r.doc.nodes, r.rootId, x - b.x, y - b.y);
    const [id] = pasteTrees(this.d, [tree], null);
    this.ids.push(id);
    if (rot) this.rotate([id], rot);
    return id;
  }
  rotate(ids: string[], deg: number, center?: Pt) {
    const box = ids.map((id) => worldAABB(this.d.nodes[id]));
    const x0 = Math.min(...box.map((b) => b.x)),
      y0 = Math.min(...box.map((b) => b.y)),
      x1 = Math.max(...box.map((b) => b.x + b.w)),
      y1 = Math.max(...box.map((b) => b.y + b.h));
    rotateNodes(this.d, { ...this.d, nodes: { ...this.d.nodes } }, ids, center ?? { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, deg);
  }
  done(name: string, tilt = 0): { doc: Doc; rootId: string } {
    if (tilt) this.rotate([...this.ids], tilt);
    const gid = groupNodes(this.d, [...this.ids])!;
    this.d.nodes[gid] = { ...this.d.nodes[gid], name };
    return { doc: this.d, rootId: gid };
  }
}

const SOFT: Shadow = { kind: 'outer', color: '#000000', opacity: 0.22, x: 0, y: 6, blur: 14 };
const stampSvg = (w: number, h: number, fill: string, stroke: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${stampD(0, 0, w, h, 5, 3.5)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/></svg>`;
const tapeSvg = (w: number, h: number, fill: string, op = 0.85) => {
  const t = 5,
    n = Math.round(h / 9);
  const pts: string[] = [`0,0`];
  for (let i = 0; i < n; i++) pts.push(`${i % 2 ? 0 : t},${((i + 0.5) * h) / n}`);
  pts.push(`0,${h}`, `${w},${h}`);
  for (let i = n - 1; i >= 0; i--) pts.push(`${w - (i % 2 ? 0 : t)},${((i + 0.5) * h) / n}`);
  pts.push(`${w},0`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polygon points="${pts.join(' ')}" fill="${fill}" fill-opacity="${op}"/></svg>`;
};
const washiStripes = (w: number, h: number, a: string, b: string) => {
  let inner = `<polygon points="0,0 ${w},0 ${w},${h} 0,${h}" fill="${a}"/>`;
  for (let x = 6; x < w; x += 20) inner += `<rect x="${x}" y="0" width="9" height="${h}" fill="${b}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`;
};

export interface Deco {
  id: string;
  name: string;
  meta: string;
  tags: string;
  build: () => { doc: Doc; rootId: string };
}

/* ---------------- tekstur PNG (plastik, kertas, dll) ---------------- */
/** overlay raster realistis (bukan vektor; dibuat oleh scripts/gen-textures.mjs): tempel di atas desain untuk efek plastik/kertas nyata.
    Ganti mode blend & opacity lewat panel lapisan untuk hasil terbaik. */
function pngTexture(id: string, name: string, tags: string, file: string, w: number, h: number, size = 320): Deco {
  return {
    id,
    name,
    meta: 'Tekstur PNG · realistis, transparan',
    tags,
    build: () => {
      const b = new B();
      const ratio = h / w;
      b.image(0, 0, size, Math.round(size * ratio), new URL(`textures/${file}`, document.baseURI).href, name);
      return b.done(name);
    },
  };
}

const PNG_TEXTURES: Deco[] = [
  pngTexture('tex-plastic-wrap-1', 'Plastik bening berkerut', 'plastik transparan bening kresek wrap kerut png foto tekstur overlay', 'plastic-wrap-1.png', 460, 460),
  pngTexture('tex-plastic-wrap-2', 'Plastik bening kilap', 'plastik transparan bening kilap glare wrap png foto tekstur overlay', 'plastic-wrap-2.png', 460, 460),
  pngTexture('tex-plastic-bubble', 'Bubble wrap plastik', 'plastik bubble wrap gelembung packing png foto tekstur overlay', 'plastic-bubble-wrap.png', 460, 460),
  pngTexture('tex-plastic-glare', 'Kilap plastik/kaca', 'plastik kaca glare kilap glossy sheet png foto tekstur overlay', 'plastic-glare-sheet.png', 460, 460),
  pngTexture('tex-paper-kraft', 'Kertas kraft coklat', 'kertas kraft coklat paper craft png foto tekstur background', 'paper-kraft.png', 520, 520),
  pngTexture('tex-paper-cream', 'Kertas krem lembut', 'kertas krem putih paper cream soft png foto tekstur background', 'paper-cream.png', 520, 520),
  pngTexture('tex-paper-crumpled', 'Kertas kusut', 'kertas kusut lipat crumpled paper png foto tekstur background', 'paper-crumpled.png', 460, 460),
  pngTexture('tex-paper-torn', 'Kertas sobek', 'kertas sobek robek torn paper edge png foto tekstur', 'paper-torn.png', 520, 390),
  pngTexture('tex-cardboard', 'Kardus bergelombang', 'kardus karton corrugated cardboard png foto tekstur background', 'texture-cardboard.png', 460, 460),
];

export const DECOS: Deco[] = [
  {
    id: 'stk-hello',
    name: 'Stiker bulat teks',
    meta: 'Teks bisa diedit',
    tags: 'stiker sticker bulat teks badge round',
    build: () => {
      const b = new B();
      b.ellipse(0, 0, 240, 240, { fill: '#FFFFFF', stroke: INKC, sw: 6, name: 'Dasar stiker', shadow: SOFT });
      b.ellipse(16, 16, 208, 208, { stroke: INKC, sw: 2.5, name: 'Cincin' });
      b.text(30, 62, 'ORIGINAL', { font: 'Space Mono', size: 16, weight: 700, ls: 4, w: 180, align: 'center', color: '#E8503A', name: 'Teks atas' });
      b.text(20, 88, 'Hello\nSummer', { font: 'Playfair Display', size: 44, weight: 700, w: 200, align: 'center', name: 'Judul stiker' });
      b.text(30, 184, 'since 2025', { font: 'Caveat', size: 26, weight: 700, w: 180, align: 'center', name: 'Teks bawah' });
      b.star(105, 40, 30, '#FFD43B', 5, 0.45, { stroke: INKC, sw: 2, name: 'Bintang' });
      return b.done('Stiker bulat', -6);
    },
  },
  {
    id: 'stk-burst',
    name: 'Stiker burst diskon',
    meta: 'Teks bisa diedit',
    tags: 'stiker burst diskon sale promo badge',
    build: () => {
      const b = new B();
      b.star(0, 0, 250, '#FFD43B', 16, 0.82, { stroke: INKC, sw: 5, name: 'Burst' });
      b.text(25, 62, 'SALE', { font: 'Bebas Neue', size: 56, weight: 400, ls: 3, w: 200, align: 'center', name: 'Judul' });
      b.text(25, 108, '50%', { font: 'Bebas Neue', size: 86, weight: 400, w: 200, align: 'center', color: '#E8503A', name: 'Angka' });
      b.text(25, 188, 'hanya minggu ini', { font: 'Caveat', size: 24, weight: 700, w: 200, align: 'center', name: 'Keterangan' });
      return b.done('Stiker burst', 8);
    },
  },
  {
    id: 'stk-name',
    name: 'Label "Hello my name is"',
    meta: 'Teks bisa diedit',
    tags: 'label nama name tag hello stiker',
    build: () => {
      const b = new B();
      b.rect(0, 0, 300, 200, { fill: '#FFFFFF', r: 18, stroke: '#E8503A', sw: 6, name: 'Dasar', shadow: SOFT });
      b.rect(0, 0, 300, 78, { fill: '#E8503A', r: 18, name: 'Kepala' });
      b.rect(0, 40, 300, 38, { fill: '#E8503A', name: 'Kepala bawah' });
      b.text(10, 10, 'HELLO', { font: 'Bebas Neue', size: 44, weight: 400, ls: 6, w: 280, align: 'center', color: '#FFFFFF', name: 'Hello' });
      b.text(10, 52, 'my name is', { font: 'Poppins', size: 17, weight: 600, w: 280, align: 'center', color: '#FFFFFF', name: 'my name is' });
      b.text(14, 108, 'Namamu', { font: 'Caveat', size: 62, weight: 700, w: 272, align: 'center', name: 'Nama' });
      return b.done('Label nama', -3);
    },
  },
  {
    id: 'stk-photo',
    name: 'Stiker foto',
    meta: 'Foto & teks bisa diganti',
    tags: 'stiker foto photo sticker frame putih',
    build: () => {
      const b = new B();
      b.rect(0, 0, 250, 250, { fill: '#FFFFFF', r: 26, name: 'Bingkai putih', shadow: SOFT });
      b.image(14, 14, 222, 222, dataUrl(PHOTOS.peach));
      b.rect(0, 0, 250, 250, { r: 26, stroke: '#FFFFFF', sw: 6, name: 'Tepi stiker' });
      b.text(30, 196, 'good vibes', { font: 'Caveat', size: 34, weight: 700, w: 190, align: 'center', color: '#FFFFFF', name: 'Keterangan' });
      return b.done('Stiker foto', 5);
    },
  },
  {
    id: 'polaroid',
    name: 'Polaroid + tape',
    meta: 'Foto & teks bisa diganti',
    tags: 'polaroid foto photo tape kartu memori',
    build: () => {
      const b = new B();
      b.rect(0, 20, 240, 290, { fill: '#FFFFFF', r: 4, name: 'Kartu polaroid', shadow: SOFT });
      b.image(16, 36, 208, 208, dataUrl(PHOTOS.sky));
      b.text(16, 254, 'summer trip', { font: 'Caveat', size: 38, weight: 700, w: 208, align: 'center', name: 'Keterangan' });
      b.svg(tapeSvg(96, 30, '#F6D365'), 72, 0, 96, 'Tape', -4);
      return b.done('Polaroid', -4);
    },
  },
  {
    id: 'tape-photo',
    name: 'Foto dengan tape sudut',
    meta: 'Foto bisa diganti',
    tags: 'foto photo tape washi album scrapbook',
    build: () => {
      const b = new B();
      b.rect(0, 0, 280, 210, { fill: '#FFFFFF', name: 'Kertas foto', shadow: SOFT });
      b.image(10, 10, 260, 190, dataUrl(PHOTOS.mint));
      b.svg(washiStripes(90, 28, '#F783AC', '#FFE3EC'), -22, -6, 90, 'Tape kiri atas', -38);
      b.svg(washiStripes(90, 28, '#74C0FC', '#E7F5FF'), 214, 186, 90, 'Tape kanan bawah', -38);
      return b.done('Foto tape', 3);
    },
  },
  {
    id: 'tape-note',
    name: 'Catatan + washi tape',
    meta: 'Teks bisa diedit',
    tags: 'catatan note sticky memo tape washi',
    build: () => {
      const b = new B();
      b.rect(0, 14, 250, 230, { fill: '#FFF3A3', name: 'Kertas catatan', shadow: SOFT });
      b.text(24, 62, 'NOTE!', { font: 'Bebas Neue', size: 52, weight: 400, ls: 3, name: 'Judul' });
      b.text(24, 122, 'Tulis catatan singkat\ndi sini, klik dua kali\nuntuk mengedit.', { font: 'Caveat', size: 30, weight: 600, lh: undefined, name: 'Isi catatan' } as never);
      b.svg(washiStripes(120, 34, '#FF8787', '#FFE3E3'), 65, 0, 120, 'Washi tape', -3);
      return b.done('Catatan', 2);
    },
  },
  {
    id: 'tape-label',
    name: 'Tape bertulisan',
    meta: 'Teks bisa diedit',
    tags: 'tape teks label washi selotip judul',
    build: () => {
      const b = new B();
      b.svg(tapeSvg(280, 56, '#FFD43B', 0.95), 0, 0, 280, 'Tape kuning');
      b.text(10, 10, 'SCRAPBOOK', { font: 'Space Mono', size: 26, weight: 700, ls: 6, w: 260, align: 'center', name: 'Teks tape' });
      return b.done('Tape teks', -5);
    },
  },
  {
    id: 'stamp-classic',
    name: 'Prangko klasik',
    meta: 'Gambar & teks bisa diganti',
    tags: 'prangko stamp perangko pos vintage',
    build: () => {
      const b = new B();
      b.svg(stampSvg(200, 240, '#FFFDF6', '#C9C2AE'), 0, 0, 240, 'Prangko');
      b.rect(16, 16, 168, 208, { fill: '#F4EAD5', name: 'Bidang prangko' });
      b.image(24, 24, 152, 144, dataUrl(PHOTOS.peach));
      b.text(24, 176, 'INDONESIA', { font: 'Playfair Display', size: 15, weight: 700, ls: 2, name: 'Negara' });
      b.text(24, 194, '1000', { font: 'Bebas Neue', size: 34, weight: 400, color: '#E8503A', name: 'Nilai' });
      b.text(120, 204, 'POS', { font: 'Space Mono', size: 13, weight: 700, w: 56, align: 'right', name: 'Kode' });
      return b.done('Prangko klasik', 3);
    },
  },
  {
    id: 'stamp-wide',
    name: 'Prangko lanskap',
    meta: 'Gambar & teks bisa diganti',
    tags: 'prangko stamp lanskap perangko wide',
    build: () => {
      const b = new B();
      b.svg(stampSvg(300, 200, '#FFFFFF', '#C9C2AE'), 0, 0, 300, 'Prangko');
      b.image(16, 16, 268, 140, dataUrl(PHOTOS.sky));
      b.text(18, 162, 'Kota Tua', { font: 'Playfair Display', size: 20, weight: 700, name: 'Judul' });
      b.text(180, 158, '2500', { font: 'Bebas Neue', size: 32, weight: 400, w: 100, align: 'right', color: '#3B5BDB', name: 'Nilai' });
      return b.done('Prangko lanskap', -3);
    },
  },
  {
    id: 'stamp-postmark',
    name: 'Prangko + cap pos',
    meta: 'Gambar & teks bisa diganti',
    tags: 'prangko stamp cap pos postmark stempel',
    build: () => {
      const b = new B();
      b.svg(stampSvg(200, 240, '#FFFDF6', '#C9C2AE'), 0, 0, 240, 'Prangko');
      b.image(22, 22, 156, 170, dataUrl(PHOTOS.mint));
      b.text(22, 200, '750', { font: 'Bebas Neue', size: 30, weight: 400, color: '#2F9E44', name: 'Nilai' });
      const cx = 168,
        cy = 190;
      b.ellipse(cx - 56, cy - 56, 112, 112, { stroke: '#3B3B5C', sw: 3, name: 'Cap pos luar' });
      b.ellipse(cx - 44, cy - 44, 88, 88, { stroke: '#3B3B5C', sw: 2, name: 'Cap pos dalam' });
      b.text(cx - 44, cy - 22, 'JAKARTA', { font: 'Space Mono', size: 13, weight: 700, w: 88, align: 'center', color: '#3B3B5C', name: 'Kota' });
      b.text(cx - 44, cy - 4, '12 JUL 25', { font: 'Space Mono', size: 11, weight: 700, w: 88, align: 'center', color: '#3B3B5C', name: 'Tanggal' });
      return b.done('Prangko cap pos', 4);
    },
  },
  {
    id: 'tag-airmail',
    name: 'Label Par Avion',
    meta: 'Teks bisa diedit',
    tags: 'airmail par avion pos label amplop surat',
    build: () => {
      const b = new B();
      b.rect(0, 0, 260, 110, { fill: '#FFFFFF', name: 'Dasar', shadow: SOFT });
      for (let i = 0; i < 13; i++) b.svg(`<svg xmlns="http://www.w3.org/2000/svg" width="26" height="12" viewBox="0 0 26 12"><polygon points="8,0 26,0 18,12 0,12" fill="${i % 2 ? '#3B5BDB' : '#E8503A'}"/></svg>`, i * 20 - 6, 0, 26, 'Garis');
      b.rect(0, 100, 260, 10, { fill: '#FFFFFF', name: 'Tutup' });
      b.text(0, 34, 'PAR AVION', { font: 'Bebas Neue', size: 40, weight: 400, ls: 5, w: 260, align: 'center', color: '#3B5BDB', name: 'Par avion' });
      b.text(0, 74, 'BY AIR MAIL', { font: 'Space Mono', size: 14, weight: 700, ls: 4, w: 260, align: 'center', color: '#E8503A', name: 'By air mail' });
      return b.done('Label airmail', -2);
    },
  },
  {
    id: 'stk-ticket',
    name: 'Tiket',
    meta: 'Teks bisa diedit',
    tags: 'tiket ticket event konser stiker',
    build: () => {
      const b = new B();
      b.rect(0, 0, 320, 130, { fill: '#FFD43B', r: 14, stroke: INKC, sw: 4, name: 'Tiket', shadow: SOFT });
      b.ellipse(-14, 51, 28, 28, { fill: '#FFFFFF', stroke: INKC, sw: 4, name: 'Lubang kiri' });
      b.ellipse(306, 51, 28, 28, { fill: '#FFFFFF', stroke: INKC, sw: 4, name: 'Lubang kanan' });
      b.text(26, 22, 'ADMIT ONE', { font: 'Bebas Neue', size: 54, weight: 400, ls: 2, name: 'Judul' });
      b.text(26, 84, 'Sabtu, 12 Juli · 19.00', { font: 'Space Mono', size: 15, weight: 700, name: 'Jadwal' });
      b.text(236, 40, 'No.\n0001', { font: 'Space Mono', size: 22, weight: 700, w: 70, align: 'center', color: '#E8503A', name: 'Nomor' });
      return b.done('Tiket', -4);
    },
  },
  ...PNG_TEXTURES,
];

/* ---------------- penempatan & thumbnail ---------------- */

export function placeDeco(id: string, at?: Pt) {
  const dec = DECOS.find((x) => x.id === id);
  if (!dec) return;
  const s = getS();
  const { doc, rootId } = dec.build();
  const b = worldAABB(doc.nodes[rootId]);
  const c = at ?? viewCenter();
  const selFrame = !at && s.selection.length === 1 && s.doc.nodes[s.selection[0]]?.type === 'frame' ? s.selection[0] : null;
  const center = selFrame ? { x: s.doc.nodes[selFrame].x + s.doc.nodes[selFrame].w / 2, y: s.doc.nodes[selFrame].y + s.doc.nodes[selFrame].h / 2 } : c;
  const parent = selFrame ?? frameAt(s.doc, center);
  const tree = cloneTree(doc.nodes, rootId, Math.round(center.x - (b.x + b.w / 2)), Math.round(center.y - (b.y + b.h / 2)));
  let out = '';
  s.mutate('Tambah ' + dec.name, (d) => {
    d.images = { ...d.images, ...doc.images };
    [out] = pasteTrees(d, [tree], parent);
  });
  s.set({ selection: [out], tool: 'move' });
}

const thumbs = new Map<string, Promise<string>>();
export function decoThumb(dec: Deco): Promise<string> {
  let p = thumbs.get(dec.id);
  if (!p) {
    p = (async () => {
      const { doc, rootId } = dec.build();
      for (const id of Object.keys(doc.images)) getImage(doc, id);
      await new Promise((r) => setTimeout(r, 180));
      try {
        const n = doc.nodes[rootId];
        const b = worldAABB(n);
        return renderRaster(doc, [rootId], (200 / Math.max(b.w, b.h)) * 2).toDataURL('image/png');
      } catch {
        return '';
      }
    })();
    thumbs.set(dec.id, p);
  }
  return p;
}
