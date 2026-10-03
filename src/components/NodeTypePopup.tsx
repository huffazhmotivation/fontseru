import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore, type NodeRef } from "@/glyph/store";
import { findNode, retypeNodes } from "@/editor/nodeOps";
import type { NodeType } from "@/types/geometry";

export interface NodePopupState {
  x: number;
  y: number;
  ref: NodeRef;
}

const OPTIONS: { type: NodeType; label: string; hint: string }[] = [
  { type: "corner", label: "Corner", hint: "Sudut tajam, handle bebas" },
  { type: "smooth", label: "Smooth", hint: "Kurva halus, handle sejajar" },
  { type: "symmetric", label: "Symmetric", hint: "Handle sejajar & sama panjang" },
];

function TypeGlyph({ type }: { type: NodeType }) {
  // Tiny pictograms: a node square/circle with its handle lines.
  return (
    <svg viewBox="0 0 28 18" width="28" height="18" fill="none" aria-hidden="true">
      {type === "corner" && (
        <>
          <path d="M3 15 L12 4" stroke="currentColor" strokeWidth="1.3" opacity="0.55" />
          <path d="M12 4 L24 12" stroke="currentColor" strokeWidth="1.3" opacity="0.55" />
          <rect x="10" y="2" width="4.4" height="4.4" fill="currentColor" />
        </>
      )}
      {type === "smooth" && (
        <>
          <path d="M3 13 L22 5" stroke="currentColor" strokeWidth="1.3" opacity="0.55" />
          <circle cx="9" cy="10.7" r="1.6" fill="currentColor" opacity="0.6" />
          <circle cx="17" cy="7.3" r="1.6" fill="currentColor" opacity="0.6" />
          <circle cx="13" cy="9" r="2.7" fill="currentColor" />
        </>
      )}
      {type === "symmetric" && (
        <>
          <path d="M4 14 L24 4" stroke="currentColor" strokeWidth="1.3" opacity="0.55" />
          <circle cx="7" cy="12.5" r="1.6" fill="currentColor" opacity="0.6" />
          <circle cx="21" cy="5.5" r="1.6" fill="currentColor" opacity="0.6" />
          <rect x="11.6" y="7.6" width="4.8" height="4.8" rx="2.4" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/**
 * Small popup that appears right after a node is clicked in the Node tool:
 * pick Corner / Smooth / Symmetric. Applies to the whole node selection when
 * the clicked node is part of it, otherwise to the clicked node only — one
 * undo step, same `retypeNodes` the Right Panel buttons use.
 */
export function NodeTypePopup({ popup, onClose }: { popup: NodePopupState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const tool = useAppStore((s) => s.tool);
  const selectedNodes = useAppStore((s) => s.selectedNodes);
  const commitOutline = useAppStore((s) => s.commitOutline);

  const clicked = glyph ? findNode(glyph.outline, popup.ref.contourId, popup.ref.nodeId) : null;
  const inSelection = selectedNodes.some((r) => r.contourId === popup.ref.contourId && r.nodeId === popup.ref.nodeId);
  const targets: NodeRef[] = inSelection ? selectedNodes : [popup.ref];

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 16;
    let left = popup.x - w / 2;
    let top = popup.y + gap;
    // Not enough room below the finger/cursor -> open above it instead.
    if (top + h > window.innerHeight - 8) top = popup.y - h - gap;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(8, top);
    setPlaced({ left, top });
  }, [popup.x, popup.y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);

  // Leaving the Node tool / switching glyph / losing the node closes it.
  useEffect(() => {
    if (tool !== "node" || !clicked) onClose();
  }, [tool, clicked, activeChar, onClose]);

  if (!glyph || !clicked) return null;

  const apply = (type: NodeType) => {
    commitOutline(activeChar, retypeNodes(glyph.outline, targets, type), { skipAutoSpacing: true });
    onClose();
  };

  const node = (
    <div
      ref={ref}
      className="fm-nodepop"
      role="menu"
      aria-label="Jenis node"
      data-testid="node-type-popup"
      style={{ left: placed?.left ?? popup.x, top: placed?.top ?? popup.y, visibility: placed ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="fm-nodepop-title">
        Jenis node{targets.length > 1 ? ` (${targets.length})` : ""}
      </div>
      <div className="fm-nodepop-row">
        {OPTIONS.map((o) => (
          <button
            key={o.type}
            type="button"
            role="menuitemradio"
            aria-checked={clicked.type === o.type}
            className={`fm-nodepop-btn ${clicked.type === o.type ? "on" : ""}`}
            onClick={() => apply(o.type)}
            title={o.hint}
            data-testid={`node-type-${o.type}`}
          >
            <TypeGlyph type={o.type} />
            <span>{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  const host = (typeof document !== "undefined" && document.querySelector(".fm-root")) || document.body;
  return createPortal(node, host);
}
