import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

interface TouchPt { x: number; y: number; }

interface SketchGestureOptions {
  /** Gate: gestures are only recognized while Sketch Mode is on, so normal
   * mode's pointer handling is completely untouched. */
  enabled: boolean;
  /** Reuses GlyphCanvas's existing zoom-toward-point implementation. */
  applyZoomAt: (newZoom: number, clientX: number, clientY: number) => void;
  getZoom: () => number;
  onUndo: () => void;
  onRedo: () => void;
  /** Cancels any single-finger stroke/drag in progress when a second finger
   * lands, so a pinch never leaves a stray brush mark. */
  onCancelActive: () => void;
  /** 2-finger drag = pan. Called with the frame-to-frame movement of the
   * touch midpoint, in screen pixels; the consumer converts that to its own
   * pan/scale space (reuses GlyphCanvas's existing hand-pan math). */
  onPanBy: (dxClient: number, dyClient: number) => void;
}

const TAP_MAX_MS = 400;
const TAP_MAX_MOVE = 14; // px, in screen space
/** Telapak tangan menyentuh layar dengan area kontak besar; jari normal jauh di bawah ini (px CSS). */
const PALM_CONTACT_PX = 40;
/** Tolak sentuhan selama pena ada di dekat layar (hover Apple Pencil) — telapak biasanya mendarat SEBELUM ujung pena. */
const PEN_NEAR_MS = 500;
/** Tolak sentuhan sebentar setelah pena diangkat (telapak sering masih menempel). */
const PEN_RELEASE_MS = 900;

/**
 * Sketch Mode multi-touch gestures, layered on top of the existing pointer
 * pipeline without changing it: pinch-to-zoom, 2-finger tap = Undo,
 * 3-finger tap = Redo, and simple palm rejection (touch is ignored while a
 * pen is down / just lifted). Consumers call handlePointer* first inside
 * their existing handlers; a `true` return means the event was consumed by
 * a gesture and the normal tool logic for that event should be skipped.
 */
