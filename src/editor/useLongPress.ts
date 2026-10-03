import { useCallback, useEffect, useRef } from "react";

/** How long a finger/pen must stay down before it counts as a long-press. */
export const LONG_PRESS_MS = 520;
/** Movement (CSS px) that turns a press into a drag and cancels the long-press. */
const MOVE_TOLERANCE_PX = 10;

interface PressPoint {
  clientX: number;
  clientY: number;
  pointerId: number;
}

/**
 * Touch / pen long-press detector for the canvases. Mouse input is ignored on
 * purpose — on a PC the same menu is opened with the right mouse button
 * (`contextmenu` event). Call `begin` on pointerdown, `move` on pointermove and
 * `cancel` on pointerup/cancel; `onLongPress` fires once if the pointer stayed
 * (almost) still for LONG_PRESS_MS.
 */
export function useLongPress(onLongPress: (clientX: number, clientY: number) => void) {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<PressPoint | null>(null);
  const cbRef = useRef(onLongPress);
  cbRef.current = onLongPress;

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  const begin = useCallback(
    (e: PressPoint & { pointerType: string }) => {
      cancel();
      if (e.pointerType === "mouse") return;
      startRef.current = { clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId };
      timerRef.current = window.setTimeout(() => {
        const s = startRef.current;
        timerRef.current = null;
        startRef.current = null;
        if (s) cbRef.current(s.clientX, s.clientY);
      }, LONG_PRESS_MS);
    },
    [cancel]
  );

  const move = useCallback(
    (e: PressPoint) => {
      const s = startRef.current;
      if (!s || s.pointerId !== e.pointerId) return;
      if (Math.hypot(e.clientX - s.clientX, e.clientY - s.clientY) > MOVE_TOLERANCE_PX) cancel();
    },
    [cancel]
  );

  useEffect(() => cancel, [cancel]);

  return { begin, move, cancel };
}
