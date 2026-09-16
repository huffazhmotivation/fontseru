import { useAppStore } from "@/glyph/store";

export function GlyphViewToolbar() {
  const mode = useAppStore((s) => s.glyphViewMode);
  const filter = useAppStore((s) => s.glyphOverviewFilter);
  const spacing = useAppStore((s) => s.glyphOverviewSpacing);
  const zoom = useAppStore((s) => s.glyphOverviewZoom);
  const setMode = useAppStore((s) => s.setGlyphViewMode);
  const setFilter = useAppStore((s) => s.setGlyphOverviewFilter);
  const setSpacing = useAppStore((s) => s.setGlyphOverviewSpacing);
  const setZoom = useAppStore((s) => s.setGlyphOverviewZoom);
  return <div className="fm-glyph-view-toolbar">
    <span className="fm-glyph-view-label">Glyph View</span>
    <button className={mode === "single" ? "on" : ""} onClick={() => setMode("single")}>Single</button>
    <button className={mode === "overview" ? "on" : ""} onClick={() => setMode("overview")}>Multi</button>
    {mode === "overview" && <>
      <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
        <option value="all">All Glyphs</option><option value="upper">Uppercase</option><option value="lower">Lowercase</option><option value="digits">Numbers</option><option value="punct">Punctuation</option><option value="symbols">Symbols</option><option value="custom">Custom selection</option>
      </select>
      <label>Spacing <input type="range" min="40" max="180" value={spacing} onChange={(e) => setSpacing(Number(e.target.value))} /></label>
      <label>Zoom <input type="range" min="50" max="220" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label>
    </>}
  </div>;
}
