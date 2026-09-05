import { Grid3x3, Ruler, Ghost, Magnet, Wand2, Maximize2, RotateCcw, Minus, Plus, Eye, AlignCenter } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { NumericInput } from "./NumericInput";

export function BottomBar() {
  const zoom = useAppStore((s) => s.zoom);
  const setZoom = useAppStore((s) => s.setZoom);
  const showGrid = useAppStore((s) => s.showGrid);
  const toggleGrid = useAppStore((s) => s.toggleGrid);
  const gridSize = useAppStore((s) => s.gridSize);
  const setGridSize = useAppStore((s) => s.setGridSize);
  const showGuides = useAppStore((s) => s.showGuides);
  const toggleGuides = useAppStore((s) => s.toggleGuides);
  const showRuler = useAppStore((s) => s.showRuler);
  const toggleRuler = useAppStore((s) => s.toggleRuler);
  const upm = useAppStore((s) => s.metrics.unitsPerEm);
  const tool = useAppStore((s) => s.tool);
  const penMode = useAppStore((s) => s.penMode);
  const lineWidth = useAppStore((s) => s.lineWidth);
  const setLineWidth = useAppStore((s) => s.setLineWidth);
  const ghost = useAppStore((s) => s.ghost);
  const setGhost = useAppStore((s) => s.setGhost);
  const snapEnabled = useAppStore((s) => s.snapEnabled);
  const toggleSnap = useAppStore((s) => s.toggleSnap);
  const autoSpacingEnabled = useAppStore((s) => s.autoSpacingEnabled);
  const setAutoSpacingEnabled = useAppStore((s) => s.setAutoSpacingEnabled);
  const productionPreviewOpen = useAppStore((s) => s.productionPreviewOpen);
  const toggleProductionPreview = useAppStore((s) => s.toggleProductionPreview);
  const fitGlyph = useAppStore((s) => s.fitGlyph);
  const resetView = useAppStore((s) => s.resetView);

  return (
    <div className="fm-bottombar" data-testid="bottom-bar">
      <div className="fm-zoom-controls">
        <button className="fm-icon-btn" onClick={() => setZoom(zoom - 10)} title="Zoom out"><Minus size={13} /></button>
        <span className="fm-zoom-value" data-testid="zoom-value">{zoom}%</span>
        <button className="fm-icon-btn" onClick={() => setZoom(zoom + 10)} title="Zoom in"><Plus size={13} /></button>
        <input type="range" min={20} max={8000} step={10} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} data-testid="zoom-slider" style={{ ["--fm-range-fill" as string]: `${((zoom - 20) / (8000 - 20)) * 100}%` }} />
      </div>

      <div className="fm-bottom-divider" />

      <button className={showGrid ? "on" : ""} onClick={toggleGrid} data-testid="toggle-grid"><Grid3x3 size={13} /> Grid</button>
      {showGrid && (
        <div className="fm-inline-field" data-testid="grid-size-field">
          <button className="fm-icon-btn" onClick={() => setGridSize(gridSize - 5)} title="Smaller grid" data-testid="grid-size-down"><Minus size={12} /></button>
          <span className="fm-grid-size-value" data-testid="grid-size-value">{gridSize}u</span>
          <button className="fm-icon-btn" onClick={() => setGridSize(gridSize + 5)} title="Larger grid" data-testid="grid-size-up"><Plus size={12} /></button>
        </div>
      )}
      <button className={showRuler ? "on" : ""} onClick={toggleRuler} data-testid="toggle-ruler" title="Tampilkan/sembunyikan ruler. Drag dari ruler untuk bikin guide garis putus-putus."><Ruler size={13} /> Ruler</button>
      <button className={showGuides ? "on" : ""} onClick={toggleGuides} data-testid="toggle-guides"><AlignCenter size={13} /> Guides</button>
      <button className={ghost.enabled ? "on" : ""} onClick={() => setGhost({ enabled: !ghost.enabled })} data-testid="toggle-ghost"><Ghost size={13} /> Ghost</button>
      <button className={snapEnabled ? "on" : ""} onClick={toggleSnap} title="Snap objects to guide lines" data-testid="toggle-snap"><Magnet size={13} /> Snap</button>
      {/* Same "Auto" toggle as Glyph Metrics' Spacing mode, mirrored here so
          it stays visible and reachable no matter which tool is active —
          previously it only showed up under the Home tool, so switching to
          Pen/Shape/Brush to actually draw hid the only place that showed
          (or let you fix) whether Auto was on. One flag, two switches. */}
      <button
        className={autoSpacingEnabled ? "on" : ""}
        onClick={() => setAutoSpacingEnabled(!autoSpacingEnabled)}
        title="Auto Metrik: posisi, LSB, RSB & advance width tiap glyph mengikuti bentuk outline-nya sendiri secara otomatis setiap kali digambar/diedit."
        data-testid="toggle-auto-metrik"
      >
        <Wand2 size={13} /> Auto Metrik
      </button>

      <button
        className={productionPreviewOpen ? "on" : ""}
        onClick={toggleProductionPreview}
        title="Tampilkan/sembunyikan preview satu kalimat pakai font yang lagi digambar"
        data-testid="toggle-production-preview"
      >
        <Eye size={13} /> Preview
      </button>

      {tool === "pen" && penMode === "line" && (
        <div className="fm-inline-field">
          <span>Width</span>
          <NumericInput min={1} max={200} value={lineWidth} onChange={setLineWidth} data-testid="line-width" />
        </div>
      )}

      <div className="fm-hint-inline">
        <button onClick={() => fitGlyph()} title="Fit Glyph" data-testid="fit-btn"><Maximize2 size={13} /> Fit</button>
        <button onClick={() => resetView()} title="Reset View" data-testid="reset-btn"><RotateCcw size={13} /> Reset</button>
        <span className="fm-upm">UPM {upm}</span>
      </div>
    </div>
  );
}
