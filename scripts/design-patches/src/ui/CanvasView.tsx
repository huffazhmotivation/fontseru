import { useEffect, useRef } from 'react';
import { useStore, getS } from '../store/store';
import { render, invalidateViewCache } from '../engine/render';
import { onDoubleClick, onPointerDown, onPointerMove, onPointerUp, onWheel, setCanvasRect } from '../tools/interaction';
import { registerCanvas } from '../tools/extra';
import { onFontLoaded, relayoutAll } from '../engine/text';
import { TextEditor } from './CanvasExtras';
import { FrameRename } from './FrameRename';
import { FloatingToolbar } from './Toolbar';
import { AIDock } from './AIDock';
import { NodeKindMenu } from './NodeKindMenu';
import { GradStopPicker } from './GradStopPicker';
import { JobFx } from './JobFx';
import { ReplaceChip } from './ReplaceChip';
import { ActionChip } from './ActionChip';
import { isSvgText, classifyClipText } from '../lib/seruBridge';
import { DRAG_TYPE, placePayload } from '../lib/drop';
import { handleFiles } from '../lib/library';
import { onImageLoaded } from '../engine/images';
import { onFxReady } from '../engine/imagefx';
import { placeSvgText } from '../lib/place';
import { zoomToFit, paste as pasteInternal } from '../engine/commands';
import type { Pt } from '../engine/geometry';
import { createTouchRouter } from '../tools/touch';
import { withVirtualMods, useTablet, tabletState } from '../store/tablet';
import { TabletModifiers } from './TabletModifiers';

