import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type InputHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

type NativeNumberProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange">;

export interface NumericInputProps extends NativeNumberProps {
  value: number;
  onChange: (value: number) => void;
  showStepper?: boolean;
}

type StepperDrag = {
  pointerId: number;
  startY: number;
  appliedDragSteps: number;
};

export const NumericInput = forwardRef<HTMLInputElement, NumericInputProps>(function NumericInput(
  { value, onChange, showStepper = true, className = "", readOnly, disabled, onBlur, ...props },
  forwardedRef
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<StepperDrag | null>(null);
  useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement);
  // While the field holds text that isn't a complete number yet — emptied
  // to retype, or a lone "-" / "1e" mid-entry (a number input reports all of
  // those as "") — keep showing exactly that instead of committing it.
  // Number("") is 0, so the old handler silently committed 0 the moment the
  // field was cleared (moving a node to 0, zeroing a stroke width…). And as
  // a controlled number input, React would otherwise snap the box straight
  // back to the previous value, making "-12" impossible to type. Any valid
  // number clears the draft so the controlled value (with any clamping the
  // owner applies) is displayed again.
  const [draft, setDraft] = useState<string | null>(null);

  const parseCommitted = (raw: string): number | null => {
    if (raw.trim() === "") return null;
    const next = Number(raw);
    return Number.isFinite(next) ? next : null;
  };

  const commitDomValue = () => {
    const next = parseCommitted(inputRef.current?.value ?? "");
    setDraft(null);
    if (next !== null) onChange(next);
  };

  const stepBy = (direction: 1 | -1, amount = 1) => {
    const input = inputRef.current;
    if (!input || disabled || readOnly || amount <= 0) return;

    try {
      direction > 0 ? input.stepUp(amount) : input.stepDown(amount);
      commitDomValue();
    } catch {
      // `stepUp`/`stepDown` are unavailable for step="any". Fall back to a
      // numeric delta while preserving min/max constraints.
      const rawStep = Number(input.step);
      const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 1;
      const min = input.min === "" ? -Infinity : Number(input.min);
      const max = input.max === "" ? Infinity : Number(input.max);
      const current = Number(input.value);
      if (!Number.isFinite(current)) return;
      const next = Math.min(max, Math.max(min, current + direction * step * amount));
      input.value = String(next);
      commitDomValue();
    }
  };

  const dragStepsForDistance = (distancePx: number) => {
    const distance = Math.max(0, Math.abs(distancePx) - 3);
    if (distance === 0) return 0;

    // Small movement stays precise; larger movement accelerates naturally.
    const magnitude = Math.floor(Math.pow(distance / 6, 1.22));
    return Math.sign(distancePx) * magnitude;
  };

  const beginStepperDrag = (
    e: ReactPointerEvent<HTMLButtonElement>,
    direction: 1 | -1
  ) => {
    if (disabled || readOnly || e.button !== 0) return;
    e.preventDefault();

    // A normal click changes the value immediately, without requiring the
    // numeric input to be focused first.
    stepBy(direction);

    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      appliedDragSteps: 0,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  // Pointermove fires far more often than the browser can actually paint
  // (100-200+/sec). Some `onChange` handlers wired to this input are cheap
  // (a plain setState), but others aren't — e.g. a Kerning Group value
  // commits a full class→pair materialization pass AND a full store
  // update/undo-history push on every call. Calling onChange straight from
  // the raw pointermove event forced that expensive path to run on every
  // single pixel of drag, which is what made dragging a Kerning Group
  // value (and anything else using this same stepper) feel heavy and
  // stuttery. Coalescing to one onChange per animation frame — the same
  // pattern already used for the kerning-glyph and side-rail drags — keeps
  // the drag feeling just as responsive while capping the commit rate to
  // the screen's actual refresh rate.
  const pendingTargetStepsRef = useRef(0);
  const dragRafRef = useRef<number | null>(null);

  const flushStepperDrag = () => {
    dragRafRef.current = null;
    const drag = dragRef.current;
    if (!drag) return;
    const target = pendingTargetStepsRef.current;
    const deltaSteps = target - drag.appliedDragSteps;
    if (deltaSteps === 0) return;
    stepBy(deltaSteps > 0 ? 1 : -1, Math.abs(deltaSteps));
    drag.appliedDragSteps = target;
  };

  const moveStepperDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();

    // Up = positive / increase, down = negative / decrease.
    pendingTargetStepsRef.current = dragStepsForDistance(drag.startY - e.clientY);
    if (dragRafRef.current === null) {
      dragRafRef.current = requestAnimationFrame(flushStepperDrag);
    }
  };

  const endStepperDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (dragRafRef.current !== null) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }
    // Flush whatever movement was still pending before tearing the drag
    // down, so the final pointer position is never dropped by the throttle.
    flushStepperDrag();
    dragRef.current = null;
    inputRef.current?.focus({ preventScroll: true });
  };

  return (
    <span className="fm-numeric-control">
      <input
        {...props}
        ref={inputRef}
        type="number"
        className={className}
        value={draft ?? value}
        readOnly={readOnly}
        disabled={disabled}
        onChange={(e) => {
          const next = parseCommitted(e.target.value);
          if (next === null) {
            setDraft(e.target.value);
            return;
          }
          setDraft(null);
          onChange(next);
        }}
        onBlur={(e) => {
          // Leaving the field with an incomplete entry restores the real value.
          setDraft(null);
          onBlur?.(e);
        }}
      />
      {showStepper && !readOnly && (
        <span className="fm-numeric-stepper" aria-hidden="false">
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onPointerDown={(e) => beginStepperDrag(e, 1)}
            onPointerMove={moveStepperDrag}
            onPointerUp={endStepperDrag}
            onPointerCancel={endStepperDrag}
            aria-label="Increase value"
          >
            <ChevronUp size={11} strokeWidth={2.25} aria-hidden="true" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onPointerDown={(e) => beginStepperDrag(e, -1)}
            onPointerMove={moveStepperDrag}
            onPointerUp={endStepperDrag}
            onPointerCancel={endStepperDrag}
            aria-label="Decrease value"
          >
            <ChevronDown size={11} strokeWidth={2.25} aria-hidden="true" />
          </button>
        </span>
      )}
    </span>
  );
});
