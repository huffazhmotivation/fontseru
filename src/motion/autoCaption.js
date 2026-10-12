/**
 * Auto Caption — browser-based speech-to-text using Whisper via
 * @xenova/transformers. Runs entirely in the browser (no server),
 * supports Indonesian and other languages.
 *
 * Lazy-loaded: the model (~75MB) is only fetched on first use, then cached
 * by the browser's network/service worker.
 */
const LANGUAGE_MAP = {
  id: { label: "Indonesian", whisperLang: "id" },
  en: { label: "English", whisperLang: "en" },
  ja: { label: "Japanese", whisperLang: "ja" },
  ko: { label: "Korean", whisperLang: "ko" },
  ms: { label: "Malay", whisperLang: "ms" },
  jv: { label: "Javanese", whisperLang: "id" }, // Whisper has no Javanese; fall back to Indonesian
  su: { label: "Sundanese", whisperLang: "id" }, // same fallback
  zh: { label: "Chinese", whisperLang: "zh" },
  ar: { label: "Arabic", whisperLang: "ar" },
  hi: { label: "Hindi", whisperLang: "hi" },
  es: { label: "Spanish", whisperLang: "es" },
  pt: { label: "Portuguese", whisperLang: "pt" },
  fr: { label: "French", whisperLang: "fr" },
  de: { label: "German", whisperLang: "de" },
};

export function getLanguageOptions() {
  return Object.entries(LANGUAGE_MAP).map(([code, { label }]) => ({ code, label }));
}

/**
 * Decode an audio File/Blob to a Web Audio AudioBuffer (mono float32 PCM).
 */
export async function decodeAudioFile(file) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    return audioBuffer;
  } finally {
    try { await ctx.close(); } catch (_) {}
  }
}

/**
 * Siapkan audio untuk Whisper: mono 16 kHz lewat resampler WebAudio (dengan anti-alias, bukan interpolasi linear),
 * high-pass 90 Hz (buang dengung/rumble), kompresor dinamis (mengangkat suara pelan), lalu normalisasi puncak.
 * Membuat ucapan yang kecil/kurang jelas jauh lebih terdeteksi.
 */
async function preparePcm(audioBuffer) {
  const sr = 16000;
  const length = Math.max(1, Math.ceil(audioBuffer.duration * sr));
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctor(1, length, sr);
  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 90; hp.Q.value = 0.7;
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 7600; lp.Q.value = 0.7;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -42; comp.knee.value = 28; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.2;
  src.connect(hp); hp.connect(lp); lp.connect(comp); comp.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  const pcm = rendered.getChannelData(0).slice();
  let peak = 1e-6;
  for (let i = 0; i < pcm.length; i++) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
  const gain = Math.min(14, 0.95 / peak);
  if (gain > 1.05) for (let i = 0; i < pcm.length; i++) pcm[i] *= gain;
  return pcm;
}

/** Energi per jendela 50 ms (RMS) — dipakai membuang kata "halusinasi" Whisper di bagian hening. */
function energyEnvelope(pcm, sr = 16000, winMs = 50) {
  const win = Math.round((sr * winMs) / 1000);
  const n = Math.max(1, Math.floor(pcm.length / win));
  const env = new Float32Array(n);
  for (let w = 0; w < n; w++) {
    let sum = 0;
    for (let i = w * win; i < (w + 1) * win; i++) sum += pcm[i] * pcm[i];
    env[w] = Math.sqrt(sum / win);
  }
  const sorted = Array.from(env).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const speechLevel = sorted[Math.floor(sorted.length * 0.9)] || 0;
  return { env, winMs, threshold: Math.max(floor * 2.2, speechLevel * 0.06, 0.004) };
}

let worker = null;
let activeJob = null;
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./captionWorker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    if (!activeJob) return;
    if (m.type === "status") activeJob.onProgress?.(m.message, m.fraction);
    else if (m.type === "result") { const j = activeJob; activeJob = null; j.resolve(m.result); }
    else if (m.type === "error") { const j = activeJob; activeJob = null; j.reject(new Error(m.message)); }
  };
  worker.onerror = (ev) => { const j = activeJob; activeJob = null; j?.reject(new Error(ev.message || "Worker transkripsi gagal")); };
  return worker;
}
/** Batalkan transkripsi yang sedang berjalan (worker dihentikan; model dimuat ulang dari cache pada proses berikutnya). */
export function cancelTranscription() {
  if (worker) { worker.terminate(); worker = null; }
  if (activeJob) { const j = activeJob; activeJob = null; j.reject(new DOMException("Dibatalkan", "AbortError")); }
}

