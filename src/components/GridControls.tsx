import type { CSSProperties } from "react";
import { Minus, Plus } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { GRID_SHAPES, GRID_SIZE_MAX, GRID_SIZE_MIN, normalizeGridShape } from "@/editor/gridGeometry";

/**
 * Guideline-grid shape + size. Same two controls in the bottom bar and in its
 * "Settings" overflow menu. The Pixel brush follows whatever shape/size is
 * chosen here, so changing it also changes the cells that brush paints.
 */
export function GridControls({ className = "", style, testId }: { className?: string; style?: CSSProperties; testId?: string }) {
  const gridSize = useAppStore((s) => s.gridSize);
  const setGridSize = useAppStore((s) => s.setGridSize);
  const gridShape = useAppStore((s) => s.gridShape);
  const setGridShape = useAppStore((s) => s.setGridShape);
  const step = gridSize >= 100 ? 10 : 5;
  return (
    <div className={`fm-inline-field fm-grid-controls ${className}`} style={style} data-testid={testId}>
      <select
        className="fm-grid-shape-select"
        value={gridShape}
        onChange={(e) => setGridShape(normalizeGridShape(e.target.value))}
        title="Bentuk guideline grid — brush Pixel ikut mengisi sel bentuk ini"
        aria-label="Bentuk grid"
        data-testid="grid-shape-select"
      >
        {GRID_SHAPES.map((g) => (
          <option key={g.id} value={g.id}>{g.label}</option>
        ))}
      </select>
      <button className="fm-icon-btn" onClick={() => setGridSize(gridSize - step)} title="Grid lebih kecil" data-testid="grid-size-down"><Minus size={12} /></button>
      <input
        className="fm-grid-size-input"
        type="number"
        min={GRID_SIZE_MIN}
        max={GRID_SIZE_MAX}
        step={1}
        value={gridSize}
        onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && e.target.value !== "") setGridSize(v); }}
        title="Ukuran grid (unit font)"
        aria-label="Ukuran grid"
        data-testid="grid-size-value"
      />
      <button className="fm-icon-btn" onClick={() => setGridSize(gridSize + step)} title="Grid lebih besar" data-testid="grid-size-up"><Plus size={12} /></button>
    </div>
  );
}
