import { useEffect } from "react";
import { useAppStore } from "@/glyph/store";
import type { ToolId } from "@/types/tool";
import { copyAndPublish, cutAndPublish, pasteSmart } from "@/lib/seruBridge";
import { getOrderedChars } from "@/glyph/defaultGlyphs";
import { DRAW_CHAR } from "@/glyph/drawMode";

const KEY_TO_TOOL: Record<string, ToolId> = {
  v: "select", p: "pen", y: "pencil", b: "brush", n: "node", h: "hand", z: "zoom",
};

/**
 * Moves to the next/previous glyph in the same order GlyphNav/GlyphStepper/
 * GlyphSideNav already use, so the keyboard shortcut always lands on
 * whatever the UI's own Prev/Next arrows would.
 */
function stepGlyph(direction: 1 | -1) {
  const s = useAppStore.getState();
  // Drawing Mode: the canvas stays on the scratch sketch glyph (DRAW_CHAR),
  // so stepping must move the drawing TARGET instead — exactly what
  // GlyphStepper's Prev/Next do — skipping the scratch glyph itself.
  // Stepping from activeChar here used to always start from DRAW_CHAR.
  const drawMode = s.editorMode === "draw";
  const ordered = drawMode
    ? getOrderedChars(s.glyphs).filter((ch) => ch !== DRAW_CHAR)
    : getOrderedChars(s.glyphs);
  const current = drawMode ? s.drawTargetChar : s.activeChar;
  const idx = current === null ? -1 : ordered.indexOf(current);
  // No target yet in Drawing Mode: "next" picks the first glyph, like
  // GlyphStepper's enabled Next button does from that state.
  if (idx < 0) {
    if (drawMode && direction === 1 && ordered.length > 0) s.setActiveChar(ordered[0]);
    return;
  }
  const nextIdx = idx + direction;
  if (nextIdx < 0 || nextIdx >= ordered.length) return;
  s.setActiveChar(ordered[nextIdx]);
}

