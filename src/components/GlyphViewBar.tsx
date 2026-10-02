import { memo, useMemo } from "react";
import { LayoutGrid, Square, Minus, Plus, X, Maximize2, PenLine, Eraser, Wand2, GripHorizontal } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { GLYPH_FILTERS, MULTI_COLUMNS_MAX, MULTI_ZOOM_MAX, MULTI_ZOOM_MIN, OVERVIEW_SPACING_MAX, OVERVIEW_SPACING_MIN } from "@/types/glyphView";
import type { GlyphFilterId } from "@/types/glyphView";
import { countDrawnGlyphs, filterGlyphChars } from "@/editor/glyphFilter";
import { DRAW_CHAR } from "@/glyph/drawMode";
import { GlyphThumbnail } from "./GlyphThumbnail";
import { DRAWING_DRAG_TYPE } from "./drawingDrag";

/**
 * The zoom slider is logarithmic: the multi canvas spans roughly 8%–4000%
 * so you can hold the whole alphabet on screen at one end and place a
 * single node precisely at the other. A linear slider over that range
 * would spend most of its travel in zoom levels nobody uses.
 */
function zoomToSlider(zoom: number): number {
  const t = (Math.log(Math.max(MULTI_ZOOM_MIN, Math.min(MULTI_ZOOM_MAX, zoom))) - Math.log(MULTI_ZOOM_MIN)) /
    (Math.log(MULTI_ZOOM_MAX) - Math.log(MULTI_ZOOM_MIN));
  return Math.round(t * 100);
}

function sliderToZoom(value: number): number {
  const t = Math.min(100, Math.max(0, value)) / 100;
  return Math.exp(Math.log(MULTI_ZOOM_MIN) + t * (Math.log(MULTI_ZOOM_MAX) - Math.log(MULTI_ZOOM_MIN)));
}

/**
 * "Glyph View" control bar — the Single ⇄ Multi switch plus the overview's
 * own Filter / Spacing / Zoom controls.
 *
 * Rendered as a floating bar at the top-center of the canvas area, next to
 * (never replacing) the existing Sketch-mode toggle at top-left and the
 * Floating Toolbar at bottom-center. In Single Mode it collapses to just
 * the two-way switch so the drawing surface stays as uncluttered as it is
 * today; the filter/spacing/zoom controls only appear in Multi Mode where
 * they mean something.
 */
