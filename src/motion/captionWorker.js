/* Worker Auto Caption: menjalankan Whisper (Xenova) di thread terpisah supaya halaman TIDAK macet/"unresponsive"
 * selama transkripsi, dan bisa dibatalkan (worker di-terminate). Lihat autoCaption.js. */
let current = { id: null, pipe: null };

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "transcribe") {
      const tf = await import("@xenova/transformers");
      tf.env.allowLocalModels = false;
      if (current.id !== m.model || !current.pipe) {
        self.postMessage({ type: "status", message: "Memuat model Whisper…", fraction: 0 });
        current = { id: m.model, pipe: null };
        current.pipe = await tf.pipeline("automatic-speech-recognition", m.model, {
          quantized: true,
          progress_callback: (p) => {
            if (p?.status === "progress" && typeof p.progress === "number") self.postMessage({ type: "status", message: "Mengunduh model Whisper…", fraction: p.progress / 100 * 0.4 });
          },
        });
      }
      self.postMessage({ type: "status", message: "Mengenali ucapan…", fraction: 0.45 });
      let done = 0;
      const totalChunks = Math.max(1, Math.ceil(m.pcm.length / 16000 / 25));
      const result = await current.pipe(m.pcm, {
        language: m.language,
        task: "transcribe",
        return_timestamps: "word",
        chunk_length_s: 30,
        stride_length_s: 5,
        chunk_callback: () => {
          done++;
          self.postMessage({ type: "status", message: `Mengenali ucapan… (${Math.min(done, totalChunks)}/${totalChunks})`, fraction: 0.45 + 0.5 * Math.min(1, done / totalChunks) });
        },
      });
      self.postMessage({ type: "result", result: { text: result?.text, chunks: result?.chunks, segments: result?.segments } });
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String(err?.message || err) });
  }
};
