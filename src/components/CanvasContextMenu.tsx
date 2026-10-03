import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Copy, Clipboard, CopyPlus, Trash2, Expand } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { copyAndPublish, pasteFromButton, hasBridgeClip } from "@/lib/seruBridge";
import { FlipIcon } from "./icons/FlipIcon";

export interface CanvasMenuPos {
  x: number;
  y: number;
}

const EDGE = 8;

/**
 * Right-click (PC) / long-press (tablet) menu for the glyph canvases. Every
 * action reuses the store actions the Right Panel and Sketch toolbar already
 * call, and acts on the current object selection of the active glyph (the
 * canvases select the object under the pointer before opening this).
 *
 * Rendered through a portal into `.fm-root` (not document.body) so it keeps the
 * theme CSS variables, and uses `position: fixed` so it follows the pointer
 * regardless of the canvas' own transforms.
 */
export function CanvasContextMenu({ pos, onClose }: { pos: CanvasMenuPos; onClose: () => void }) {
  const selectedObjectIds = useAppStore((s) => s.selectedObjectIds);
  const selectedNodes = useAppStore((s) => s.selectedNodes);
  const clipboard = useAppStore((s) => s.clipboard);
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const copySelection = useAppStore((s) => s.copySelection);
  const pasteClipboard = useAppStore((s) => s.pasteClipboard);
  const flipSelectedObjects = useAppStore((s) => s.flipSelectedObjects);
  const deleteSelectedObjects = useAppStore((s) => s.deleteSelectedObjects);
  const deleteSelectedNodes = useAppStore((s) => s.deleteSelectedNodes);
  const expandSelectedStrokes = useAppStore((s) => s.expandSelectedStrokes);

  const ref = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);

  const hasSelection = selectedObjectIds.length > 0;
  const hasNodes = selectedNodes.length > 0;
  const canPaste = !!(clipboard && clipboard.length > 0) || hasBridgeClip();
  const canExpand = !!glyph && glyph.outline.objects.some(
    (o) => selectedObjectIds.includes(o.id) && (o.kind === "line" || o.kind === "brush")
  );

  // Keep the menu fully inside the viewport (flip left/up near the edges).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(EDGE, Math.min(pos.x, window.innerWidth - w - EDGE));
    const top = Math.max(EDGE, Math.min(pos.y, window.innerHeight - h - EDGE));
    setPlaced({ left, top });
  }, [pos.x, pos.y]);

  // Dismiss on outside press, Escape, scroll/zoom/resize or switching glyph.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onClose, { passive: true });
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const first = useRef(activeChar);
  useEffect(() => { if (activeChar !== first.current) onClose(); }, [activeChar, onClose]);

  const run = (fn: () => void) => () => { fn(); onClose(); };

  const item = (key: string, icon: ReactNode, label: string, action: () => void, disabled = false, danger = false) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      className={`fm-ctx-item ${danger ? "danger" : ""}`}
      disabled={disabled}
      onClick={run(action)}
      data-testid={`ctx-${key}`}
    >
      <span className="fm-ctx-icon">{icon}</span>
      <span>{label}</span>
    </button>
  );

  const menu = (
    <div
      ref={ref}
      className="fm-ctx-menu"
      role="menu"
      data-testid="canvas-context-menu"
      style={{ left: placed?.left ?? pos.x, top: placed?.top ?? pos.y, visibility: placed ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {item("copy", <Copy size={15} />, "Copy", () => copyAndPublish(), !hasSelection)}
      {item("paste", <Clipboard size={15} />, "Paste", () => void pasteFromButton(), !canPaste)}
      {item("duplicate", <CopyPlus size={15} />, "Duplicate", () => { copySelection(); pasteClipboard(); }, !hasSelection)}
      <div className="fm-ctx-sep" />
      {item("flip-h", <FlipIcon direction="horizontal" size={15} />, "Flip Horizontal", () => flipSelectedObjects("horizontal"), !hasSelection)}
      {item("flip-v", <FlipIcon direction="vertical" size={15} />, "Flip Vertical", () => flipSelectedObjects("vertical"), !hasSelection)}
      <div className="fm-ctx-sep" />
      {item("expand", <Expand size={15} />, "Expand Stroke", () => expandSelectedStrokes(), !canExpand)}
      {item(
        "delete",
        <Trash2 size={15} />,
        hasNodes ? "Delete Node" : "Delete",
        () => (hasNodes ? deleteSelectedNodes() : deleteSelectedObjects()),
        !hasSelection && !hasNodes,
        true
      )}
    </div>
  );

  const host = (typeof document !== "undefined" && document.querySelector(".fm-root")) || document.body;
  return createPortal(menu, host);
}