export const CAPTION_QUALITY = [
  { id: "accurate", label: "Teliti (lebih peka, suara kurang jelas)", model: "Xenova/whisper-small" },
  { id: "fast", label: "Cepat (model ringan)", model: "Xenova/whisper-base" },
];

/**
 * Transcribe an AudioBuffer and return caption segments.
 * Berjalan di Web Worker — halaman tetap responsif.
 *
 * @returns {Promise<Array<{text:string, start:number, end:number}>>} start/end dalam milidetik
 */
export async function transcribeAudio(audioBuffer, language = "id", onProgress, quality = "accurate") {
  const langMeta = LANGUAGE_MAP[language] || LANGUAGE_MAP.id;
  const model = (CAPTION_QUALITY.find((q) => q.id === quality) || CAPTION_QUALITY[0]).model;

  onProgress?.("Menyiapkan audio (filter & penguatan suara)…", 0.02);
  const pcm = await preparePcm(audioBuffer);
  const envelope = energyEnvelope(pcm);

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      if (activeJob) { reject(new Error("Transkripsi lain masih berjalan.")); return; }
      activeJob = { resolve, reject, onProgress };
      getWorker().postMessage({ type: "transcribe", model, language: langMeta.whisperLang, pcm }, [pcm.buffer]);
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new Error(`Gagal menjalankan transkripsi: ${err.message || err}. Periksa koneksi internet (model diunduh saat pertama kali).`);
  }
  onProgress?.("Merapikan hasil…", 0.97);

  // Normalisasi hasil — bisa berupa `chunks` (per kata), `segments`, atau hanya `text`.
  const normalized = [];
  const pushWord = (text, start, end) => {
    const clean = (text || "").trim();
    if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return;
    const s = Number.isFinite(start) ? start : 0;
    const e = Number.isFinite(end) && end > s ? end : s + 0.25;
    normalized.push({ text: clean, start: Math.round(s * 1000), end: Math.round(e * 1000) });
  };
  if (Array.isArray(result?.chunks) && result.chunks.length > 0) {
    for (const ch of result.chunks) {
      const ts = ch.timestamp || ch.timestamps?.[0] || [0, 0];
      const text = String(ch.text || "").trim();
      const parts = text.split(/\s+/).filter(Boolean);
      if (parts.length <= 1) { pushWord(text, ts[0], ts[1]); continue; }
      const start = Number(ts[0]) || 0;
      const end = Number(ts[1]) > start ? Number(ts[1]) : start + parts.length * 0.25;
      const totalChars = Math.max(parts.reduce((sum, part) => sum + part.length, 0), 1);
      let cursor = start;
      for (const part of parts) {
        const span = Math.max((end - start) * (part.length / totalChars), 0.08);
        pushWord(part, cursor, Math.min(end, cursor + span));
        cursor += span;
      }
    }
  } else if (Array.isArray(result?.segments) && result.segments.length > 0) {
    for (const seg of result.segments) {
      const words = (seg.text || "").trim().split(/\s+/).filter(Boolean);
      const start = Number(seg.timestamp?.[0] ?? 0);
      const end = Number(seg.timestamp?.[1] ?? start + Math.max(words.length * 0.25, 0.25));
      const totalChars = Math.max(words.reduce((sum, word) => sum + word.length, 0), 1);
      let cursor = start;
      for (const word of words) {
        const span = Math.max((end - start) * (word.length / totalChars), 0.12);
        pushWord(word, cursor, Math.min(end, cursor + span));
        cursor += span;
      }
    }
  } else if (result?.text) {
    const words = result.text.trim().split(/\s+/).filter(Boolean);
    const total = Math.max(audioBuffer.duration, words.length * 0.25);
    words.forEach((word, i) => pushWord(word, (i / words.length) * total, ((i + 1) / words.length) * total));
  }

  // Buang "halusinasi" di bagian hening: kata yang hampir seluruh rentangnya di bawah ambang energi suara.
  const { env, winMs, threshold } = envelope;
  const voiced = (startMs, endMs) => {
    const a = Math.max(0, Math.floor(startMs / winMs)), b = Math.min(env.length - 1, Math.max(a, Math.floor(endMs / winMs)));
    let hit = 0;
    for (let i = a; i <= b; i++) if (env[i] >= threshold) hit++;
    return hit / (b - a + 1) >= 0.25;
  };
  const filtered = normalized.filter((w) => voiced(w.start, w.end));
  // Buang pengulangan beruntun yang mencurigakan (loop halusinasi: kata sama ≥4× berturut-turut).
  const out = [];
  for (const w of filtered) {
    const n = out.length;
    if (n >= 3 && [1, 2, 3].every((k) => out[n - k].text.toLowerCase() === w.text.toLowerCase())) continue;
    out.push(w);
  }
  onProgress?.("Selesai!", 1);
  // Bila filter membuang hampir semuanya (ambang terlalu ketat untuk audio ini), percayai hasil Whisper apa adanya.
  return filtered.length >= normalized.length * 0.2 ? out : normalized;
}

