export interface RgbColor { r: number; g: number; b: number }

const NAMED: Record<string, RgbColor> = {
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
};

export function parseColor(input: string | null): RgbColor | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s === "none" || s === "transparent") return null;
  if (s in NAMED) return NAMED[s];

  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16));
    return { r, g, b };
  }
  m = s.match(/^#([0-9a-f]{6})$/);
  if (m) {
    const h = m[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(",").map((p) => parseFloat(p));
    if (parts.length >= 3 && parts.every((p) => Number.isFinite(p))) return { r: parts[0], g: parts[1], b: parts[2] };
  }
  return null;
}

export function luminance(c: RgbColor): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

/** True for `none`, `transparent`, unspecified, or any color close to white — the palette our own guide/decoration shapes use, never real ink. */
export function isNearWhiteOrNone(input: string | null): boolean {
  if (input == null) return false;
  const s = input.trim().toLowerCase();
  if (s === "none" || s === "transparent") return true;
  const c = parseColor(s);
  if (!c) return false;
  return luminance(c) > 235;
}

/** True for colors close to black — what our own fiducial/marker squares are always filled with. */
export function isNearBlack(input: string | null): boolean {
  const c = parseColor(input);
  if (!c) return false;
  return luminance(c) < 70;
}
