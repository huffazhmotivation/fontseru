import { useAppStore } from "@/glyph/store";
import { getGlyphPaths } from "@/editor/glyphPaths";

/**
 * Frame renderer for the "Editor canvas" timelapse source.
 *
 * Screen capture (`getDisplayMedia`) does not exist on iPad/iPhone Safari or
 * Chrome for Android, so timelapse could only ever work on a desktop
 * browser. This source needs no browser permission at all: every frame is
 * drawn straight from the glyph DATA (the same path geometry the editor
 * itself renders, via `getGlyphPaths`) onto the encoding canvas, so it works
 * anywhere the app runs.
 *
 * It records the glyph being edited — guides, ink and all — fitted and
 * centered in a fixed frame, so the video shows the letter growing stroke by
 * stroke without any zooming/panning/UI noise. A frame is skipped when
 * nothing changed since the last one, which is what makes a long session
 * compress into a short clip instead of many identical frames.
 */

const DARK = { bg: "#171717", ink: "#f3f3f3", guide: "rgba(255,255,255,0.16)", base: "rgba(120,200,160,0.75)", label: "rgba(255,255,255,0.45)" };
const LIGHT = { bg: "#fcfcfc", ink: "#1b1b1b", guide: "rgba(0,0,0,0.14)", base: "rgba(20,140,90,0.8)", label: "rgba(0,0,0,0.4)" };

/** Identity of what a frame would show; equal signatures = identical frames. */
export function canvasFrameSignature(): string {
  const s = useAppStore.getState();
  const glyph = s.glyphs[s.activeChar];
  // Object identity of the glyph changes on every committed edit.
  return `${s.activeChar}|${s.theme}|${objectId(glyph)}|${s.metrics.ascender}|${s.metrics.descender}`;
}

const ids = new WeakMap<object, number>();
let nextId = 1;
function objectId(o: object | undefined): number {
  if (!o) return 0;
  let id = ids.get(o);
  if (!id) {
    id = nextId++;
    ids.set(o, id);
  }
  return id;
}

export function drawCanvasFrame(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const state = useAppStore.getState();
  const palette = state.theme === "light" ? LIGHT : DARK;
  const { metrics, activeChar } = state;
  const glyph = state.glyphs[activeChar];

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, width, height);

  const top = metrics.ascender;
  const totalH = Math.max(1, metrics.ascender - metrics.descender);
  const advance = Math.max(1, glyph?.advanceWidth ?? metrics.unitsPerEm * 0.6);
  const pad = metrics.unitsPerEm * 0.12;
  const contentW = advance + pad * 2;
  const scale = Math.min((width * 0.9) / contentW, (height * 0.86) / totalH);
  const ox = (width - advance * scale) / 2;
  const oy = (height - totalH * scale) / 2;
  ctx.setTransform(scale, 0, 0, scale, ox, oy);

  // Guides: ascender / cap / x-height / baseline / descender + advance box.
  const line = (y: number, color: string, dash: boolean) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2 / scale;
    ctx.setLineDash(dash ? [6 / scale, 5 / scale] : []);
    ctx.beginPath();
    ctx.moveTo(-pad, top - y);
    ctx.lineTo(advance + pad, top - y);
    ctx.stroke();
  };
  line(metrics.ascender, palette.guide, true);
  line(metrics.capHeight, palette.guide, true);
  line(metrics.xHeight, palette.guide, true);
  line(metrics.descender, palette.guide, true);
  line(metrics.baseline ?? 0, palette.base, false);
  ctx.strokeStyle = palette.guide;
  ctx.lineWidth = 1.2 / scale;
  ctx.setLineDash([]);
  for (const x of [0, advance]) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, totalH);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  if (glyph) {
    ctx.fillStyle = palette.ink;
    ctx.strokeStyle = palette.ink;
    for (const entry of getGlyphPaths(glyph, top)) {
      const path = new Path2D(entry.d);
      if (entry.kind === "stroke") {
        ctx.lineWidth = entry.strokeWidth;
        ctx.lineCap = entry.cap as CanvasLineCap;
        ctx.lineJoin = entry.join as CanvasLineJoin;
        ctx.stroke(path);
      } else {
        ctx.fill(path, "nonzero");
      }
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = palette.label;
  ctx.font = `600 ${Math.round(height * 0.035)}px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = "bottom";
  ctx.fillText(activeChar === " " ? "space" : activeChar, height * 0.035, height - height * 0.03);
}
