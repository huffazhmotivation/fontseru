/**
 * Hapus latar video (orang tetap, latar dibuang) — berjalan sepenuhnya di browser.
 *
 * Mesin: MODNet (Xenova/modnet, model "portrait matting" khusus orang) lewat @xenova/transformers,
 * pustaka yang sama dengan Auto Caption. Model (~26 MB) diunduh sekali lalu disimpan cache browser.
 *
 * Alur:
 *  1. Video di-seek frame demi frame (fps adaptif, maksimum ~150 frame), tiap frame dijalankan ke MODNet
 *     → peta alpha (0..255) beresolusi ≤512 px.
 *  2. Peta alpha dihaluskan terhadap waktu (EMA adaptif: tepi diam stabil, gerakan cepat tidak berhantu).
 *  3. Saat pratinjau/ekspor, tiap frame video digabung dengan alpha hasil interpolasi dua frame terdekat,
 *     dengan kurva ketajaman tepi yang bisa diatur pengguna → getMattedFrame().
 * Hasil (matte) disimpan di memori per aset video.
 */

let modelPromise = null;
let ModelBundle = null;

async function ensureModel(onProgress) {
  if (ModelBundle) return ModelBundle;
  if (!modelPromise) {
    modelPromise = (async () => {
      const tf = await import("@xenova/transformers");
      tf.env.allowLocalModels = false;
      const model = await tf.AutoModel.from_pretrained("Xenova/modnet", {
        quantized: false,
        progress_callback: (p) => {
          if (p?.status === "progress" && typeof p.progress === "number") onProgress?.("Mengunduh model penghapus latar…", (p.progress / 100) * 0.15);
        },
      });
      ModelBundle = { tf, model };
      return ModelBundle;
    })().catch((err) => { modelPromise = null; throw err; });
  }
  return modelPromise;
}

const mattes = new Map(); // matteKey → { fps, w, h, frames: Uint8Array[] }
export const matteKeyOf = (clip) => clip.assetId || clip.id;
export const hasMatte = (clip) => mattes.has(matteKeyOf(clip));
export function setMatte(clip, matte) { mattes.set(matteKeyOf(clip), matte); composeCache.delete(matteKeyOf(clip)); }
export function clearMatte(clip) { mattes.delete(matteKeyOf(clip)); composeCache.delete(matteKeyOf(clip)); }

function waitEvent(target, name, ms = 8000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const ok = () => { if (done) return; done = true; cleanup(); resolve(); };
    const bad = () => { if (done) return; done = true; cleanup(); reject(new Error("Video tidak bisa dibaca")); };
    const timer = setTimeout(ok, ms); // jangan macet selamanya; lanjut dengan frame yang ada
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(name, ok); target.removeEventListener("error", bad); };
    target.addEventListener(name, ok, { once: true });
    target.addEventListener("error", bad, { once: true });
  });
}

async function openVideo(src, file) {
  const tryOpen = async (url) => {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
    v.src = url;
    if (v.readyState < 1) await waitEvent(v, "loadedmetadata", 15000);
    if (!v.videoWidth) throw new Error("Video tidak punya gambar");
    return v;
  };
  try { return { video: await tryOpen(src), revoke: null }; }
  catch (e) {
    if (!file) throw e;
    const url = URL.createObjectURL(file);
    return { video: await tryOpen(url), revoke: () => URL.revokeObjectURL(url) };
  }
}

/* ---------------- Pool worker (paralel) ---------------- */

function poolSize() {
  const cores = navigator.hardwareConcurrency || 4;
  const tablet = typeof document !== "undefined" && document.documentElement.dataset.tablet === "true";
  return Math.max(1, Math.min(tablet ? 2 : 4, cores - 1));
}

function spawnWorker() {
  const w = new Worker(new URL("./matteWorker.js", import.meta.url), { type: "module" });
  const state = { w, pending: new Map(), onProgress: null, ready: null };
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") state.onProgress?.(m.value);
    else if (m.type === "ready") state.ready?.resolve();
    else if (m.type === "result") { const p = state.pending.get(m.id); state.pending.delete(m.id); p?.resolve(m); }
    else if (m.type === "error") {
      if (m.id != null) { const p = state.pending.get(m.id); state.pending.delete(m.id); p?.reject(new Error(m.message)); }
      else state.ready?.reject(new Error(m.message));
    }
  };
  w.onerror = (ev) => { const err = new Error(ev.message || "Worker gagal"); state.ready?.reject(err); state.pending.forEach((p) => p.reject(err)); state.pending.clear(); };
  state.init = () => new Promise((resolve, reject) => { state.ready = { resolve, reject }; w.postMessage({ type: "init" }); });
  state.run = (id, rgb, iw, ih) => new Promise((resolve, reject) => { state.pending.set(id, { resolve, reject }); w.postMessage({ type: "frame", id, rgb, w: iw, h: ih }, [rgb.buffer]); });
  return state;
}

