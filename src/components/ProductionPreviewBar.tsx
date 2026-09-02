import { AlignCenter, AlignLeft, AlignRight, X } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { GlyphRun } from "@/editor/GlyphRun";
import { sentenceForCategory } from "@/glyph/testSentences";

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

  if (!open) return null;

  const category = glyphs[activeChar]?.category;
  const text = sentenceForCategory(category);

  return (
    <div className="fm-preview-bar" data-testid="production-preview-bar">
      <div
        className="fm-preview-stage"
        style={{
          justifyContent: align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center",
          lineHeight,
        }}
      >
        <GlyphRun text={text} fontSizePx={scale} ghostEmpty />
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

        <button className="fm-icon-btn fm-preview-close" onClick={toggle} title="Hide preview" data-testid="preview-close">
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
