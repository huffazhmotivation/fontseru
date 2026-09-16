import { memo, useMemo } from "react";
import { LayoutGrid, Square, Minus, Plus, X } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { GLYPH_FILTERS, OVERVIEW_SPACING_MAX, OVERVIEW_SPACING_MIN, OVERVIEW_ZOOM_MAX, OVERVIEW_ZOOM_MIN } from "@/types/glyphView";
import type { GlyphFilterId } from "@/types/glyphView";
import { countDrawnGlyphs, filterGlyphChars } from "@/editor/glyphFilter";

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
  const filter = useAppStore((s) => s.overviewFilter);
  const setOverviewFilter = useAppStore((s) => s.setOverviewFilter);
  const query = useAppStore((s) => s.overviewQuery);
  const setOverviewQuery = useAppStore((s) => s.setOverviewQuery);
  const zoom = useAppStore((s) => s.overviewZoom);
  const setOverviewZoom = useAppStore((s) => s.setOverviewZoom);
  const spacing = useAppStore((s) => s.overviewSpacing);
  const setOverviewSpacing = useAppStore((s) => s.setOverviewSpacing);
  const glyphs = useAppStore((s) => s.glyphs);
  const selectedGlyphChars = useAppStore((s) => s.selectedGlyphChars);
  const clearGlyphSelection = useAppStore((s) => s.clearGlyphSelection);

  const multi = editorMode === "multi";

  // Counts shown in the bar. Both are derived on the fly from the live
  // glyph map — nothing is cached or mirrored into state, so the "n jadi"
  // readout can never fall out of sync with what has actually been drawn.
  const shownCount = useMemo(
    () => (multi ? filterGlyphChars(glyphs, filter, selectedGlyphChars, query).length : 0),
    [multi, glyphs, filter, selectedGlyphChars, query]
  );
  const drawnCount = useMemo(() => (multi ? countDrawnGlyphs(glyphs) : 0), [multi, glyphs]);

  return (
    <div className="fm-glyphview-bar" data-testid="glyph-view-bar" data-mode={editorMode}>
      <div className="fm-glyphview-switch" role="group" aria-label="Glyph view mode">
        <button
          type="button"
          className={!multi ? "on" : ""}
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
          title="Multi Glyph Mode — lihat semua glyph dalam satu canvas"
          data-testid="glyph-view-multi"
        >
          <LayoutGrid size={13} /> Multi
        </button>
      </div>

      {multi && (
        <>
          <div className="fm-glyphview-divider" />

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

          <label className="fm-glyphview-field fm-glyphview-slider">
            <span>Zoom</span>
            <button
              type="button"
              className="fm-icon-btn"
              onClick={() => setOverviewZoom(zoom - 10)}
              title="Perkecil"
            >
              <Minus size={12} />
            </button>
            <input
              type="range"
              min={OVERVIEW_ZOOM_MIN}
              max={OVERVIEW_ZOOM_MAX}
              step={5}
              value={zoom}
              onChange={(e) => setOverviewZoom(Number(e.target.value))}
              data-testid="glyph-view-zoom"
              style={{
                ["--fm-range-fill" as string]: `${((zoom - OVERVIEW_ZOOM_MIN) / (OVERVIEW_ZOOM_MAX - OVERVIEW_ZOOM_MIN)) * 100}%`,
              }}
            />
            <button
              type="button"
              className="fm-icon-btn"
              onClick={() => setOverviewZoom(zoom + 10)}
              title="Perbesar"
            >
              <Plus size={12} />
            </button>
          </label>

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
        </>
      )}
    </div>
  );
}

export const GlyphViewBar = memo(GlyphViewBarInner);