async function startPool(onProgress) {
  const n = poolSize();
  const first = spawnWorker();
  first.onProgress = (v) => onProgress?.("Mengunduh model penghapus latar…", v * 0.15);
  try {
    await first.init(); // unduh + cache sekali dulu; worker lain memuat dari cache
    const rest = Array.from({ length: n - 1 }, () => spawnWorker());
    const results = await Promise.allSettled(rest.map((r) => r.init()));
    const ok = [first];
    rest.forEach((r, i) => { if (results[i].status === "fulfilled") ok.push(r); else r.w.terminate(); });
    return ok;
  } catch (err) {
    first.w.terminate();
    throw err;
  }
}

/**
 * @returns {Promise<{fps:number,w:number,h:number,frames:Uint8Array[]}>}
 */
export async function computeVideoMatte({ src, file, durationMs, onProgress, signal }) {
  onProgress?.("Menyiapkan model…", 0.01);
  let pool = null;
  try { pool = await startPool(onProgress); } catch (err) { pool = null; }
  const { video, revoke } = await openVideo(src, file);
  const main = pool ? null : await ensureModel(onProgress);
  try {
    const dur = Math.max(0.2, Math.min(video.duration || durationMs / 1000, (durationMs || 1e9) / 1000 + 0.05));
    const fps = Math.max(8, Math.min(30, Math.floor(300 / dur)));
    const total = Math.max(1, Math.ceil(dur * fps));
    const long = 512;
    const ratio = Math.min(1, long / Math.max(video.videoWidth, video.videoHeight));
    // Kelipatan 32 (syarat MODNet), tanpa pembesaran: ±2× lebih cepat dari jalur AutoProcessor dengan hasil nyaris identik.
    const snap32 = (v) => Math.max(32, Math.round(v / 32) * 32);
    const iw = snap32(video.videoWidth * ratio), ih = snap32(video.videoHeight * ratio);
    const canvas = document.createElement("canvas");
    canvas.width = iw; canvas.height = ih;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const frames = new Array(total);
    let mw = 0, mh = 0, done = 0;
    const report = () => onProgress?.(`Memproses frame ${done}/${total}…${pool ? ` (${pool.length} jalur paralel)` : ""}`, 0.15 + 0.85 * (done / total));
    const grab = async (i) => {
      const target = Math.max(0, Math.min(dur - 0.001, i / fps));
      // Bila posisinya sudah sama, event "seeked" tidak akan muncul — jangan menunggu timeout.
      if (Math.abs(video.currentTime - target) > 0.0005 || video.readyState < 2) {
        video.currentTime = target;
        await waitEvent(video, "seeked", 6000);
      }
      ctx.drawImage(video, 0, 0, iw, ih);
      const rgba = ctx.getImageData(0, 0, iw, ih).data;
      const rgb = new Uint8ClampedArray(iw * ih * 3);
      for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) { rgb[q] = rgba[p]; rgb[q + 1] = rgba[p + 1]; rgb[q + 2] = rgba[p + 2]; }
      return rgb;
    };
    const store = (i, ow, oh, a) => {
      if (!mw) { mw = ow; mh = oh; }
      if (ow !== mw || oh !== mh) { // ukuran keluaran berbeda → samakan (jarang terjadi)
        const b = new Uint8Array(mw * mh);
        for (let y = 0; y < mh; y++) { const sy = Math.min(oh - 1, Math.floor((y / mh) * oh)); for (let x = 0; x < mw; x++) b[y * mw + x] = a[sy * ow + Math.min(ow - 1, Math.floor((x / mw) * ow))]; }
        a = b;
      }
      frames[i] = a; done++; report();
    };

    if (pool) {
      // Seek berurutan di thread utama (cepat), inferensi paralel di worker; maksimal 1 frame antre per worker.
      const idle = pool.slice();
      const waiters = [];
      const acquire = () => (idle.length ? Promise.resolve(idle.pop()) : new Promise((r) => waiters.push(r)));
      const release = (wk) => { const w = waiters.shift(); if (w) w(wk); else idle.push(wk); };
      const jobs = [];
      let failure = null;
      for (let i = 0; i < total; i++) {
        if (signal?.aborted) throw new DOMException("Dibatalkan", "AbortError");
        if (failure) throw failure;
        const wk = await acquire();
        const rgb = await grab(i);
        jobs.push(
          wk.run(i, rgb, iw, ih)
            .then((r) => { store(i, r.w, r.h, r.data); })
            .catch((err) => { failure = failure || err; })
            .finally(() => release(wk)),
        );
      }
      await Promise.all(jobs);
      if (failure) throw failure;
      if (signal?.aborted) throw new DOMException("Dibatalkan", "AbortError");
    } else {
      const { tf, model } = main;
      for (let i = 0; i < total; i++) {
        if (signal?.aborted) throw new DOMException("Dibatalkan", "AbortError");
        const rgb = await grab(i);
        const n = iw * ih;
        const f = new Float32Array(3 * n);
        for (let i = 0, q = 0; i < n; i++, q += 3) { f[i] = (rgb[q] - 127.5) / 127.5; f[n + i] = (rgb[q + 1] - 127.5) / 127.5; f[2 * n + i] = (rgb[q + 2] - 127.5) / 127.5; }
        const { output } = await model({ input: new tf.Tensor("float32", f, [1, 3, ih, iw]) });
        const dims = output.dims;
        const oh = dims[dims.length - 2], ow = dims[dims.length - 1];
        const a = new Uint8Array(ow * oh);
        for (let p = 0; p < a.length; p++) a[p] = Math.max(0, Math.min(255, Math.round(output.data[p] * 255)));
        store(i, ow, oh, a);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    // Haluskan terhadap waktu: bobot frame sebelumnya mengecil bila piksel berubah drastis (gerakan cepat).
    for (let i = 1; i < frames.length; i++) {
      const cur = frames[i], prev = frames[i - 1];
      for (let p = 0; p < cur.length; p++) {
        const d = Math.abs(cur[p] - prev[p]) / 255;
        const wPrev = 0.25 * (1 - Math.min(1, d * 6)); // hanya meredam kedip; piksel yang bergerak tidak ditarik ke frame lama
        cur[p] = Math.round(cur[p] * (1 - wPrev) + prev[p] * wPrev);
      }
    }
    return { fps, w: mw, h: mh, frames };
  } finally {
    pool?.forEach((wk) => wk.w.terminate());
    try { video.removeAttribute("src"); video.load(); } catch (e) { /* abaikan */ }
    revoke?.();
  }
}

/* ---------------- Komposisi frame (dipakai saat menggambar) ---------------- */

const composeCache = new Map(); // matteKey → state

function smoothstep(lo, hi, x) {
  if (x <= lo) return 0;
  if (x >= hi) return 1;
  const t = (x - lo) / (hi - lo);
  return t * t * (3 - 2 * t);
}

/**
 * Kembalikan canvas berisi frame video saat ini dengan latar transparan, atau null bila matte belum ada.
 * @param {*} clip      klip video (memakai bgEdge 0..1 & bgShrink -1..1)
 * @param {HTMLVideoElement} el
 * @param {number} localMs waktu di dalam klip (ms)
 */
export function getMattedFrame(clip, el, localMs) {
  const key = matteKeyOf(clip);
  const m = mattes.get(key);
  if (!m || !el || !el.videoWidth || !el.__mfsReady) return null;
  let st = composeCache.get(key);
  if (!st) {
    st = { canvas: document.createElement("canvas"), mask: document.createElement("canvas"), sig: "" };
    st.ctx = st.canvas.getContext("2d");
    st.mctx = st.mask.getContext("2d", { willReadFrequently: true });
    composeCache.set(key, st);
  }
  const scale = Math.min(1, 960 / Math.max(el.videoWidth, el.videoHeight));
  const cw = Math.max(2, Math.round(el.videoWidth * scale)), ch = Math.max(2, Math.round(el.videoHeight * scale));
  if (st.canvas.width !== cw || st.canvas.height !== ch) { st.canvas.width = cw; st.canvas.height = ch; }
  if (st.mask.width !== m.w || st.mask.height !== m.h) { st.mask.width = m.w; st.mask.height = m.h; st.sig = ""; }

  // Frame matte TERDEKAT (bukan campuran dua frame): mencampur dua posisi objek yang bergerak menimbulkan halo/ghost di tepi.
  const i0 = Math.max(0, Math.min(m.frames.length - 1, Math.round((localMs / 1000) * m.fps))), i1 = i0;
  const f = 0;
  const edge = clip.bgEdge ?? 0.7, shrink = clip.bgShrink ?? 0.2;
  const sig = `${i0}|${i1}|${f}|${edge}|${shrink}`;
  if (st.sig !== sig) {
    st.sig = sig;
    const half = 0.5 * (1 - 0.8 * edge);
    const c = 0.5 + 0.2 * shrink;
    const lo = Math.max(0, c - half), hi = Math.min(1, c + half);
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.round(smoothstep(lo, hi, v / 255) * 255);
    const A = m.frames[i0], B = m.frames[i1];
    const img = st.mctx.createImageData(m.w, m.h);
    const d = img.data;
    for (let p = 0, q = 0; p < A.length; p++, q += 4) {
      const v = f === 0 || A === B ? A[p] : Math.round(A[p] * (1 - f) + B[p] * f);
      d[q] = d[q + 1] = d[q + 2] = 255;
      d[q + 3] = lut[v];
    }
    st.mctx.putImageData(img, 0, 0);
  }
  const ctx = st.ctx;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, cw, ch);
  ctx.drawImage(el, 0, 0, cw, ch);
  ctx.globalCompositeOperation = "destination-in";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(st.mask, 0, 0, cw, ch);
  ctx.globalCompositeOperation = "source-over";
  st.canvas.videoWidth = cw; st.canvas.videoHeight = ch; st.canvas.__mfsReady = true;
  return st.canvas;
}
