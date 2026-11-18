import { memo, useMemo } from "react";
import type { GlyphOutline, Point } from "@/types/geometry";
import { usePreviewValue, type PreviewStore } from "./previewStore";
import { BOX_PAD_PX, BOX_ROTATE_GAP_PX, boxHandles, selectedCurveSegments, selectionBox, tunniOf } from "./precisionTools";

/**
 * Node-tool overlays for precision editing (see precisionTools.ts):
 *  - SegmentHoverLayer: highlighted segment, its length, stem thickness.
 *  - NodePrecisionLayer: Tunni lines/points of selected curves, and the
 *    transform box around 2+ selected nodes.
 *  - DragReadout: live numbers next to the pointer while dragging.
 * Everything is drawn in font units (SVG y = ascender − y) and sized in
 * screen pixels via `hitScale` (font units per pixel).
 */

export interface SegmentHoverInfo {
  /** `${contourId}:${fromIndex}` of the hovered segment. */
  key: string;
  /** Segment path data, already in SVG space. */
  d: string;
  length: number;
  /** Middle of the segment and the normal there (font units), for the length tag. */
  mid: Point;
  normal: Point;
  /** How far off the curve the length tag sits (font units). */
  badgeOffset: number;
  /** Stem measured straight across the shape at the pointer. */
  thick: { from: Point; to: Point; distance: number } | null;
}

function Badge({ x, y, text, hitScale, tone = "default" }: { x: number; y: number; text: string; hitScale: number; tone?: "default" | "accent" }) {
  const w = (12 + text.length * 6.4) * hitScale;
  const h = 18 * hitScale;
  return (
    <g pointerEvents="none">
      <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={5 * hitScale} className={`np-badge-bg ${tone}`} />
      <text x={x} y={y + 4 * hitScale} textAnchor="middle" className={`np-badge-text ${tone}`} style={{ fontSize: 11 * hitScale }}>{text}</text>
    </g>
  );
}

export const SegmentHoverLayer = memo(function SegmentHoverLayer({ store, ascender, hitScale }: { store: PreviewStore<SegmentHoverInfo | null>; ascender: number; hitScale: number }) {
  const info = usePreviewValue(store);
  if (!info) return null;
  const off = info.badgeOffset;
  const lx = info.mid.x + info.normal.x * off;
  const ly = ascender - (info.mid.y + info.normal.y * off);
  const t = info.thick;
  return (
    <g pointerEvents="none" data-testid="segment-hover">
      <path d={info.d} className="np-seg-hover" />
      <Badge x={lx} y={ly} text={`${Math.round(info.length)}`} hitScale={hitScale} tone="accent" />
      {t && t.distance > 1 && (
        <>
          <line x1={t.from.x} y1={ascender - t.from.y} x2={t.to.x} y2={ascender - t.to.y} className="np-measure" />
          <circle cx={t.to.x} cy={ascender - t.to.y} r={2.4 * hitScale} className="np-measure-end" />
          <Badge x={(t.from.x + t.to.x) / 2} y={ascender - (t.from.y + t.to.y) / 2} text={`${Math.round(t.distance)}`} hitScale={hitScale} />
        </>
      )}
    </g>
  );
});

/** Tunni tension label; steps aside while its own segment is hovered (the
 *  hover tag takes that spot). Subscribes to the hover store itself so only
 *  these few labels re-render on pointer moves. */
function TunniLabel({ hoverStore, segKey, x, y, size, text }: { hoverStore: PreviewStore<SegmentHoverInfo | null>; segKey: string; x: number; y: number; size: number; text: string }) {
  const hovered = usePreviewValue(hoverStore);
  if (hovered?.key === segKey) return null;
  return <text x={x} y={y} className="np-tunni-text" style={{ fontSize: size }}>{text}</text>;
}

export const NodePrecisionLayer = memo(function NodePrecisionLayer({
  outline, selectedNodes, ascender, hitScale, hoverStore,
}: {
  outline: GlyphOutline;
  selectedNodes: { contourId: string; nodeId: string }[];
  ascender: number;
  hitScale: number;
  hoverStore: PreviewStore<SegmentHoverInfo | null>;
}) {
  const tunnis = useMemo(() => {
    if (selectedNodes.length < 2) return [];
    const keys = new Set(selectedNodes.map((r) => `${r.contourId}:${r.nodeId}`));
    return selectedCurveSegments(outline, keys).map((ref) => tunniOf(outline, ref)).filter((t) => t !== null);
  }, [outline, selectedNodes]);
  const box = useMemo(() => (selectedNodes.length >= 2 ? selectionBox(outline, selectedNodes) : null), [outline, selectedNodes]);
  const pad = BOX_PAD_PX * hitScale;
  const handles = box ? boxHandles(box, pad, BOX_ROTATE_GAP_PX * hitScale) : [];
  const showBox = box && (box.maxX - box.minX > 6 * hitScale || box.maxY - box.minY > 6 * hitScale);
  const fy = (y: number) => ascender - y;
  return (
    <g data-testid="node-precision">
      {showBox && box && (
        <g pointerEvents="none">
          <rect
            x={box.minX - pad}
            y={fy(box.maxY + pad)}
            width={box.maxX - box.minX + pad * 2}
            height={box.maxY - box.minY + pad * 2}
            className="np-box"
          />
          {handles.map((h) => {
            if (h.id === "rotate") {
              return (
                <g key={h.id}>
                  <line x1={h.p.x} y1={fy(box.maxY + pad)} x2={h.p.x} y2={fy(h.p.y)} className="sel-rot-line" />
                  <circle cx={h.p.x} cy={fy(h.p.y)} r={4.5 * hitScale} className="np-box-handle" />
                </g>
              );
            }
            const s = 7 * hitScale;
            return <rect key={h.id} x={h.p.x - s / 2} y={fy(h.p.y) - s / 2} width={s} height={s} className="np-box-handle" />;
          })}
        </g>
      )}
      {tunnis.map((t) => t && (
        <g key={`${t.ref.contourId}:${t.ref.fromIndex}`} pointerEvents="none">
          <line x1={t.h1.x} y1={fy(t.h1.y)} x2={t.h2.x} y2={fy(t.h2.y)} className="np-tunni-line" />
          <circle cx={t.mid.x} cy={fy(t.mid.y)} r={4.2 * hitScale} className="np-tunni-point" />
          {t.tension1 != null && t.tension2 != null && tunnis.length <= 6 && (
            <TunniLabel
              hoverStore={hoverStore}
              segKey={`${t.ref.contourId}:${t.ref.fromIndex}`}
              x={t.mid.x + 9 * hitScale}
              y={fy(t.mid.y) - 7 * hitScale}
              size={10.5 * hitScale}
              text={Math.abs(t.tension1 - t.tension2) < 0.005
                ? `${Math.round(t.tension1 * 100)}%`
                : `${Math.round(t.tension1 * 100)}% · ${Math.round(t.tension2 * 100)}%`}
            />
          )}
        </g>
      ))}
    </g>
  );
});

export function DragReadout({ readout, ascender, hitScale }: { readout: { point: Point; text: string } | null; ascender: number; hitScale: number }) {
  if (!readout) return null;
  const x = readout.point.x + (18 + readout.text.length * 3.2) * hitScale;
  const y = ascender - readout.point.y - 18 * hitScale;
  return <Badge x={x} y={y} text={readout.text} hitScale={hitScale} tone="accent" />;
}
