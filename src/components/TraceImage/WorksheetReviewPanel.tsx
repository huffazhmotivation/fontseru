import { useMemo, useState } from "react";
import { CheckCircle2, CircleDashed, FileCode2, ImagePlus, Wand2 } from "lucide-react";
import type { Glyph } from "@/types/glyph";
import type { FontMetrics } from "@/types/font";
import { fitTracedObjectsToGlyph } from "@/trace/imageTrace";
import { GlyphThumbnail } from "@/components/GlyphThumbnail";
import type { WorksheetCellResult, WorksheetDetectionResult } from "@/worksheet/detectWorksheet";

const PREVIEW_ADVANCE = 600;

/** Throwaway preview Glyph wrapping one cell's traced objects, purely for GlyphThumbnail — mirrors the equivalent local helper in TraceImageOverlay.tsx (kept as its own small copy for the same reason that one is: this panel should never risk touching the main overlay's behavior). */
function cellPreviewGlyph(cell: WorksheetCellResult, metrics: FontMetrics): Glyph | null {
  if (cell.objects.length === 0) return null;
  const outline = fitTracedObjectsToGlyph(cell.objects, metrics, PREVIEW_ADVANCE);
  return { char: cell.char, unicode: 0, category: "symbols", advanceWidth: PREVIEW_ADVANCE, lsb: 0, rsb: 0, outline, components: [] };
}

interface WorksheetReviewPanelProps {
  result: WorksheetDetectionResult;
  metrics: FontMetrics;
  /** Called with the cell ids to actually commit to the font. */
  onImport: (cellIds: number[]) => void;
  /** Bails out of worksheet mode entirely, back to the normal manual Trace Image / Import SVG flow for the same file. */
  onUseManualMode: () => void;
}

export function WorksheetReviewPanel({ result, metrics, onImport, onUseManualMode }: WorksheetReviewPanelProps) {
  const detectedCells = useMemo(() => result.cells.filter((c) => c.status !== "missing"), [result.cells]);
  const missingCount = result.cells.length - detectedCells.length;

  const [selected, setSelected] = useState<Set<number>>(() => new Set(detectedCells.map((c) => c.cellId)));

  const previews = useMemo(() => {
    const map = new Map<number, Glyph | null>();
    for (const cell of result.cells) map.set(cell.cellId, cellPreviewGlyph(cell, metrics));
    return map;
  }, [result.cells, metrics]);

  function toggle(cellId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cellId)) next.delete(cellId);
      else next.add(cellId);
      return next;
    });
  }

  return (
    <div className="fm-worksheet-panel" data-testid="worksheet-review-panel">
      <div className="fm-worksheet-panel-head">
        <span className="fm-panel-eyebrow">
          {result.source === "svg" ? <FileCode2 size={12} /> : <ImagePlus size={12} />} Worksheet Terdeteksi
        </span>
        <span className="fm-hint">
          {result.templateLabel} — {detectedCells.length} sel terisi, {missingCount} sel kosong (dilewati).
        </span>
      </div>

      <div className="fm-worksheet-grid" data-testid="worksheet-grid">
        {result.cells.map((cell) => {
          const preview = previews.get(cell.cellId);
          const isMissing = cell.status === "missing";
          const isChecked = selected.has(cell.cellId);
          return (
            <label
              key={cell.cellId}
              className={`fm-worksheet-cell ${isMissing ? "missing" : ""} ${isChecked ? "checked" : ""}`}
              data-testid={`worksheet-cell-${cell.cellId}`}
              title={isMissing ? `“${cell.char}” — sel kosong, dilewati` : `“${cell.char}”`}
            >
              <input
                type="checkbox"
                checked={isChecked}
                disabled={isMissing}
                onChange={() => toggle(cell.cellId)}
                data-testid={`worksheet-cell-check-${cell.cellId}`}
              />
              <span className="fm-worksheet-cell-thumb">
                {preview ? <GlyphThumbnail glyph={preview} /> : <CircleDashed size={14} strokeWidth={1.4} />}
              </span>
              <span className="fm-worksheet-cell-char">{cell.char}</span>
              {!isMissing && <CheckCircle2 size={12} className="fm-worksheet-cell-badge" />}
            </label>
          );
        })}
      </div>

      <div className="fm-worksheet-panel-actions">
        <button type="button" className="fm-action-btn" onClick={onUseManualMode} data-testid="worksheet-manual-fallback">
          Gunakan mode manual
        </button>
        <div className="fm-spacer" />
        <button
          type="button"
          className="fm-action-btn"
          disabled={detectedCells.length === 0}
          onClick={() => onImport(detectedCells.map((c) => c.cellId))}
          data-testid="worksheet-import-all"
        >
          Import Semua ({detectedCells.length})
        </button>
        <button
          type="button"
          className="fm-action-btn accent"
          disabled={selected.size === 0}
          onClick={() => onImport(Array.from(selected))}
          data-testid="worksheet-import-selected"
        >
          <Wand2 size={14} />
          Import Terpilih ({selected.size})
        </button>
      </div>
    </div>
  );
}
