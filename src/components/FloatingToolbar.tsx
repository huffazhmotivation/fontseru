import { Fragment, useEffect, useRef, useState } from "react";
import { MousePointer2, Paintbrush, Spline, PenTool, Pencil, Hand, ZoomIn, Image, Lock, Shapes, Square, Circle, Triangle } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { useAuth } from "@/auth/AuthProvider";
import type { ToolConfig } from "@/types/tool";
import type { ShapeKind } from "@/editor/shapeBuilder";

// Floating toolbar order (left → right):
// Home → Select → Node → Pen → Pencil → Shape → Brush → Trace Image → Zoom → Hand
// Pencil sits immediately to the right of Pen — Shape's popover button is
// injected right after Pencil (not Pen) so it never wedges itself between
// the two.
// Eraser / Import remain implemented (used elsewhere / kept for future
// phases) but are intentionally not shown in this toolbar.
const GROUPS: ToolConfig[][] = [
  [{ id: "home", label: "Home", key: "", phase: 1 }],
  [
    { id: "select", label: "Select", key: "V", phase: 1 },
    { id: "node", label: "Node", key: "N", phase: 2 },
    { id: "pen", label: "Pen", key: "P", phase: 2 },
    { id: "pencil", label: "Pencil", key: "Y", phase: 2 },
    { id: "brush", label: "Brush", key: "B", phase: 3 },
  ],
  [
    { id: "zoom", label: "Zoom", key: "Z", phase: 1 },
    { id: "hand", label: "Hand", key: "H", phase: 1 },
  ],
];

const ICONS = {
  select: MousePointer2,
  brush: Paintbrush,
  node: Spline,
  pen: PenTool,
  pencil: Pencil,
  hand: Hand,
  zoom: ZoomIn,
  trace: Image,
} as const;

const CURRENT_PHASE = 3;

// Tools that require a PRO plan. Brush is intentionally NOT in this set:
// per the current requirements, Brush is free/unlocked for all accounts.
const PRO_LOCKED_TOOLS = new Set<string>([]);

const SHAPE_OPTIONS: { kind: ShapeKind; label: string; icon: typeof Square }[] = [
  { kind: "rectangle", label: "Rectangle", icon: Square },
  { kind: "ellipse", label: "Ellipse", icon: Circle },
  { kind: "polygon", label: "Polygon", icon: Triangle },
];

/**
 * Floating toolbar's Shape tool: a single button that pops a small bar of
 * Rectangle / Ellipse / Polygon choices above it. Picking one sets
 * `shapeKind` and switches to the "shape" tool in one step; the popup
 * closes on selection or on any outside click. Re-clicking the main
 * button while the "shape" tool is already active reopens the popup so
 * the kind can be changed without leaving the tool.
 */
function ShapeToolButton() {
  const tool = useAppStore((s) => s.tool);
  const shapeKind = useAppStore((s) => s.shapeKind);
  const setShapeKind = useAppStore((s) => s.setShapeKind);
  const setTool = useAppStore((s) => s.setTool);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [open]);

  const active = tool === "shape";
  const ActiveIcon = SHAPE_OPTIONS.find((o) => o.kind === shapeKind)?.icon ?? Shapes;

  return (
    <div className="fm-shape-tool-wrap" ref={wrapRef}>
      {open && (
        <div className="fm-shape-popover" role="menu" aria-label="Choose shape">
          {SHAPE_OPTIONS.map(({ kind, label, icon: OptIcon }) => (
            <button
              key={kind}
              type="button"
              className={`fm-shape-popover-btn ${shapeKind === kind && active ? "active" : ""}`}
              onClick={() => {
                setShapeKind(kind);
                setTool("shape");
                setOpen(false);
              }}
              data-testid={`shape-kind-${kind}`}
              aria-label={label}
              title={label}
            >
              <OptIcon size={17} strokeWidth={1.7} />
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className={`fm-tool ${active ? "active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        data-testid="tool-shape"
        aria-label="Shape"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <ActiveIcon size={18} strokeWidth={1.7} />
        <span className="fm-tool-tip">Shape</span>
      </button>
    </div>
  );
}

export function FloatingToolbar() {
  const tool = useAppStore((s) => s.tool);
  const setTool = useAppStore((s) => s.setTool);
  const openTrace = useAppStore((s) => s.openTrace);
  const openProModal = useAppStore((s) => s.openProModal);
  const { isPro } = useAuth();

  // Bug: after clicking a tool button, that button keeps DOM focus. If the
  // active tool then changes some other way — a keyboard shortcut (see
  // useKeyboardShortcuts), or the editor auto-switching back to Select
  // after finishing a shape/path — nothing ever moves that stale focus
  // away. The old button still shows its `:focus-visible` accent ring
  // *and* the real active tool shows its own filled `.active` state, so
  // two icons look "lit up" at once even though only one tool is active.
  // Whenever the active tool changes, drop focus from any floating-toolbar
  // button that isn't the one for that tool, so only the truly active
  // tool is ever highlighted.
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (
      toolbarRef.current &&
      active instanceof HTMLElement &&
      toolbarRef.current.contains(active) &&
      active.getAttribute("data-testid") !== `tool-${tool}`
    ) {
      active.blur();
    }
  }, [tool]);

  return (
    <div className="fm-floating-toolbar" data-testid="floating-toolbar" ref={toolbarRef}>
      {GROUPS.map((group, gi) => (
        <div className="fm-tool-group" key={gi}>
          {group.map((t) => {
            const Icon = t.id === "home" ? null : ICONS[t.id as keyof typeof ICONS];
            const enabled = t.phase <= CURRENT_PHASE;
            const locked = PRO_LOCKED_TOOLS.has(t.id) && !isPro;
            return (
              <Fragment key={t.id}>
                <button
                  className={`fm-tool ${tool === t.id ? "active" : ""} ${locked ? "fm-tool-locked" : ""}`}
                  disabled={!enabled}
                  onClick={() => {
                    if (!enabled) return;
                    if (locked) { openProModal("brush"); return; }
                    setTool(t.id);
                  }}
                  data-testid={`tool-${t.id}`}
                >
                  {t.id === "home" ? (
  <span
    className="fm-home-tool-icon"
    aria-hidden="true"
  />
) : Icon ? (
  <Icon size={18} strokeWidth={1.7} />
) : null}
                  {locked && (
                    <span className="fm-tool-lock-badge" aria-hidden="true">
                      <Lock size={9} strokeWidth={2.4} />
                    </span>
                  )}
                  <span className="fm-tool-tip">{t.label}{t.key ? ` · ${t.key}` : ""}{!enabled ? " (soon)" : locked ? " (PRO)" : ""}</span>
                </button>
                {t.id === "pencil" && gi === 1 && <ShapeToolButton />}
              </Fragment>
            );
          })}
          {gi === 1 && (
            <button
              key="trace"
              type="button"
              className="fm-tool"
              onClick={() => openTrace()}
              data-testid="tool-trace"
              aria-label="Trace Image"
            >
              <Image size={18} strokeWidth={1.7} />
              <span className="fm-tool-tip">Trace Image</span>
            </button>
          )}
          {gi < GROUPS.length - 1 && <div className="fm-toolbar-divider" />}
        </div>
      ))}
    </div>
  );
}
