import React from "react";
import { Grid3x3, Ruler, Ghost, Magnet, Wand2, Maximize2, RotateCcw, Minus, Plus, Eye, AlignCenter, SlidersHorizontal, Info } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { NumericInput } from "./NumericInput";
import { AboutModal } from "@/components/AboutModal";

export function BottomBar() {
  // --- "Settings" overflow menu (tablet/phone widths, see
  // .fm-bottombar-more-hide in app.css) ---------------------------------
  // Below 1180px the Grid/Ruler/Guides/Ghost/Snap/Auto Metrik/Preview
  // toggles (plus the grid-size/line-width inline fields) are hidden from
  // the bar itself and re-rendered here, so the bar stays a single row
  // that fits the screen width with zoom + Fit/Reset always reachable and
  // no horizontal scrolling or wrapping to extra rows. Same fixed-position
  // dropdown approach as FileMenu/TopBar's "More" menu.
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [morePos, setMorePos] = React.useState<{ bottom: number; left: number } | null>(null);
  const moreWrapRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!moreOpen) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setMoreOpen(false); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  React.useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [moreOpen]);

  const openMore = React.useCallback(() => {
    const rect = moreWrapRef.current?.getBoundingClientRect();
    const menuWidth = 220;
    const left = rect
      ? Math.max(10, Math.min(rect.left, window.innerWidth - menuWidth - 10))
      : 14;
    // Positioned with `bottom` (distance up from the viewport edge), not
    // `top` — this bar lives at the bottom of the screen, so the dropdown
    // needs to open upward above it rather than downward off the bottom
    // of the viewport like FileMenu/TopBar's "More" menu do.
    const bottom = rect ? window.innerHeight - rect.top + 8 : 60;
    setMorePos({ bottom, left });
    setMoreOpen(true);
  }, []);

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

      <div className="fm-bottom-divider fm-bottombar-more-hide" />

      {/* Grid/Ruler/Guides/Ghost/Snap/Auto Metrik/Preview toggles below are
          hidden below 1180px (see .fm-bottombar-more-hide in app.css) and
          re-rendered inside the "Settings" dropdown instead — that's what
          keeps zoom + Fit/Reset always reachable in a single row that fits
          tablet/phone screen widths with no horizontal scrolling and no
          wrapping to extra rows. */}
      <button className={`fm-bottombar-more-hide ${showGrid ? "on" : ""}`} onClick={toggleGrid} data-testid="toggle-grid"><Grid3x3 size={13} /> Grid</button>
      {showGrid && (
        <div className="fm-inline-field fm-bottombar-more-hide" data-testid="grid-size-field">
          <button className="fm-icon-btn" onClick={() => setGridSize(gridSize - 5)} title="Smaller grid" data-testid="grid-size-down"><Minus size={12} /></button>
          <span className="fm-grid-size-value" data-testid="grid-size-value">{gridSize}u</span>
          <button className="fm-icon-btn" onClick={() => setGridSize(gridSize + 5)} title="Larger grid" data-testid="grid-size-up"><Plus size={12} /></button>
        </div>
      )}
      <button className={`fm-bottombar-more-hide ${showRuler ? "on" : ""}`} onClick={toggleRuler} data-testid="toggle-ruler" title="Tampilkan/sembunyikan ruler. Drag dari ruler untuk bikin guide garis putus-putus."><Ruler size={13} /> Ruler</button>
      <button className={`fm-bottombar-more-hide ${showGuides ? "on" : ""}`} onClick={toggleGuides} data-testid="toggle-guides"><AlignCenter size={13} /> Guides</button>
      <button className={`fm-bottombar-more-hide ${ghost.enabled ? "on" : ""}`} onClick={() => setGhost({ enabled: !ghost.enabled })} data-testid="toggle-ghost"><Ghost size={13} /> Ghost</button>
      <button className={`fm-bottombar-more-hide ${snapEnabled ? "on" : ""}`} onClick={toggleSnap} title="Snap objects to guide lines" data-testid="toggle-snap"><Magnet size={13} /> Snap</button>
      {/* Same "Auto" toggle as Glyph Metrics' Spacing mode, mirrored here so
          it stays visible and reachable no matter which tool is active —
          previously it only showed up under the Home tool, so switching to
          Pen/Shape/Brush to actually draw hid the only place that showed
          (or let you fix) whether Auto was on. One flag, two switches. */}
      <button
        className={`fm-bottombar-more-hide ${autoSpacingEnabled ? "on" : ""}`}
        onClick={() => setAutoSpacingEnabled(!autoSpacingEnabled)}
        title="Auto Metrik: posisi, LSB, RSB & advance width tiap glyph mengikuti bentuk outline-nya sendiri secara otomatis setiap kali digambar/diedit."
        data-testid="toggle-auto-metrik"
      >
        <Wand2 size={13} /> Auto Metrik
      </button>

      {/* Deliberately NOT `fm-bottombar-more-hide` — unlike Grid/Ruler/
          Guides/Ghost/Snap/Auto Metrik, Preview stays on the main bar at
          every width (including phones) instead of moving into the
          "Settings" dropdown, since it's reached often enough to deserve
          a direct tap. */}
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

      {/* "Settings" overflow menu: only visible below 1180px (see
          .fm-bottombar-more-btn in app.css). Opens upward since this bar
          sits at the bottom of the screen. Holds the toggles hidden above,
          as full-width labeled rows. */}
      <div className="fm-bottombar-more-btn fm-filemenu-wrap" ref={moreWrapRef}>
        <button
          type="button"
          onClick={() => (moreOpen ? setMoreOpen(false) : openMore())}
          aria-expanded={moreOpen}
          title="Display settings"
          aria-label="Display settings"
          data-testid="bottombar-more-btn"
        >
          <SlidersHorizontal size={14} />
        </button>

        {moreOpen && (
          <>
            <div
              className="fm-filemenu-backdrop"
              onClick={() => setMoreOpen(false)}
              aria-hidden="true"
              data-testid="bottombar-more-backdrop"
            />
            <div
              className="fm-filemenu fm-morebar-menu fm-morebar-menu-up"
              role="menu"
              style={morePos ? { bottom: morePos.bottom, left: morePos.left } : undefined}
            >
              <button className={showGrid ? "on" : ""} onClick={toggleGrid}>
                <Grid3x3 size={14} /> Grid
              </button>
              {showGrid && (
                <div className="fm-inline-field" style={{ padding: "2px 9px" }}>
                  <button className="fm-icon-btn" onClick={() => setGridSize(gridSize - 5)} title="Smaller grid"><Minus size={12} /></button>
                  <span className="fm-grid-size-value">{gridSize}u</span>
                  <button className="fm-icon-btn" onClick={() => setGridSize(gridSize + 5)} title="Larger grid"><Plus size={12} /></button>
                </div>
              )}
              <button className={showRuler ? "on" : ""} onClick={toggleRuler} title="Tampilkan/sembunyikan ruler. Drag dari ruler untuk bikin guide garis putus-putus.">
                <Ruler size={14} /> Ruler
              </button>
              <button className={showGuides ? "on" : ""} onClick={toggleGuides}>
                <AlignCenter size={14} /> Guides
              </button>
              <button className={ghost.enabled ? "on" : ""} onClick={() => setGhost({ enabled: !ghost.enabled })}>
                <Ghost size={14} /> Ghost
              </button>
              <button className={snapEnabled ? "on" : ""} onClick={toggleSnap} title="Snap objects to guide lines">
                <Magnet size={14} /> Snap
              </button>
              <button
                className={autoSpacingEnabled ? "on" : ""}
                onClick={() => setAutoSpacingEnabled(!autoSpacingEnabled)}
                title="Auto Metrik: posisi, LSB, RSB & advance width tiap glyph mengikuti bentuk outline-nya sendiri secara otomatis setiap kali digambar/diedit."
              >
                <Wand2 size={14} /> Auto Metrik
              </button>
            </div>
          </>
        )}
      </div>

      <div className="fm-hint-inline">
        {/* Moved here from the top bar — sits right next to Fit, visible at
            every width. Bare trigger class so it inherits the bottom bar's
            own button styling instead of the top bar's fm-topbtn look. */}
        <AboutModal triggerClassName="" triggerIcon={<Info size={13} />} triggerLabel="About Us" />
        <button onClick={() => fitGlyph()} title="Fit Glyph" data-testid="fit-btn"><Maximize2 size={13} /> Fit</button>
        <button onClick={() => resetView()} title="Reset View" data-testid="reset-btn"><RotateCcw size={13} /> Reset</button>
        <span className="fm-upm fm-bottombar-more-hide">UPM {upm}</span>
      </div>
    </div>
  );
}
