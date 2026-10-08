/* Worker ONNX Runtime (WASM, CPU) — dipakai HANYA di iPad/tablet (PC tidak memakainya).
 *
 * Mengapa worker sendiri (bukan worker-proxy bawaan ONNX Runtime)?
 *  - Seluruh pemuatan model (parsing + optimasi graf) dan inferensi berjalan di luar thread utama → UI tidak pernah beku.
 *  - Bila macet / kehabisan memori, thread utama cukup memanggil worker.terminate(): seluruh heap WASM dibuang bersih
 *    dan model cadangan berjalan di mesin yang baru. Worker-proxy bawaan tidak bisa dimatikan & kegagalannya sering senyap.
 *  - Mengirim sinyal "hello" saat menyala, sehingga kegagalan worker menyala (Safari lama/WebView) langsung terdeteksi.
 *
 * Protokol (semua pesan berupa objek):
 *   → {type:'init', id, ortUrl, wasmPaths, model:ArrayBuffer, level}   ← {type:'ready', id, inputNames, outputNames, inputType, inputShape}
 *   → {type:'run', id, dtype, dims, data}                               ← {type:'result', id, dtype, dims, data}
 *   Beberapa sesi dalam satu worker (mis. encoder + decoder SAM): `key` pada init/run (bawaan 'main').
 *   → {type:'run', id, key, feeds:{nama:{dtype,dims,data}}}             ← {type:'result', id, outputs:{nama:{dtype,dims,data}}}
 *   ← {type:'hello'} saat worker menyala; ← {type:'error', id, message} untuk kegagalan apa pun.
 */

let ort = null;
/** sesi per kunci; 'main' = sesi tunggal (protokol lama) */
const sessions = new Map();

const msgOf = (e) => {
  if (!e) return 'galat tak dikenal';
  const m = e.message || String(e);
  return e.name && e.name !== 'Error' && !m.startsWith(e.name) ? e.name + ': ' + m : m;
};

async function handle(msg, post) {
  if (msg.type === 'init') {
    try {
      ort = ort || (await import(msg.ortUrl));
      ort.env.wasm.wasmPaths = msg.wasmPaths;
      ort.env.wasm.numThreads = 1; // tanpa SharedArrayBuffer di Safari iPad; thread tambahan hanya menambah risiko
      ort.env.wasm.proxy = false; // sudah berada di dalam worker
      ort.env.logLevel = 'error';
      post({ type: 'stage', id: msg.id, stage: 'parse' });
      const session = await ort.InferenceSession.create(new Uint8Array(msg.model), {
        executionProviders: ['wasm'],
        // 'basic' cukup untuk model terkuantisasi & jauh lebih hemat waktu/memori saat memuat daripada 'all'
        graphOptimizationLevel: msg.level || 'basic',
        enableCpuMemArena: false,
        enableMemPattern: false,
      });
      sessions.set(msg.key || 'main', session);
      const name = session.inputNames[0];
      const meta = session.inputMetadata && session.inputMetadata.find ? session.inputMetadata.find((x) => x.name === name) : null;
      post({
        type: 'ready',
        id: msg.id,
        inputNames: [...session.inputNames],
        outputNames: [...session.outputNames],
        inputType: meta && meta.type ? String(meta.type) : 'float32',
        inputShape: meta && meta.shape ? [...meta.shape] : [],
      });
    } catch (e) {
      post({ type: 'error', id: msg.id, message: msgOf(e) });
    }
    return;
  }
  if (msg.type === 'run') {
    try {
      const session = sessions.get(msg.key || 'main');
      if (!session) throw new Error('Sesi model belum siap');
      if (msg.feeds) {
        // banyak masukan → semua keluaran dikirim balik
        const feeds = {};
        for (const k of Object.keys(msg.feeds)) {
          const f = msg.feeds[k];
          feeds[k] = new ort.Tensor(f.dtype, f.data, f.dims);
        }
        const out = await session.run(feeds);
        const outputs = {};
        const transfer = [];
        for (const k of Object.keys(out)) {
          const copy = out[k].data.slice();
          outputs[k] = { dtype: out[k].type, dims: [...out[k].dims], data: copy };
          transfer.push(copy.buffer);
        }
        post({ type: 'result', id: msg.id, outputs }, transfer);
        return;
      }
      const input = new ort.Tensor(msg.dtype, msg.data, msg.dims);
      const out = await session.run({ [session.inputNames[0]]: input });
      const t = out[session.outputNames[0]];
      const raw = t.data;
      const copy = raw.slice(); // salinan yang bisa dipindahkan (data asli milik heap WASM)
      post({ type: 'result', id: msg.id, dtype: t.type, dims: [...t.dims], data: copy }, [copy.buffer]);
    } catch (e) {
      post({ type: 'error', id: msg.id, message: msgOf(e) });
    }
  }
}

if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  // peramban
  const post = (m, t) => self.postMessage(m, t || []);
  self.onmessage = (e) => void handle(e.data, post);
  self.addEventListener('unhandledrejection', (e) => post({ type: 'error', id: -1, message: msgOf(e.reason) }));
  post({ type: 'hello' });
} else {
  // Node (hanya untuk pengujian otomatis)
  import('node:worker_threads').then(({ parentPort }) => {
    const post = (m, t) => parentPort.postMessage(m, t || []);
    parentPort.on('message', (m) => void handle(m, post));
    post({ type: 'hello' });
  });
}
