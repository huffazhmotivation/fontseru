import { useAppStore } from "@/glyph/store";
import type { Contour, VectorObject } from "@/types/geometry";
import { contourToPath, objectFillPath, toSvgPoint } from "@/editor/pathBuilder";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { extractSvgMarkup, pasteSvgMarkup, pasteSvgFromSystemClipboard } from "@/trace/svgImport";

/**
 * Salin-tempel SVG antara tab Font (halaman ini) dan tab Design (DesignSeru di iframe).
 *
 *  Salin di Font   → objek terpilih dijadikan SVG (sumbu Y dibalik ke koordinat layar, kuas jadi outline,
 *                    garis tengah tetap garis bertebal) lalu ditulis ke clipboard sistem DAN dikirim ke iframe Design.
 *  Tempel di Font  ← SVG dari clipboard sistem (Affinity / Illustrator / Design / dll) atau salinan terakhir dari
 *                    tab Design bila lebih baru daripada salinan internal Font.
 *
 *  Setiap SVG yang kita tulis ditandai `data-seru-clip="<id>"`: tempel di Font dari salinan Font sendiri memakai
 *  clipboard internal (posisi persis, tanpa diskalakan ulang), bukan mengimpor ulang SVG-nya.
 */

const MSG = "seru:clip";

interface Clip { id: string; ts: number }
let internal: Clip = { id: "", ts: 0 };
let external: (Clip & { svg: string }) | null = null;
let designWin: Window | null = null;
/** salinan terakhir dari Font — dikirim ulang ke Design bila iframe baru selesai dimuat */
let lastFont: { id: string; ts: number; svg: string } | null = null;

const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const markerId = (svg: string): string => /data-seru-clip="([^"]+)"/.exec(svg.slice(0, 600))?.[1] ?? "";

/* ---------------- objek Font → SVG ---------------- */

const f2 = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

function contourExtents(c: Contour, asc: number, acc: { x0: number; y0: number; x1: number; y1: number }) {
  for (const n of c.nodes) {
    for (const p of [n.point, n.handleIn, n.handleOut]) {
      if (!p) continue;
      const q = toSvgPoint(p, asc);
      acc.x0 = Math.min(acc.x0, q.x); acc.y0 = Math.min(acc.y0, q.y);
      acc.x1 = Math.max(acc.x1, q.x); acc.y1 = Math.max(acc.y1, q.y);
    }
  }
}

export function objectsToSvg(objects: VectorObject[], ascender: number, id: string): string | null {
  const parts: string[] = [];
  const ext = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let pad = 0;
  for (const o of objects) {
    if (o.kind === "line") {
      const d = o.contours.map((c) => contourToPath(c, ascender)).join(" ").trim();
      if (!d) continue;
      const w = o.strokeWidth ?? 20;
      pad = Math.max(pad, w / 2);
      o.contours.forEach((c) => contourExtents(c, ascender, ext));
      parts.push(`<path d="${d}" fill="none" stroke="#111111" stroke-width="${f2(w)}" stroke-linecap="${o.cap ?? "round"}" stroke-linejoin="${o.join ?? "round"}"/>`);
      continue;
    }
    // shape / expanded → isi langsung; brush → outline envelope-nya (sama dengan yang dirender di kanvas)
    const contours = o.kind === "brush" ? brushOutlineContours(o) : o.contours;
    if (!contours.length) continue;
    const d = (o.kind === "brush"
      ? contours.map((c) => contourToPath(c, ascender)).join(" ")
      : objectFillPath(o, ascender)).trim();
    if (!d) continue;
    contours.forEach((c) => contourExtents(c, ascender, ext));
    parts.push(`<path d="${d}" fill="#111111" fill-rule="nonzero"/>`);
  }
  if (!parts.length || !Number.isFinite(ext.x0)) return null;
  const x = ext.x0 - pad, y = ext.y0 - pad;
  const w = Math.max(1, ext.x1 - ext.x0 + pad * 2), h = Math.max(1, ext.y1 - ext.y0 + pad * 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" data-seru-clip="${id}" data-seru-origin="font" viewBox="${f2(x)} ${f2(y)} ${f2(w)} ${f2(h)}" width="${f2(w)}" height="${f2(h)}">\n${parts.join("\n")}\n</svg>\n`;
}

/* ---------------- salin ---------------- */

/**
 * Panggil SETELAH `copySelection()` / `cutSelection()`: membaca clipboard internal Font, membuat SVG-nya,
 * menulis ke clipboard sistem, dan mengirimnya ke tab Design.
 */
export function publishFontClip(): void {
  const s = useAppStore.getState();
  const objs = s.clipboard;
  if (!objs || objs.length === 0) return;
  const id = newId();
  const svg = objectsToSvg(objs, s.metrics.ascender, id);
  internal = { id, ts: Date.now() };
  if (!svg) return;
  lastFont = { id, ts: internal.ts, svg };
  try { void navigator.clipboard?.writeText(svg).catch(() => undefined); } catch { /* tanpa izin */ }
  try { designWin?.postMessage({ type: MSG, from: "font", id, ts: internal.ts, svg }, window.location.origin); } catch { /* iframe belum siap */ }
}

/** salin lalu publikasikan (tombol Salin) */
export function copyAndPublish(): void {
  useAppStore.getState().copySelection();
  publishFontClip();
}
export function cutAndPublish(): void {
  useAppStore.getState().cutSelection();
  publishFontClip();
}

/* ---------------- tempel ---------------- */

async function readClipboardText(): Promise<string> {
  try {
    const c = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!c || typeof c.readText !== "function") return "";
    return await c.readText();
  } catch {
    return "";
  }
}

