/* Worker penghapus latar: menjalankan MODNet (Xenova/modnet) di thread terpisah supaya UI tidak macet
 * dan beberapa worker bisa memproses frame video secara paralel. Lihat videoMatte.js. */
let bundle = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      const tf = await import("@xenova/transformers");
      tf.env.allowLocalModels = false;
      const model = await tf.AutoModel.from_pretrained("Xenova/modnet", {
        quantized: false,
        progress_callback: (p) => {
          if (p?.status === "progress" && typeof p.progress === "number") self.postMessage({ type: "progress", value: p.progress / 100 });
        },
      });
      bundle = { tf, model };
      self.postMessage({ type: "ready" });
    } else if (m.type === "frame") {
      const { tf, model } = bundle;
      // Lewati AutoProcessor (selalu membesarkan gambar ke sisi pendek 512 → 2× lebih lambat tanpa manfaat):
      // beri model gambar sudah berukuran kelipatan 32, dinormalisasi (x-127.5)/127.5, planar CHW.
      const rgb = new Uint8ClampedArray(m.rgb);
      const n = m.w * m.h;
      const f = new Float32Array(3 * n);
      for (let i = 0, q = 0; i < n; i++, q += 3) {
        f[i] = (rgb[q] - 127.5) / 127.5;
        f[n + i] = (rgb[q + 1] - 127.5) / 127.5;
        f[2 * n + i] = (rgb[q + 2] - 127.5) / 127.5;
      }
      const { output } = await model({ input: new tf.Tensor("float32", f, [1, 3, m.h, m.w]) });
      const dims = output.dims;
      const oh = dims[dims.length - 2], ow = dims[dims.length - 1];
      const src = output.data;
      const a = new Uint8Array(ow * oh);
      for (let p = 0; p < a.length; p++) {
        const v = src[p] * 255;
        a[p] = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
      }
      self.postMessage({ type: "result", id: m.id, w: ow, h: oh, data: a }, [a.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, message: String(err?.message || err) });
  }
};