/**
 * Gabungkan hasil timestamp per kata menjadi caption per kalimat.
 * Pemisahan terjadi setelah tanda baca akhir kalimat atau jeda ucapan
 * yang cukup panjang. Timestamp kalimat tetap mencakup kata pertama sampai
 * kata terakhirnya.
 */
export function groupCaptionSentences(words, gapMs = 900) {
  if (!Array.isArray(words) || words.length === 0) return [];
  const result = [];
  let current = null;
  for (const word of words) {
    const text = String(word?.text || "").trim();
    if (!text) continue;
    const start = Number.isFinite(word?.start) ? word.start : 0;
    const end = Number.isFinite(word?.end) && word.end > start ? word.end : start + 250;
    const gap = current ? Math.max(0, start - current.end) : 0;
    // Tanda baca dicek pada AKHIR kalimat berjalan (kata sebelumnya), bukan
    // pada kata yang baru masuk — supaya "Halo." menutup kalimat sebelum
    // kata berikutnya, bukan malah menempel ke kalimat sebelumnya.
    const prevText = current ? current.text : "";
    const punctuation = /[.!?。！？؟…]$/.test(prevText);
    const naturalBreak = /[,;:]$/.test(prevText) && gap >= 350;
    const shouldSplit = current && (gap >= gapMs || punctuation || naturalBreak);
    if (shouldSplit) {
      result.push(current);
      current = null;
    }
    if (!current) current = { text, start, end };
    else {
      current.text += ` ${text}`;
      current.end = Math.max(current.end, end);
    }
  }
  if (current) result.push(current);
  return result;
}

/**
 * Split long caption text into short lines for display (max ~40 chars each).
 * Returns an array of string lines.
 */
export function splitCaptionText(text, maxChars = 40) {
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const words = text.split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    if (current && (current.length + 1 + word.length) > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);

  return lines.length > 0 ? lines : [text];
}

/* ------------------------------------------------------------------
 * Caption per kalimat/frasa yang "pintar".
 * Tidak lagi memotong buta tiap N kata. Urutan keputusan:
 *  1. Batas keras: tanda akhir kalimat (. ! ? …) atau jeda ucapan panjang.
 *  2. Di dalam satu kalimat yang lebih panjang dari `maxWords`, potongan
 *     dipilih lewat DP supaya (a) ukuran tiap potongan seimbang, (b) potongan
 *     jatuh di koma / jeda napas / sebelum kata sambung (dan, yang, karena,
 *     tapi, and, but ...), (c) tidak berakhir di kata tugas (di, ke, dari,
 *     the, of ...), (d) tidak ada potongan sisa satu kata, (e) tidak terlalu
 *     panjang (karakter / durasi).
 *  3. Waktu tiap caption = kata pertama sampai kata terakhir (presisi);
 *     celah kecil antar caption (< 250 ms) ditutup agar tidak berkedip.
 * ------------------------------------------------------------------ */