function GlyphViewBarInner() {
  const editorMode = useAppStore((s) => s.editorMode);
  const setEditorMode = useAppStore((s) => s.setEditorMode);
  const drawTargetChar = useAppStore((s) => s.drawTargetChar);
  const drawClearAfterApply = useAppStore((s) => s.drawClearAfterApply);
  const setDrawClearAfterApply = useAppStore((s) => s.setDrawClearAfterApply);
  const drawApplied = useAppStore((s) => s.drawApplied);
  const applyDrawingToGlyph = useAppStore((s) => s.applyDrawingToGlyph);
  const clearDrawing = useAppStore((s) => s.clearDrawing);
  const filter = useAppStore((s) => s.overviewFilter);
  const setOverviewFilter = useAppStore((s) => s.setOverviewFilter);
  const query = useAppStore((s) => s.overviewQuery);
  const setOverviewQuery = useAppStore((s) => s.setOverviewQuery);
  // Zoom/columns/fit belong to the editable multi canvas (multiZoom is a
  // px-per-font-unit scale with a real editing range, not the overview's
  // thumbnail-size slider).
  const zoom = useAppStore((s) => s.multiZoom);
  const setMultiZoom = useAppStore((s) => s.setMultiZoom);
  const columns = useAppStore((s) => s.multiColumns);
  const setMultiColumns = useAppStore((s) => s.setMultiColumns);
  const fitMultiCanvas = useAppStore((s) => s.fitMultiCanvas);
  const spacing = useAppStore((s) => s.overviewSpacing);
  const setOverviewSpacing = useAppStore((s) => s.setOverviewSpacing);
  const glyphs = useAppStore((s) => s.glyphs);
  const selectedGlyphChars = useAppStore((s) => s.selectedGlyphChars);
  const clearGlyphSelection = useAppStore((s) => s.clearGlyphSelection);

  const multi = editorMode === "multi";
  const drawMode = editorMode === "draw";
  // The sketch itself, so the bar can show a live thumbnail of it to drag.
  const sketch = useAppStore((s) => (drawMode ? s.glyphs[DRAW_CHAR] : undefined));
  const sketchHasInk = !!sketch && sketch.outline.objects.length > 0;

  // Counts shown in the bar. Both are derived on the fly from the live
  // glyph map — nothing is cached or mirrored into state, so the "n jadi"
  // readout can never fall out of sync with what has actually been drawn.
  const shownCount = useMemo(
    () => (multi ? filterGlyphChars(glyphs, filter, selectedGlyphChars, query).length : 0),
    [multi, glyphs, filter, selectedGlyphChars, query]
  );
  const drawnCount = useMemo(() => (multi ? countDrawnGlyphs(glyphs) : 0), [multi, glyphs]);

  return (
    <>
      {/* The Single ⇄ Multi switch is anchored to the canvas's top-right
          corner, on its own, rather than riding at the head of the
          controls bar. Two reasons: it is the only control here that
          means something in BOTH modes (everything else is Multi-only),
          and pinning it to a fixed corner means it never shifts sideways
          as the bar next to it grows or shrinks — so the button you reach
          for to get back to Single is always in the same place. */}
      <div
        className="fm-glyphview-mode"
        data-testid="glyph-view-mode"
        data-mode={editorMode}
        role="group"
        aria-label="Glyph view mode"
      >
        <button
          type="button"
          className={editorMode === "single" ? "on" : ""}
          onClick={() => setEditorMode("single")}
          title="Single Glyph Mode — edit satu glyph dengan node & bezier tools"
          data-testid="glyph-view-single"
        >
          <Square size={13} /> Single
        </button>
        <button
          type="button"
          className={multi ? "on" : ""}
          onClick={() => setEditorMode("multi")}
          title="Multi Glyph Mode — gambar banyak glyph langsung di satu canvas"
          data-testid="glyph-view-multi"
        >
          <LayoutGrid size={13} /> Multi
        </button>
        <button
          type="button"
          className={drawMode ? "on" : ""}
          onClick={() => setEditorMode("draw")}
          title="Mode Drawing — gambar bebas di canvas, lalu terapkan hasilnya ke glyph mana pun. Hanya garis baseline yang tampil."
          data-testid="glyph-view-draw"
        >
          <PenLine size={13} /> Drawing
        </button>
      </div>

      {drawMode && (
        <div className="fm-glyphview-bar fm-drawbar" data-testid="glyph-view-draw-bar" data-mode={editorMode}>
          <div
            className={`fm-drawbar-thumb ${sketchHasInk ? "" : "empty"}`}
            draggable={sketchHasInk}
            onDragStart={(e) => {
              if (!sketchHasInk) { e.preventDefault(); return; }
              e.dataTransfer.effectAllowed = "copy";
              e.dataTransfer.setData(DRAWING_DRAG_TYPE, "1");
              e.dataTransfer.setData("text/plain", "fontseru-drawing");
            }}
            title={sketchHasInk ? "Seret gambar ini ke salah satu glyph di daftar glyph" : "Gambar sesuatu di canvas dulu"}
            data-testid="draw-drag-chip"
          >
            {sketchHasInk && sketch ? <GlyphThumbnail glyph={sketch} /> : <PenLine size={15} />}
            {sketchHasInk && <GripHorizontal size={11} className="fm-drawbar-grip" />}
          </div>

          <span className="fm-glyphview-count fm-drawbar-status" data-testid="draw-status">
            {!sketchHasInk
              ? "Gambar bebas di canvas"
              : drawTargetChar
                ? <>Target: <b>{drawTargetChar === " " ? "Space" : drawTargetChar}</b></>
                : "Seret ke glyph / pilih lalu Terapkan"}
          </span>

          <button
            type="button"
            className="fm-action-btn accent fm-drawbar-apply"
            disabled={!sketchHasInk || !drawTargetChar}
            onClick={() => applyDrawingToGlyph()}
            title={drawTargetChar ? `Jadikan gambar ini glyph “${drawTargetChar}”` : "Pilih glyph di daftar glyph dulu"}
            data-testid="draw-apply-btn"
          >
            <Wand2 size={13} /> Terapkan
          </button>

          <div className="fm-glyphview-divider" />

          <label className="fm-glyphview-field fm-drawbar-check" title="Kosongkan canvas setelah gambar diterapkan (bisa di-undo dengan Ctrl+Z)">
            <input
              type="checkbox"
              checked={drawClearAfterApply}
              onChange={(e) => setDrawClearAfterApply(e.target.checked)}
              data-testid="draw-clear-after-apply"
            />
            <span>Bersihkan otomatis</span>
          </label>

          <button
            type="button"
            className="fm-icon-btn"
            onClick={clearDrawing}
            disabled={!sketchHasInk}
            title="Bersihkan canvas"
            data-testid="draw-clear-btn"
          >
            <Eraser size={13} />
          </button>

          {drawApplied && (
            <span key={drawApplied.nonce} className="fm-drawbar-done" data-testid="draw-applied">
              ✓ “{drawApplied.char}”
            </span>
          )}
        </div>
      )}

      {multi && (
        <div className="fm-glyphview-bar" data-testid="glyph-view-bar" data-mode={editorMode}>
          <label className="fm-glyphview-field">
            <span>Filter</span>
            <select
              value={filter}
              onChange={(e) => setOverviewFilter(e.target.value as GlyphFilterId)}
              data-testid="glyph-view-filter"
            >
              {GLYPH_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>

          <input
            className="fm-glyphview-search"
            type="text"
            value={query}
            placeholder="Cari glyph…"
            onChange={(e) => setOverviewQuery(e.target.value)}
            data-testid="glyph-view-search"
          />

          <div className="fm-glyphview-divider" />

          <label className="fm-glyphview-field fm-glyphview-slider">
            <span>Spacing</span>
            <input
              type="range"
              min={OVERVIEW_SPACING_MIN}
              max={OVERVIEW_SPACING_MAX}
              step={1}
              value={spacing}
              onChange={(e) => setOverviewSpacing(Number(e.target.value))}
              data-testid="glyph-view-spacing"
              style={{
                ["--fm-range-fill" as string]: `${((spacing - OVERVIEW_SPACING_MIN) / (OVERVIEW_SPACING_MAX - OVERVIEW_SPACING_MIN)) * 100}%`,
              }}
            />
          </label>

          <label className="fm-glyphview-field">
            <span>Kolom</span>
            <input
              type="number"
              min={0}
              max={MULTI_COLUMNS_MAX}
              step={1}
              value={columns}
              onChange={(e) => setMultiColumns(Number(e.target.value))}
              title="Jumlah kolom grid. 0 = otomatis."
              data-testid="glyph-view-columns"
              style={{ width: 52 }}
            />
          </label>

          <label className="fm-glyphview-field fm-glyphview-slider">
            <span>Zoom</span>
            <button
              type="button"
              className="fm-icon-btn"
              onClick={() => setMultiZoom(zoom * 0.8)}
              title="Perkecil"
            >
              <Minus size={12} />
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={zoomToSlider(zoom)}
              onChange={(e) => setMultiZoom(sliderToZoom(Number(e.target.value)))}
              data-testid="glyph-view-zoom"
              style={{
                ["--fm-range-fill" as string]: `${zoomToSlider(zoom)}%`,
              }}
            />
            <button
              type="button"
              className="fm-icon-btn"
              onClick={() => setMultiZoom(zoom * 1.25)}
              title="Perbesar"
            >
              <Plus size={12} />
            </button>
          </label>

          <button
            type="button"
            className="fm-icon-btn"
            onClick={fitMultiCanvas}
            title="Pas-kan semua glyph ke layar"
            data-testid="glyph-view-fit"
          >
            <Maximize2 size={12} />
          </button>

          <div className="fm-glyphview-divider" />

          <span className="fm-glyphview-count" data-testid="glyph-view-count">
            {shownCount} tampil · {drawnCount} jadi
          </span>

          {selectedGlyphChars.length > 0 && (
            <button
              type="button"
              className="fm-glyphview-selected"
              onClick={clearGlyphSelection}
              title="Kosongkan seleksi"
              data-testid="glyph-view-clear-selection"
            >
              {selectedGlyphChars.length} dipilih <X size={11} />
            </button>
          )}
        </div>
      )}
    </>
  );
}

export const GlyphViewBar = memo(GlyphViewBarInner);