export function useSketchGestures(options: SketchGestureOptions) {
  const { enabled, getZoom, onUndo, onRedo, onCancelActive } = options;
  // Callback terbaru lewat ref: pinch/geser dihitung di requestAnimationFrame, dan closure lamanya
  // (skala `sc` yang usang) membuat geser 2 jari melenceng.
  const applyZoomAtRef = useRef(options.applyZoomAt);
  const onPanByRef = useRef(options.onPanBy);
  applyZoomAtRef.current = options.applyZoomAt;
  onPanByRef.current = options.onPanBy;
  const penNearUntil = useRef(0);
  const rafId = useRef<number | null>(null);
  useEffect(() => () => { if (rafId.current !== null) cancelAnimationFrame(rafId.current); }, []);
  const pointers = useRef<Map<number, TouchPt>>(new Map());
  const tapStart = useRef<Map<number, TouchPt>>(new Map());
  const penActiveRef = useRef(false);
  const penReleaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinchStartDist = useRef<number | null>(null);
  const pinchStartZoom = useRef(100);
  const tapCandidate = useRef<{ count: number; startTime: number; moved: boolean } | null>(null);
  /** Last frame's 2-finger midpoint, in screen space; used to derive the
   * per-frame pan delta for 2-finger-drag panning. Reset whenever the
   * 2-finger gesture (re)starts so a fresh drag doesn't jump. */
  const panMid = useRef<TouchPt | null>(null);

  const dist = (a: TouchPt, b: TouchPt) => Math.hypot(a.x - b.x, a.y - b.y);
  const midpoint = (a: TouchPt, b: TouchPt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const resetGesture = useCallback(() => {
    pointers.current.clear();
    tapStart.current.clear();
    tapCandidate.current = null;
    pinchStartDist.current = null;
    panMid.current = null;
    if (rafId.current !== null) { cancelAnimationFrame(rafId.current); rafId.current = null; }
  }, []);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent | PointerEvent): boolean => {
      if (!enabled) return false;

      if (e.pointerType === "pen") {
        penActiveRef.current = true;
        penNearUntil.current = Date.now() + PEN_NEAR_MS;
        if (penReleaseTimer.current) { clearTimeout(penReleaseTimer.current); penReleaseTimer.current = null; }
        // Telapak yang sudah terlanjur menyentuh sebelum pena mendarat: batalkan coretan/geser dari sentuhan itu.
        if (pointers.current.size > 0) { resetGesture(); onCancelActive(); }
        return false; // pen always draws normally
      }
      if (e.pointerType !== "touch") return false; // mouse: untouched

      // Palm rejection: while a pen is down, hovering close, or just lifted, ignore touch input entirely
      // rather than letting a resting palm draw or gesture. A big contact patch is a palm, not a fingertip.
      if (penActiveRef.current || Date.now() < penNearUntil.current) return true;
      if ((e.width ?? 0) >= PALM_CONTACT_PX || (e.height ?? 0) >= PALM_CONTACT_PX) return true;

      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      tapStart.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const n = pointers.current.size;

      if (n === 1) return false; // single finger: draw/pan/select as usual

      if (n === 2 || n === 3) {
        onCancelActive();
        tapCandidate.current = { count: n, startTime: Date.now(), moved: false };
        if (n === 2) {
          const pts = [...pointers.current.values()];
          pinchStartDist.current = dist(pts[0], pts[1]);
          pinchStartZoom.current = getZoom();
          panMid.current = midpoint(pts[0], pts[1]);
        } else {
          panMid.current = null; // 3rd finger landed: stop panning, it's a redo-tap candidate
        }
        return true;
      }
      return true; // 4+ fingers: ignore
    },
    [enabled, getZoom, onCancelActive, resetGesture]
  );

  /** Terapkan pinch + geser 2 jari SEKALI per frame dari posisi jari terbaru. Urutan: geser dulu (titik yang tadi di
   * tengah jari ikut pindah), baru zoom di titik tengah yang sekarang. */
  const applyGestureFrame = useCallback(() => {
    rafId.current = null;
    if (pointers.current.size !== 2 || !pinchStartDist.current) return;
    const pts = [...pointers.current.values()];
    const mid = midpoint(pts[0], pts[1]);
    if (panMid.current) onPanByRef.current(mid.x - panMid.current.x, mid.y - panMid.current.y);
    panMid.current = mid;
    const ratio = dist(pts[0], pts[1]) / pinchStartDist.current;
    applyZoomAtRef.current(pinchStartZoom.current * ratio, mid.x, mid.y);
  }, []);

  /**
   * Catat posisi tiap pointer SEGERA di setiap event (murah). Canvas hanya meneruskan event terakhir per frame
   * ke handlePointerMove, padahal dua jari mengirim event bergantian — tanpa pencatatan ini jari yang satunya
   * "basi" dan pinch/geser tersendat. Juga menandai pena yang melayang (hover) untuk palm rejection.
   */
  const trackMove = useCallback(
    (e: ReactPointerEvent | PointerEvent) => {
      if (!enabled) return;
      if (e.pointerType === "pen") { penNearUntil.current = Date.now() + PEN_NEAR_MS; return; }
      if (e.pointerType !== "touch" || !pointers.current.has(e.pointerId)) return;
      const pt = { x: e.clientX, y: e.clientY };
      pointers.current.set(e.pointerId, pt);
      const start = tapStart.current.get(e.pointerId);
      if (start && tapCandidate.current && dist(start, pt) > TAP_MAX_MOVE) tapCandidate.current.moved = true;
      if (pointers.current.size === 2 && pinchStartDist.current && rafId.current === null) {
        rafId.current = requestAnimationFrame(applyGestureFrame);
      }
    },
    [enabled, applyGestureFrame]
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent | PointerEvent): boolean => {
      if (!enabled) return false;
      if (e.pointerType !== "touch") return false;
      if (!pointers.current.has(e.pointerId)) return false;
      trackMove(e);
      return pointers.current.size >= 2;
    },
    [enabled, trackMove]
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent | PointerEvent): boolean => {
      if (!enabled) return false;

      if (e.pointerType === "pen") {
        // Keep rejecting touch briefly after the pen lifts, since a resting
        // palm often lingers a moment past pen-up.
        if (penReleaseTimer.current) clearTimeout(penReleaseTimer.current);
        penReleaseTimer.current = setTimeout(() => { penActiveRef.current = false; }, PEN_RELEASE_MS);
        return false;
      }
      if (e.pointerType !== "touch") return false;

      const wasTracked = pointers.current.has(e.pointerId);
      pointers.current.delete(e.pointerId);
      tapStart.current.delete(e.pointerId);

      if (!wasTracked) return true; // was a rejected/ignored touch

      if (pointers.current.size === 0) {
        const tap = tapCandidate.current;
        if (tap && !tap.moved && Date.now() - tap.startTime < TAP_MAX_MS) {
          if (tap.count === 2) onUndo();
          else if (tap.count === 3) onRedo();
        }
        tapCandidate.current = null;
        pinchStartDist.current = null;
        panMid.current = null;
      } else if (pointers.current.size === 2) {
        // Dropped from 3 fingers back to 2 (e.g. a redo-tap finger lifted
        // first): re-baseline pinch/pan against the two remaining fingers
        // so the next move doesn't jump using stale start values.
        const pts = [...pointers.current.values()];
        pinchStartDist.current = dist(pts[0], pts[1]);
        pinchStartZoom.current = getZoom();
        panMid.current = midpoint(pts[0], pts[1]);
      } else {
        // Down to 1 (or 0) fingers: stop panning/pinching cleanly.
        panMid.current = null;
        pinchStartDist.current = null;
      }
      return true;
    },
    [enabled, onUndo, onRedo, getZoom]
  );

  return { handlePointerDown, handlePointerMove, handlePointerUp, trackMove, resetGesture };
}
