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