/** Tempel cerdas (Cmd/Ctrl+V, tombol Paste): clipboard sistem → salinan Design → clipboard internal Font. */
export async function pasteSmart(): Promise<void> {
  const s = useAppStore.getState();
  const markup = extractSvgMarkup(await readClipboardText());
  if (markup) {
    const id = markerId(markup);
    if (id && id === internal.id && (s.clipboard?.length ?? 0) > 0) { s.pasteClipboard(); return; } // salinan Font sendiri
    if (id && external && id === external.id) { if (pasteSvgMarkup(external.svg)) return; }       // dari Design (versi outline)
    else if (pasteSvgMarkup(markup)) return;                                                         // SVG dari aplikasi lain
  }
  // clipboard sistem tidak terbaca / bukan SVG: pakai yang paling baru antara Design dan Font
  if (external && external.ts > internal.ts && pasteSvgMarkup(external.svg)) return;
  s.pasteClipboard();
}

/**
 * Tempel dari tombol (iPad / Android): urutan "internal dulu" supaya tidak memunculkan gelembung izin clipboard
 * sistem di setiap ketukan — salinan Design yang lebih baru, lalu salinan Font, baru clipboard sistem.
 */
export async function pasteFromButton(): Promise<void> {
  const s = useAppStore.getState();
  if (external && external.ts > internal.ts && pasteSvgMarkup(external.svg)) return;
  if (s.clipboard?.length) { s.pasteClipboard(); return; }
  await pasteSvgFromSystemClipboard();
}

/** apakah ada sesuatu yang bisa ditempel tanpa membaca clipboard sistem */
export const hasBridgeClip = () => !!external;

/* ---------------- koneksi dengan iframe Design ---------------- */

export function registerDesignFrame(win: Window | null): void {
  designWin = win;
}

/** pasang pendengar pesan dari iframe Design (sekali) */
let started = false;
export function initSeruBridge(): () => void {
  if (started) return () => undefined;
  started = true;
  const onMessage = (e: MessageEvent) => {
    if (e.origin !== window.location.origin) return;
    const d = e.data as { type?: string; from?: string; id?: string; ts?: number; svg?: string } | null;
    if (!d) return;
    if (d.type === MSG && d.from === "design" && typeof d.svg === "string" && d.id) {
      external = { id: d.id, ts: d.ts ?? Date.now(), svg: d.svg };
    } else if (d.type === "seru:hello" && lastFont) {
      try { (e.source as Window | null)?.postMessage({ type: MSG, from: "font", ...lastFont }, window.location.origin); } catch { /* abaikan */ }
    }
  };
  window.addEventListener("message", onMessage);
  return () => { window.removeEventListener("message", onMessage); started = false; };
}