const FUNCTION_WORDS = new Set([
  // Indonesia
  "di", "ke", "dari", "pada", "yang", "dan", "atau", "dengan", "untuk", "dalam", "oleh", "bagi", "kepada", "akan", "sudah", "telah",
  "sedang", "ini", "itu", "para", "sang", "si", "adalah", "ialah", "agar", "supaya", "karena", "tapi", "tetapi", "namun", "serta", "juga", "sebagai", "seperti", "bahwa", "jika", "kalau", "bila",
  // English
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "with", "by", "from", "and", "or", "but", "that", "which", "who", "is", "are", "was", "were", "be", "as", "if", "so", "than", "my", "your", "our", "their", "his", "her", "its",
]);
const BREAK_BEFORE = new Set([
  "dan", "yang", "tapi", "tetapi", "namun", "karena", "sebab", "agar", "supaya", "atau", "serta", "sehingga", "ketika", "saat", "jika", "kalau", "bila", "dengan", "untuk", "padahal", "sedangkan", "lalu", "kemudian", "maka",
  "and", "but", "because", "that", "which", "when", "while", "so", "or", "if", "with", "then",
]);
const bareWord = (t) => String(t || "").toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

function splitBlockSmart(block, maxWords, maxChars, maxDurMs) {
  const n = block.length;
  if (n === 0) return [];
  const chars = (a, b) => block.slice(a, b).reduce((s, w) => s + w.text.length + 1, -1);
  const dur = (a, b) => block[b - 1].end - block[a].start;
  if (n <= maxWords && chars(0, n) <= maxChars * 1.4 && dur(0, n) <= maxDurMs) return [[0, n]];

  const minChunks = Math.max(Math.ceil(n / maxWords), Math.ceil(chars(0, n) / maxChars));
  const target = n / minChunks;

  const breakCost = (i) => { // memotong di antara block[i-1] dan block[i]
    if (i >= n) return 0;
    const prev = block[i - 1], next = block[i];
    let c = 0;
    if (/[,;:–—]$/.test(prev.text)) c -= 3;
    c -= Math.min(Math.max(next.start - prev.end, 0) / 120, 4);
    if (BREAK_BEFORE.has(bareWord(next.text))) c -= 1.5;
    if (FUNCTION_WORDS.has(bareWord(prev.text))) c += 4;
    return c;
  };

  const dp = new Array(n + 1).fill(Infinity);
  const from = new Array(n + 1).fill(-1);
  dp[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let len = 1; len <= Math.min(maxWords + 1, i); len++) {
      const j = i - len;
      if (dp[j] === Infinity) continue;
      let cost = (len - target) ** 2;
      if (len === maxWords + 1) cost += 3; // boleh sedikit melebihi, tapi mahal
      if (len === 1 && n > 1) cost += 4;   // hindari potongan satu kata
      const ch = chars(j, i);
      if (ch > maxChars) cost += (ch - maxChars) * 0.4;
      const d = dur(j, i);
      if (d > maxDurMs) cost += (d - maxDurMs) / 400;
      cost += breakCost(i) + 1.2; // +1.2: sedikit hukuman per potongan agar tidak terlalu banyak
      if (dp[j] + cost < dp[i]) { dp[i] = dp[j] + cost; from[i] = j; }
    }
  }
  const out = [];
  for (let i = n; i > 0; i = from[i]) {
    if (from[i] < 0) return [[0, n]];
    out.unshift([from[i], i]);
  }
  return out;
}

/**
 * @param {Array<{text:string,start:number,end:number}>} words  per kata (ms)
 * @param {{maxWords?:number,maxChars?:number,maxDurMs?:number,gapMs?:number}} [opts]
 */
export function smartCaptionSegments(words, opts = {}) {
  const maxWords = Math.max(1, Math.round(opts.maxWords ?? 4));
  const maxChars = opts.maxChars ?? Math.max(24, maxWords * 9);
  const maxDurMs = opts.maxDurMs ?? 3800;
  const gapMs = opts.gapMs ?? 700;
  const list = (words || []).filter((w) => w && String(w.text || "").trim());
  const blocks = [];
  let cur = [];
  for (const w of list) {
    const prev = cur[cur.length - 1];
    if (prev && (/[.!?。！？؟…]$/.test(prev.text) || w.start - prev.end >= gapMs)) { blocks.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) blocks.push(cur);

  const segments = [];
  for (const block of blocks) {
    for (const [a, b] of splitBlockSmart(block, maxWords, maxChars, maxDurMs)) {
      const g = block.slice(a, b);
      segments.push({ text: g.map((w) => w.text).join(" "), start: g[0].start, end: g[g.length - 1].end });
    }
  }
  for (let i = 0; i < segments.length - 1; i++) {
    const gap = segments[i + 1].start - segments[i].end;
    if (gap > 0 && gap < 250) segments[i].end = segments[i + 1].start;
  }
  return segments;
}