export function CanvasView() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cursor = useStore((s) => s.overlay.cursor);
  const focus = useStore((s) => s.focusMode);
  const tablet = useTablet((s) => s.tablet);

  useEffect(() => {
    const el = wrap.current!;
    const cv = canvas.current!;
    registerCanvas(cv);
    let raf = 0;
    let dirty = true;
    const schedule = () => {
      dirty = true;
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (dirty) {
            dirty = false;
            render(cv);
          }
        });
    };
    /** gambar sekarang juga bila ada perubahan tertunda (dipakai setelah memproses gerakan pointer di frame yang sama) */
    const flush = () => {
      if (!dirty) return;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      dirty = false;
      render(cv);
    };
    const resize = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      cv.style.width = r.width + 'px';
      cv.style.height = r.height + 'px';
      const prev = getS().viewport;
      getS().set({ viewport: { w: r.width, h: r.height } });
      // jaga pusat pandangan saat panel dibuka/tutup
      if (getS().fitPending) {
        getS().set({ fitPending: false });
        zoomToFit();
      } else if (prev.w > 1) {
        const c = getS().camera;
        getS().set({ camera: { ...c, x: c.x + (r.width - prev.w) / 2, y: c.y + (r.height - prev.h) / 2 } });
      }
      schedule();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const unsub = useStore.subscribe((s, p) => {
      if (
        s.doc !== p.doc ||
        s.camera !== p.camera ||
        s.selection !== p.selection ||
        s.overlay !== p.overlay ||
        s.hoverId !== p.hoverId ||
        s.theme !== p.theme ||
        s.selAnchors !== p.selAnchors ||
        s.editPathId !== p.editPathId ||
        s.tool !== p.tool ||
        s.toolOpts !== p.toolOpts ||
        s.editingTextId !== p.editingTextId ||
        s.renamingFrameId !== p.renamingFrameId ||
        s.gradStop !== p.gradStop ||
        s.gradTarget !== p.gradTarget ||
        s.gradPick !== p.gradPick
      )
        schedule();
    });
    // font dimuat → hitung ulang ukuran teks & render ulang
    const relayout = () => {
      invalidateViewCache();
      const d = relayoutAll(getS().doc);
      if (d) getS().set({ doc: d });
      schedule();
    };
    document.fonts?.ready.then(relayout);
    const offFont = onFontLoaded(relayout);
    const offImg = onImageLoaded(() => {
      invalidateViewCache();
      schedule();
    });
    const offFx = onFxReady(() => {
      invalidateViewCache();
      schedule();
    });
    // tempel gambar / SVG dari clipboard sistem
    const paste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf');
      if (files.length) {
        e.preventDefault();
        e.stopImmediatePropagation();
        handleFiles(files);
        return;
      }
      const text = e.clipboardData?.getData('text/plain')?.trim() ?? '';
      if (isSvgText(text)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        // SVG salinan Design sendiri → clipboard internal (presisi penuh); selain itu (Font / aplikasi lain) → impor SVG
        if (classifyClipText(text) === 'own') {
          pasteInternal();
          return;
        }
        try {
          placeSvgText(text, 'SVG tempelan');
        } catch {
          /* bukan SVG valid */
        }
        return;
      }
      e.preventDefault();
      pasteInternal();
    };
    window.addEventListener('paste', paste, true);

    const pos = (e: MouseEvent): Pt => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const rawDown = (e: PointerEvent) => {
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* pointer sudah tidak aktif (ketukan cepat) — lanjutkan saja */
      }
      setCanvasRect(cv.getBoundingClientRect());
      flushMove();
      onPointerDown(withVirtualMods(e), pos(e));
    };
    // gerakan pointer digabung: paling banyak satu kali diproses per frame (mouse 1000Hz tidak lagi membanjiri
    // penghitungan geometri/efek), lalu kanvas digambar di frame yang sama
    let moveQ: PointerEvent[] = [];
    let moveRaf = 0;
    const runMove = () => {
      moveRaf = 0;
      const q = moveQ;
      moveQ = [];
      if (!q.length) return;
      // pensil & kuas membutuhkan setiap titik (mulus); alat lain cukup posisi terakhir di frame ini
      const t = getS().tool;
      const list = t === 'pencil' || t === 'brush' ? q : [q[q.length - 1]];
      for (const e of list) onPointerMove(withVirtualMods(e), pos(e));
      flush();
    };
    const flushMove = () => {
      if (moveRaf) cancelAnimationFrame(moveRaf);
      runMove();
    };
    const rawMove = (e: PointerEvent) => {
      moveQ.push(e);
      if (moveQ.length > 600) moveQ.splice(0, moveQ.length - 600); // jaga-jaga bila tab tertahan
      if (!moveRaf) moveRaf = requestAnimationFrame(runMove);
    };
    const rawUp = (e: PointerEvent) => {
      flushMove(); // posisi terakhir harus ikut sebelum tombol dilepas
      try {
        if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
      } catch {
        /* abaikan */
      }
      onPointerUp(withVirtualMods(e), pos(e));
    };
    // sentuhan jari: cubit zoom, ketuk 2 jari = undo, 3 jari = redo, palm rejection
    // tekan-tahan jari (tablet) = klik kanan: pilih objek di bawah jari lalu tampilkan menu konteks
    const longPress = (e: PointerEvent, p: Pt) => {
      setCanvasRect(cv.getBoundingClientRect());
      const right = new Proxy(e, {
        get(t, k) {
          if (k === 'button') return 2;
          const val = Reflect.get(t, k, t);
          return typeof val === 'function' ? val.bind(t) : val;
        },
      });
      onPointerDown(right, p); // cabang klik kanan: memilih objek di bawah titik bila belum terpilih
      getS().set({ menu: { x: p.x, y: p.y } });
    };
    const touch = createTouchRouter({ down: rawDown, move: rawMove, up: rawUp, pos, longPress });
    let lastType = '';
    // iPad/tablet: Safari sering tidak mengirim event 'dblclick' untuk ketukan jari/pen di kanvas (touch-action: none).
    // Ketuk 2x dideteksi sendiri dari pointerdown/up lalu diteruskan ke handler klik-ganda yang sama.
    const active = new Set<number>();
    let multi = false;
    let tapStart: { t: number; x: number; y: number } | null = null;
    let lastTap: { t: number; x: number; y: number } | null = null;
    let synthAt = 0;
    const TAP_MS = 380,
      TAP_MOVE = 12,
      DBL_MS = 380,
      DBL_DIST = 28;
    const down = (e: PointerEvent) => {
      lastType = e.pointerType;
      if (e.pointerType !== 'mouse') {
        active.add(e.pointerId);
        if (active.size > 1) multi = true;
        tapStart = { t: e.timeStamp, x: e.clientX, y: e.clientY };
      }
      touch.down(e);
    };
    const move = (e: PointerEvent) => touch.move(e);
    const up = (e: PointerEvent) => {
      const cancel = e.type === 'pointercancel';
      if (e.pointerType !== 'mouse' && active.has(e.pointerId)) {
        active.delete(e.pointerId);
        const wasMulti = multi;
        if (!active.size) multi = false;
        const st = tapStart;
        tapStart = null;
        const isTap = !cancel && !wasMulti && !!st && e.timeStamp - st.t < TAP_MS && Math.hypot(e.clientX - st.x, e.clientY - st.y) < TAP_MOVE;
        if (!isTap) lastTap = null;
        else if (lastTap && e.timeStamp - lastTap.t < DBL_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DBL_DIST) {
          lastTap = null;
          synthAt = e.timeStamp;
          touch.up(e, false);
          dbl(e);
          return;
        } else lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
      }
      touch.up(e, cancel);
    };
    const dbl = (e: MouseEvent | PointerEvent) => {
      // dblclick bawaan yang menyusul ketukan 2x yang sudah ditangani di atas diabaikan
      if (e.type === 'dblclick' && performance.now() - synthAt < 700) return;
      flushMove();
      onDoubleClick(pos(e));
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      flushMove();
      onWheel(e, pos(e));
    };
    const ctx = (e: MouseEvent) => {
      e.preventDefault();
      // mode tablet: menu dibuka oleh tekan-tahan singkat / chip Aksi, bukan oleh long-press bawaan browser (±0,5 detik)
      if (lastType === 'touch' && tabletState().tablet) return;
      const r = el.getBoundingClientRect();
      getS().set({ menu: { x: e.clientX - r.left, y: e.clientY - r.top } });
    };
    const leave = () => {
      flushMove();
      getS().set({ hoverId: null });
    };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('dblclick', dbl);
    cv.addEventListener('wheel', wheel, { passive: false });
    cv.addEventListener('contextmenu', ctx);
    cv.addEventListener('pointerleave', leave);
    return () => {
      ro.disconnect();
      unsub();
      offFont();
      offImg();
      offFx();
      if (moveRaf) cancelAnimationFrame(moveRaf);
      window.removeEventListener('paste', paste, true);
      registerCanvas(null);
      cancelAnimationFrame(raf);
      cv.removeEventListener('pointerdown', down);
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
      cv.removeEventListener('dblclick', dbl);
      cv.removeEventListener('wheel', wheel);
      cv.removeEventListener('contextmenu', ctx);
      cv.removeEventListener('pointerleave', leave);
      touch.dispose();
    };
  }, []);

  const onDrop = (e: React.DragEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const { camera } = getS();
    const at = { x: (e.clientX - r.left - camera.x) / camera.zoom, y: (e.clientY - r.top - camera.y) / camera.zoom };
    const payload = e.dataTransfer.getData(DRAG_TYPE);
    if (payload) {
      e.preventDefault();
      placePayload(payload, at);
      return;
    }
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      handleFiles([...e.dataTransfer.files], at);
    }
  };

  return (
    <div
      ref={wrap}
      className="absolute inset-0 overflow-hidden bg-canvas"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={onDrop}
    >
      <canvas ref={canvas} style={{ cursor, touchAction: 'none' }} className="block" aria-label="Kanvas desain" />
      <TextEditor />
      <FrameRename />
      <NodeKindMenu />
      <GradStopPicker />
      <JobFx />
      <ReplaceChip />
      <ActionChip />
      {tablet && <TabletModifiers />}
      {!focus && (
        <>
          <FloatingToolbar />
          <AIDock />
        </>
      )}
    </div>
  );
}
