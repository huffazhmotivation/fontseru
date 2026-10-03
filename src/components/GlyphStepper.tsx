import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { getOrderedChars } from "@/glyph/defaultGlyphs";
import { withoutDrawGlyph } from "@/glyph/drawMode";

/**
 * Minimalist Prev/Next glyph navigator for Sketch Mode. Sits just above the
 * existing bottom-center FloatingToolbar. Only rendered while Sketch Mode is
 * active — Sketch Mode already hides the glyph list sidebar, so this is the
 * stand-in way to move between glyphs without leaving the canvas. Reuses the
 * same `setActiveChar` action and glyph ordering GlyphNav already uses.
 */
export function GlyphStepper() {
  const glyphs = useAppStore((s) => s.glyphs);
  const activeChar = useAppStore((s) => s.activeChar);
  const setActiveChar = useAppStore((s) => s.setActiveChar);

  // Drawing Mode: the canvas stays on the free sketch, so the stepper picks
  // the glyph "Terapkan" will send the sketch to (the drawing target).
  const drawMode = useAppStore((s) => s.editorMode === "draw");
  const drawTargetChar = useAppStore((s) => s.drawTargetChar);
  const current = drawMode ? drawTargetChar : activeChar;

  const ordered = getOrderedChars(withoutDrawGlyph(glyphs));
  const idx = current === null ? -1 : ordered.indexOf(current);
  const canPrev = idx > 0;
  const canNext = idx < ordered.length - 1;

  const goPrev = () => { if (canPrev) setActiveChar(ordered[idx - 1]); };
  const goNext = () => { if (canNext) setActiveChar(ordered[idx + 1]); };

  return (
    <div className="fm-glyph-stepper" data-testid="glyph-stepper">
      <button
        type="button"
        className="fm-glyph-stepper-btn"
        disabled={!canPrev}
        onClick={goPrev}
        title={drawMode ? "Glyph target sebelumnya" : "Previous glyph"}
        data-testid="glyph-stepper-prev"
      >
        <ChevronLeft size={16} strokeWidth={2.1} />
      </button>
      <span className="fm-glyph-stepper-char" data-testid="glyph-stepper-char">{current === null || current === "" ? (drawMode ? "–" : current) : current}</span>
      <button
        type="button"
        className="fm-glyph-stepper-btn"
        disabled={!canNext}
        onClick={goNext}
        title={drawMode ? "Glyph target berikutnya" : "Next glyph"}
        data-testid="glyph-stepper-next"
      >
        <ChevronRight size={16} strokeWidth={2.1} />
      </button>
    </div>
  );
}
