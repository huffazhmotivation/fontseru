import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AlignCenter, AlignLeft, AlignRight, Ampersand, CaseLower, CaseUpper, Hash, Quote, Wand2, X } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { GlyphRun } from "@/editor/GlyphRun";
import { wrapLines } from "@/editor/textLayout";
import { sentenceForCategory } from "@/glyph/testSentences";
import type { GlyphCategory } from "@/types/glyph";
import { SunIcon, MoonIcon } from "@/components/icons/ThemeIcon";

/** Small icon toggles for the categories that actually have a preset
 * sentence (see sentenceForCategory) — spacing/multilingual/feature glyphs
 * fall back to the uppercase pangram so they don't get a button here. */
const CATEGORY_OPTIONS: { id: GlyphCategory; label: string; Icon: typeof CaseUpper }[] = [
  { id: "upper", label: "Uppercase", Icon: CaseUpper },
  { id: "lower", label: "Lowercase", Icon: CaseLower },
  { id: "digits", label: "Numbers", Icon: Hash },
  { id: "punct", label: "Punctuation", Icon: Quote },
  { id: "symbols", label: "Symbols", Icon: Ampersand },
];

/**
 * Lightweight, always-in-place preview shown while drawing glyphs — one
 * sentence, rendered in the font as it stands right now, sitting between
 * the canvas and BottomBar. Unlike Test Lab (a full overlay meant for
 * deliberate testing/kerning work), this has exactly one job: let you see
 * the letter you're drawing in context without leaving the canvas.
 *
 * Fully controlled by `productionPreviewOpen` in the store — closed by
 * default, toggled from the "Preview" button in BottomBar, and unmounts
 * its content entirely (not just visually collapsed) when closed so it
 * costs nothing while off.
 */
