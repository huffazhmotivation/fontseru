import { useEffect } from "react";
import { useAppStore } from "@/glyph/store";
import type { ToolId } from "@/types/tool";
import { pasteSvgFromSystemClipboard } from "@/trace/svgImport";
import { getOrderedChars } from "@/glyph/defaultGlyphs";

const KEY_TO_TOOL: Record<string, ToolId> = {
  v: "select", p: "pen", y: "pencil", b: "brush", n: "node", h: "hand", z: "zoom",
};

/**
 * Cmd/Ctrl+V handler. Tries the OS clipboard first for pasted vector art
 * (Affinity Designer, Illustrator, and similar apps write the copied shape
 * to the system clipboard as SVG) and only falls back to FontSeru's own
 * internal object clipboard when there's nothing usable there — so copying
 * inside FontSeru and copying from another vector app both just work with
 * the same shortcut.
 */
async function handlePasteShortcut() {
  const pastedExternalVector = await pasteSvgFromSystemClipboard();
  if (!pastedExternalVector) {
    useAppStore.getState().pasteClipboard();
  }
}

/**
 * Moves to the next/previous glyph in the same order GlyphNav/GlyphStepper/
 * GlyphSideNav already use, so the keyboard shortcut always lands on
 * whatever the UI's own Prev/Next arrows would.
 */
function stepGlyph(direction: 1 | -1) {
  const s = useAppStore.getState();
  const ordered = getOrderedChars(s.glyphs);
  const idx = ordered.indexOf(s.activeChar);
  const nextIdx = idx + direction;
  if (idx < 0 || nextIdx < 0 || nextIdx >= ordered.length) return;
  s.setActiveChar(ordered[nextIdx]);
}

/** Global shortcuts: tools, undo/redo, clipboard, and object delete/nudge. */
export function useKeyboardShortcuts() {
  useEffect(() => {
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
      if (s.testLabOpen) return; // Test Lab / Kerning overlay owns keyboard input while open
      const mod = e.metaKey || e.ctrlKey;

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
        if (k === "c") { e.preventDefault(); s.copySelection(); return; }
        if (k === "x") { e.preventDefault(); s.cutSelection(); return; }
        if (k === "v") { e.preventDefault(); void handlePasteShortcut(); return; }
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
        if (e.key === "ArrowLeft") { e.preventDefault(); s.nudgeSelectedObjects(-step, 0); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); s.nudgeSelectedObjects(step, 0); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); s.nudgeSelectedObjects(0, step); return; }
        if (e.key === "ArrowDown") { e.preventDefault(); s.nudgeSelectedObjects(0, -step); return; }
      }

      const tool = KEY_TO_TOOL[e.key.toLowerCase()];
      if (tool) {
        s.setTool(tool);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
