import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useAppStore } from "@/glyph/store";
import type { Glyph, GlyphMap } from "@/types/glyph";
import { objectFillPath, objectStrokePath } from "./pathBuilder";

function matchesFilter(glyph: Glyph, filter: string) {
  if (filter === "all") return true;
  if (filter === "custom") return true;
  return glyph.category === filter;
}

export function GlyphOverviewCanvas() {
  const frameRef = useRef<HTMLDivElement>(null);
  const glyphs = useAppStore((s) => s.glyphs);
  const metrics = useAppStore((s) => s.metrics);
  const filter = useAppStore((s) => s.glyphOverviewFilter);
  const spacing = useAppStore((s) => s.glyphOverviewSpacing);
  const zoom = useAppStore((s) => s.glyphOverviewZoom);
  const pan = useAppStore((s) => s.glyphOverviewPan);
  const selected = useAppStore((s) => s.overviewSelectedGlyphChars);
  const setPan = useAppStore((s) => s.setGlyphOverviewPan);
  const toggle = useAppStore((s) => s.toggleOverviewGlyphSelection);
  const setSelection = useAppStore((s) => s.setOverviewGlyphSelection);
  const setActiveChar = useAppStore((s) => s.setActiveChar);
  const setMode = useAppStore((s) => s.setGlyphViewMode);
  const [drag, setDrag] = useState<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const items = useMemo(() => Object.values(glyphs).filter((g) => matchesFilter(g, filter)), [glyphs, filter]);
  const cols = Math.max(1, Math.floor((Math.max(1, frameRef.current?.clientWidth || 900) - spacing) / spacing));
  const cellW = spacing;
  const cellH = spacing * 1.18;
  const scale = zoom / 100;
  const contentW = cols * cellW;
  const contentH = Math.ceil(items.length / cols) * cellH;
  const toLocal = (e: React.PointerEvent) => {
    const r = frameRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale - pan.x, y: (e.clientY - r.top) / scale - pan.y };
  };
  const cellAt = (p: { x: number; y: number }) => {
    const col = Math.floor(p.x / cellW), row = Math.floor(p.y / cellH);
    const i = row * cols + col;
    return i >= 0 && i < items.length ? { glyph: items[i], x: col * cellW, y: row * cellH, i } : null;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = toLocal(e);
    const hit = cellAt(p);
    if (hit && (e.shiftKey || !e.ctrlKey && !e.metaKey)) {
      toggle(hit.glyph.char, e.shiftKey);
      if (e.detail >= 2) { setActiveChar(hit.glyph.char); setMode("single"); }
      return;
    }
    setDrag({ x: e.clientX, y: e.clientY, sx: pan.x, sy: pan.y });
    if (!hit) setMarquee({ x: p.x, y: p.y, w: 0, h: 0 });
    frameRef.current?.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag && !marquee) return;
    if (marquee) {
      const p = toLocal(e);
      setMarquee((m) => m ? { ...m, w: p.x - m.x, h: p.y - m.y } : null);
    } else if (drag) {
      setPan({ x: drag.sx + (e.clientX - drag.x) / scale, y: drag.sy + (e.clientY - drag.y) / scale });
    }
  };
  const onPointerUp = () => {
    if (marquee) {
      const m = marquee;
      const x1 = Math.min(m.x, m.x + m.w), x2 = Math.max(m.x, m.x + m.w);
      const y1 = Math.min(m.y, m.y + m.h), y2 = Math.max(m.y, m.y + m.h);
      setSelection(items.filter((g, i) => { const x = (i % cols) * cellW, y = Math.floor(i / cols) * cellH; return x < x2 && x + cellW > x1 && y < y2 && y + cellH > y1; }).map((g) => g.char));
    }
    setDrag(null); setMarquee(null);
  };
  return <div ref={frameRef} className="fm-canvas-frame fm-glyph-overview" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
    <svg width="100%" height="100%" viewBox={`${-pan.x} ${-pan.y} ${(frameRef.current?.clientWidth || 900) / scale} ${(frameRef.current?.clientHeight || 600) / scale}`} style={{ touchAction: "none" }}>
      <g>
        {items.map((glyph, i) => {
          const x = (i % cols) * cellW, y = Math.floor(i / cols) * cellH;
          const active = selected.includes(glyph.char);
          return <g key={glyph.char} transform={`translate(${x} ${y})`} className={active ? "fm-overview-cell selected" : "fm-overview-cell"}>
            <rect width={cellW - 8} height={cellH - 8} rx="6" className="fm-overview-box" />
            {glyph.outline.objects.map((obj) => <path key={obj.id} d={objectFillPath(obj, metrics.ascender)} className="fm-overview-path" />)}
            <text x={(cellW - 8) / 2} y={cellH - 13} textAnchor="middle">{glyph.name || glyph.char || "∅"}</text>
          </g>;
        })}
        {marquee && <rect x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} className="fm-overview-marquee" />}
      </g>
    </svg>
  </div>;
}