const ARROW_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/** Global shortcuts: tools, undo/redo, clipboard, and object delete/nudge. */
export function useKeyboardShortcuts() {
  useEffect(() => {
    // Holding an arrow key auto-repeats a nudge many times per second; each
    // used to be its own undo step, flooding history. The first nudge of a
    // press opens a glyph-edit bracket and releasing the key (or leaving the
    // window) closes it, so one press-and-hold is one undo step.
    let nudgeBracketOpen = false;
    const endNudgeBracket = () => {
      if (!nudgeBracketOpen) return;
      nudgeBracketOpen = false;
      useAppStore.getState().endGlyphEdit();
    };
    const nudge = (dx: number, dy: number) => {
      const s = useAppStore.getState();
      if (!nudgeBracketOpen) {
        nudgeBracketOpen = true;
        s.beginGlyphEdit();
      }
      s.nudgeSelectedObjects(dx, dy);
    };

    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName;
      const inputType = tagName === "INPUT"
        ? ((target as HTMLInputElement).type || "text").toLowerCase()
        : "";
      // NumericInput (Stroke Width, Brush Size, Stabilizer's "direct input"
      // box, etc.) renders `<input type="number">` and keeps focus after
      // you drag or type a value. It was being treated the same as a real
      // text field here, so — since `textEditing` short-circuits the
      // handler below — every single-key tool shortcut (B/P/V/…) silently
      // did nothing right after touching any numeric field, until you
      // clicked the canvas to steal focus back. That's the reported
      // "kayak ngebug, kaya terhalang" behavior. A number input can't even
      // accept a letter keystroke in the first place (the browser blocks
      // it), so there's no real text-editing conflict — it belongs in the
      // same bucket as "range" below, not with free-text fields.
      const textEditing = Boolean(
        target?.isContentEditable ||
        tagName === "TEXTAREA" ||
        (tagName === "INPUT" && !["range", "number", "checkbox", "radio", "button", "submit", "reset", "file"].includes(inputType))
      );
      const formControl = tagName === "SELECT" || tagName === "INPUT" || tagName === "TEXTAREA";

      // Range/select controls in the right panel retain focus after a
      // setting is changed. They are not text editors, so Cmd/Ctrl+Z must
      // still reach FontSeru's document history without requiring a tool
      // switch first. Real text fields keep the browser's native undo.
      if (textEditing) return;

      const s = useAppStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      // Test Lab / Kerning overlay owns keyboard input while open (its own
      // letter-key shortcuts, arrow nudges, etc. would collide with the
      // main canvas' tool shortcuts below) — EXCEPT undo/redo, which must
      // keep working everywhere in the app, including while the overlay is
      // open, since edits made there (kerning drags, tracking, auto-space)
      // are themselves part of the same undo stack.
      if (s.testLabOpen) {
        if (mod) {
          const k = e.key.toLowerCase();
          if (k === "z") { e.preventDefault(); e.shiftKey ? s.redo() : s.undo(); return; }
          if (k === "y") { e.preventDefault(); s.redo(); return; }
        }
        return;
      }

      // Arrow-key nudge and Delete/Backspace have real native meaning
      // inside a focused form control (moving a range slider, deleting a
      // digit in a number field), so THOSE must stay blocked while one is
      // focused — but that's a different concern from the letter-key tool
      // shortcuts (B/P/V/N/H/Z/Y) below, which no form control does
      // anything with. The old code returned early for ANY plain key
      // whenever a form control had focus, which is what actually broke
      // "klik B/P/V gak ganti tool": switching tools stopped working the
      // moment you'd touched a slider/stepper, until you clicked back on
      // the canvas to steal focus away first. Only guard the keys that
      // genuinely collide with a form control's own behavior.
      const formControlNativeKey =
        formControl && !mod &&
        ["Delete", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key);
      if (formControlNativeKey) return;

      // Next/Prev glyph — Tab / Shift+Tab, matching the Prev/Next chevrons
      // in GlyphSideNav & GlyphStepper. Works regardless of tool so it never
      // collides with ArrowLeft/Right (used below to nudge a selection).
      if (e.key === "Tab" && !mod) {
        e.preventDefault();
        stepGlyph(e.shiftKey ? -1 : 1);
        return;
      }

      if (mod) {
        const k = e.key.toLowerCase();
        if (k === "z") { e.preventDefault(); e.shiftKey ? s.redo() : s.undo(); return; }
        if (k === "y") { e.preventDefault(); s.redo(); return; }
        if (k === "c") { e.preventDefault(); copyAndPublish(); return; }
        if (k === "x") { e.preventDefault(); cutAndPublish(); return; }
        if (k === "v") { e.preventDefault(); void pasteSmart(); return; }
        if (k === "d") {
          if (s.selectedObjectIds.length > 0) { e.preventDefault(); s.copySelection(); s.pasteClipboard(); }
          return;
        }
        if (k === "a") { e.preventDefault(); s.selectAllObjects(); return; }
        if (k === "g") { e.preventDefault(); s.groupSelectedObjects(); return; }
        if (k === "u") { e.preventDefault(); s.ungroupSelectedObjects(); return; }
        return;
      }

      if (s.tool === "select") {
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); s.deleteSelectedObjects(); return; }
        const step = e.shiftKey ? 10 : 1;
        if (e.key === "ArrowLeft") { e.preventDefault(); nudge(-step, 0); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); nudge(step, 0); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); nudge(0, step); return; }
        if (e.key === "ArrowDown") { e.preventDefault(); nudge(0, -step); return; }
      }

      const tool = KEY_TO_TOOL[e.key.toLowerCase()];
      if (tool) {
        s.setTool(tool);
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (ARROW_KEYS.includes(e.key)) endNudgeBracket();
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", endNudgeBracket);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", endNudgeBracket);
      endNudgeBracket();
    };
  }, []);
}
