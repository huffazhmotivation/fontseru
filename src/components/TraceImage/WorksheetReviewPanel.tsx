import { useMemo, useState } from "react";
import { ArrowLeft, CheckSquare, Layers, Square, Wand2, XCircle } from "lucide-react";
import type { FontMetrics } from "@/types/font";
import type { GlyphMap } from "@/types/glyph";
import { GlyphThumbnail } from "@/components/GlyphThumbnail";
import { objectsPreviewGlyph } from "@/components/TraceImage/previewGlyph";
import type { WorksheetCellResult, WorksheetDetectionResult } from "@/worksheet/types";

interface WorksheetReviewPanelProps {
  result: WorksheetDetectionResult;
  metrics: FontMetrics;
  regularGlyphs: GlyphMap;
  onImport: (cells: WorksheetCellResult[]) => void;
  onDiscard: () => void;
  /** Cancels the worksheet flow entirely and returns Trace Image to its empty starting state (same as removing the image and picking a new one) — for "gajadi, balik ke awal" rather than switching to manual mode with the same image. */
  onBack: () => void;
}

/**
 * Shown in place of the manual dropzone/canvas whenever `detectWorksheet`
 * confidently recognizes the uploaded file as a FontSeru worksheet. Every
 * cell it lists here already carries fully-traced/extracted `VectorObject`s
 * (see `WorksheetCellResult`) — this panel never re-traces anything, it
 * only lets the user review + choose which detected cells to commit.
 * Committing reuses the exact same `fitTracedObjectsToGlyph` +
 * `commitTracedGlyphOutline` path the manual apply button already uses.
 */
export function WorksheetReviewPanel({ result, metrics, regularGlyphs, onImport, onDiscard, onBack }: WorksheetReviewPanelProps) {
  const detectedCells = useMemo(() => result.cells.filter((c) => c.status === "detected"), [result.cells]);
  const missingCells = useMemo(() => result.cells.filter((c) => c.status === "missing"), [result.cells]);

  const [checked, setChecked] = useState<Set<number>>(
    () => new Set(detectedCells.map((c) => c.slot.index))
  );

  function toggle(index: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function selectAll() {
    setChecked(new Set(detectedCells.map((c) => c.slot.index)));
  }
  function selectNone() {
    setChecked(new Set());
  }

  const selectedCells = detectedCells.filter((c) => checked.has(c.slot.index));

  return (
    <div className="fm-worksheet-panel" data-testid="worksheet-review-panel">
      <div className="fm-worksheet-summary">
        <div className="fm-worksheet-summary-head">
          <span className="fm-panel-eyebrow">
            <Layers size={12} /> Worksheet Terdeteksi
          </span>
        </div>
        <div className="fm-worksheet-summary-line">
          <strong>{result.template.name}</strong>
          <span className="fm-hint">
            {detectedCells.length} sel terisi · {missingCells.length} sel kosong (Missing)
          </span>
        </div>
        <span className="fm-hint fm-worksheet-note">
          Setiap huruf ditentukan murni dari posisinya di grid (kotak ke-berapa → huruf apa) — tidak ada kode/tag yang perlu terbaca sama sekali.
        </span>
        {result.warnings.length > 0 && (
          <ul className="fm-worksheet-warnings">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="fm-worksheet-toolbar">
        <button type="button" className="fm-trace-import-svg-btn" onClick={selectAll} data-testid="worksheet-select-all">
          <CheckSquare size={14} /> Pilih Semua
        </button>
        <button type="button" className="fm-trace-import-svg-btn" onClick={selectNone} data-testid="worksheet-select-none">
          <Square size={14} /> Kosongkan Pilihan
        </button>
        <div className="fm-spacer" />
        <button type="button" className="fm-trace-filename-reset" onClick={onDiscard} data-testid="worksheet-discard">
          <XCircle size={12} /> Bukan worksheet, gunakan manual
        </button>
      </div>

      <div className="fm-worksheet-grid" data-testid="worksheet-grid">
        {result.cells.map((cell) => {
          const isMissing = cell.status === "missing";
          const isChecked = checked.has(cell.slot.index);
          const preview = !isMissing ? objectsPreviewGlyph(cell.objects, metrics) : null;
          const targetExists = Boolean(regularGlyphs[cell.slot.char]);
          return (
            <label
              key={cell.slot.index}
              className={`fm-worksheet-cell ${isMissing ? "missing" : ""} ${isChecked ? "checked" : ""}`}
              data-testid={`worksheet-cell-${cell.slot.index}`}
              title={isMissing ? `“${cell.slot.char}” — sel kosong, dilewati` : `“${cell.slot.char}”`}
            >
              <input
                type="checkbox"
                checked={isChecked && !isMissing}
                disabled={isMissing || !targetExists}
                onChange={() => toggle(cell.slot.index)}
              />
              <span className="fm-worksheet-cell-thumb">
                {isMissing ? <span className="fm-worksheet-cell-missing">—</span> : preview && <GlyphThumbnail glyph={preview} />}
              </span>
              <span className="fm-worksheet-cell-char">{cell.slot.char}</span>
              {isMissing && <span className="fm-worksheet-cell-status">Missing</span>}
            </label>
          );
        })}
      </div>

      <div className="fm-trace-apply-bar" data-testid="worksheet-import-bar">
        <button type="button" className="fm-worksheet-back-btn" onClick={onBack} data-testid="worksheet-back-btn" title="Kembali ke Trace Image">
          <ArrowLeft size={14} /> Kembali
        </button>
        <div className="fm-trace-apply-info">
          <span className="fm-hint fm-trace-apply-hint">
            {selectedCells.length} dari {detectedCells.length} sel terdeteksi dipilih untuk diimpor.
          </span>
        </div>
        <button
          type="button"
          className="fm-action-btn"
          disabled={detectedCells.length === 0}
          onClick={() => onImport(detectedCells)}
          data-testid="worksheet-import-all-btn"
        >
          <Wand2 size={14} /> Import Semua
        </button>
        <button
          type="button"
          className="fm-action-btn accent"
          disabled={selectedCells.length === 0}
          onClick={() => onImport(selectedCells)}
          data-testid="worksheet-import-selected-btn"
        >
          <Wand2 size={14} /> Import Terpilih ({selectedCells.length})
        </button>
      </div>
    </div>
  );
}
