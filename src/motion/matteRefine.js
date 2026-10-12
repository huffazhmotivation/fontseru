/* Penyempurnaan tepi matte dengan guided filter (He et al.): alpha dari model "ditempelkan" ke tepi gambar asli,
 * sehingga tepi tidak berbulu/berhalo di sekitar objek yang bergerak. Berjalan di resolusi matte (O(N)). */
function boxFilter(src, w, h, r, out) {
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / (2 * r + 1);
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / (2 * r + 1);
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/**
 * @param {Float32Array} p     alpha 0..1 (w*h)
 * @param {Uint8ClampedArray} rgb  gambar panduan RGB (w*h*3)
 * @returns {Float32Array} alpha hasil penyempurnaan 0..1
 */
export function guidedRefine(p, rgb, w, h, r = 3, eps = 0.0015) {
  const n = w * h;
  const I = new Float32Array(n);
  for (let i = 0, q = 0; i < n; i++, q += 3) I[i] = (0.299 * rgb[q] + 0.587 * rgb[q + 1] + 0.114 * rgb[q + 2]) / 255;
  const mI = boxFilter(I, w, h, r, new Float32Array(n));
  const mP = boxFilter(p, w, h, r, new Float32Array(n));
  const tmp = new Float32Array(n);
  for (let i = 0; i < n; i++) tmp[i] = I[i] * I[i];
  const cII = boxFilter(tmp, w, h, r, new Float32Array(n));
  for (let i = 0; i < n; i++) tmp[i] = I[i] * p[i];
  const cIP = boxFilter(tmp, w, h, r, new Float32Array(n));
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = cII[i] - mI[i] * mI[i];
    const cov = cIP[i] - mI[i] * mP[i];
    a[i] = cov / (varI + eps);
    b[i] = mP[i] - a[i] * mI[i];
  }
  const mA = boxFilter(a, w, h, r, new Float32Array(n));
  const mB = boxFilter(b, w, h, r, new Float32Array(n));
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = mA[i] * I[i] + mB[i]; q[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  return q;
}

/** Perbesar alpha (Float32 0..1) ke ukuran lain dengan interpolasi bilinear. */
export function resizeAlpha(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return Float32Array.from(src);
  const out = new Float32Array(dw * dh);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.max(0, (y + 0.5) * yr - 0.5), y0 = Math.min(sh - 1, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.max(0, (x + 0.5) * xr - 0.5), x0 = Math.min(sw - 1, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/** Alpha model (resolusi rendah) → alpha presisi di resolusi gambar panduan (hi-res), tepi menempel ke tepi asli. */
export function refineToGuide(src, sw, sh, guideRgb, gw, gh) {
  const clamped = Float32Array.from(src, (v) => (v < 0 ? 0 : v > 1 ? 1 : v));
  const up = resizeAlpha(clamped, sw, sh, gw, gh);
  const r = Math.max(3, Math.round(Math.max(gw, gh) / 190));
  return guidedRefine(up, guideRgb, gw, gh, r, 0.0006);
}