export function ProductionPreviewBar() {
  const open = useAppStore((s) => s.productionPreviewOpen);
  const toggle = useAppStore((s) => s.toggleProductionPreview);
  const scale = useAppStore((s) => s.productionPreviewScale);
  const setScale = useAppStore((s) => s.setProductionPreviewScale);
  const lineHeight = useAppStore((s) => s.productionPreviewLineHeight);
  const setLineHeight = useAppStore((s) => s.setProductionPreviewLineHeight);
  const align = useAppStore((s) => s.productionPreviewAlign);
  const setAlign = useAppStore((s) => s.setProductionPreviewAlign);
  const activeChar = useAppStore((s) => s.activeChar);
  const glyphs = useAppStore((s) => s.glyphs);
  const category = useAppStore((s) => s.productionPreviewCategory);
  const setCategory = useAppStore((s) => s.setProductionPreviewCategory);
  const stageHeight = useAppStore((s) => s.productionPreviewHeight);
  const setStageHeight = useAppStore((s) => s.setProductionPreviewHeight);
  const metrics = useAppStore((s) => s.metrics);
  const kerningPairs = useAppStore((s) => s.kerningPairs);

  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [isResizingPreview, setIsResizingPreview] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(0);
  // Independent from the app's global theme — same pattern Test Lab uses
  // for its own "Preview Background" toggle: starts matching whatever the
  // app looks like right now, but doesn't keep following it afterward, and
  // flipping it here doesn't touch the app's real theme either. Lets you
  // check a letter against both a light and dark backdrop without leaving
  // the canvas or committing to a full app theme switch.
  const [bg, setBg] = useState<"dark" | "light">(() => useAppStore.getState().theme);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => setStageWidth(Math.max(1, el.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  if (!open) return null;

  const activeCategory = category === "auto" ? glyphs[activeChar]?.category : category;
  const text = sentenceForCategory(activeCategory);

  // Wrap to the box's own width so enlarging the glyph scale grows the
  // preview downward (more lines) instead of forcing sideways scrolling.
  const pxPerUnit = scale / metrics.unitsPerEm;
  const maxWidthUnits = Math.max(1, (stageWidth || 720) / Math.max(pxPerUnit, 0.0001));
  const lines = wrapLines(text, glyphs, metrics.unitsPerEm, kerningPairs, 0, maxWidthUnits, metrics.wordSpacing);

  function startResize(e: ReactPointerEvent) {
    e.preventDefault();
    resizeRef.current = { startY: e.clientY, startHeight: stageHeight };
    setIsResizingPreview(true);
    // Lock the cursor and stop stray text selection for the whole drag,
    // not just while hovering the thin handle strip — otherwise fast drags
    // that briefly leave the handle snap the cursor back and forth.
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    const onMove = (ev: PointerEvent) => {
      if (!resizeRef.current) return;
      const delta = ev.clientY - resizeRef.current.startY;
      setStageHeight(resizeRef.current.startHeight + delta);
    };
    const onUp = () => {
      resizeRef.current = null;
      setIsResizingPreview(false);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div className="fm-preview-bar" data-testid="production-preview-bar">
      <div
        className={`fm-preview-resize-handle${isResizingPreview ? " active" : ""}`}
        onPointerDown={startResize}
        title="Drag to resize preview"
        data-testid="preview-resize-handle"
      >
        <span className="fm-preview-resize-grip" aria-hidden="true" />
      </div>

      <div className={`fm-preview-stage ${bg}`} ref={stageRef} style={{ height: stageHeight }}>
        <div
          className="fm-preview-lines"
          style={{
            alignItems: align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center",
          }}
        >
          {lines.map((line, i) => (
            <div
              key={i}
              className="fm-preview-line"
              style={{ marginTop: i > 0 ? scale * (lineHeight - 1) : 0 }}
            >
              <GlyphRun text={line.text || " "} fontSizePx={scale} ghostEmpty className="fm-preview-glyphrun" />
            </div>
          ))}
        </div>
      </div>

      <div className="fm-preview-controls">
        <div className="fm-inline-field" title="Letter scale">
          <span>Scale</span>
          <input
            type="range"
            min={10}
            max={120}
            step={1}
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            data-testid="preview-scale-slider"
          />
          <span className="fm-preview-value">{scale}px</span>
        </div>

        <div className="fm-inline-field" title="Line spacing">
          <span>Spacing</span>
          <input
            type="range"
            min={0.8}
            max={3}
            step={0.05}
            value={lineHeight}
            onChange={(e) => setLineHeight(Number(e.target.value))}
            data-testid="preview-line-height-slider"
          />
          <span className="fm-preview-value">{lineHeight.toFixed(2)}x</span>
        </div>

        <div className="fm-preview-category-group" role="group" aria-label="Preview text">
          <button
            className={category === "auto" ? "on" : ""}
            onClick={() => setCategory("auto")}
            title="Auto (follow the letter you're drawing)"
            data-testid="preview-category-auto"
          >
            <Wand2 size={13} />
          </button>
          {CATEGORY_OPTIONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={category === id ? "on" : ""}
              onClick={() => setCategory(id)}
              title={label}
              data-testid={`preview-category-${id}`}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>

        <div className="fm-preview-align-group" role="group" aria-label="Alignment">
          <button
            className={align === "left" ? "on" : ""}
            onClick={() => setAlign("left")}
            title="Align left"
            data-testid="preview-align-left"
          >
            <AlignLeft size={13} />
          </button>
          <button
            className={align === "center" ? "on" : ""}
            onClick={() => setAlign("center")}
            title="Align center"
            data-testid="preview-align-center"
          >
            <AlignCenter size={13} />
          </button>
          <button
            className={align === "right" ? "on" : ""}
            onClick={() => setAlign("right")}
            title="Align right"
            data-testid="preview-align-right"
          >
            <AlignRight size={13} />
          </button>
        </div>

        <button
          className="fm-icon-btn"
          onClick={() => setBg(bg === "dark" ? "light" : "dark")}
          title={bg === "dark" ? "Switch preview to light background" : "Switch preview to dark background"}
          data-testid="preview-bg-toggle"
        >
          {bg === "dark" ? <MoonIcon size={13} /> : <SunIcon size={13} />}
        </button>

        <button className="fm-icon-btn fm-preview-close" onClick={toggle} title="Hide preview" data-testid="preview-close">
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
