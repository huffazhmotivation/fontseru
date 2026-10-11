/**
 * Pustaka SFX Motion (tanpa musik): whoosh/swoosh, pop, impact, riser, glitch, UI, dll.
 * Semua DISINTESIS di perangkat (WebAudio → WAV) — tanpa unduhan, tanpa hak cipta, jalan offline.
 * Tiap efek dirender saat dibutuhkan lalu di-cache.
 */

const SR = 44100;

/* ---------- bantu ---------- */
function noiseBuffer(ctx, seconds, color = "white") {
  const len = Math.max(1, Math.ceil(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (color === "pink") { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25; }
    else d[i] = w;
  }
  return buf;
}
const env = (g, t0, points) => { // points: [[time, value], ...] eksponensial/linear aman
  g.gain.setValueAtTime(Math.max(points[0][1], 0.0001), t0 + points[0][0]);
  for (let i = 1; i < points.length; i++) g.gain.linearRampToValueAtTime(Math.max(points[i][1], 0.0001), t0 + points[i][0]);
};
function noiseSrc(ctx, dur, color) { const s = ctx.createBufferSource(); s.buffer = noiseBuffer(ctx, dur + 0.05, color); return s; }
function osc(ctx, type, freq) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; return o; }
function sweepNoise(ctx, dur, { from, to, q = 1, type = "bandpass", peak = 0.9, attack = 0.35, color = "white" }) {
  const n = noiseSrc(ctx, dur, color), f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(from, 0); f.frequency.exponentialRampToValueAtTime(to, dur * 0.95);
  env(g, 0, [[0, 0.0001], [dur * attack, peak], [dur, 0.0001]]);
  n.connect(f); f.connect(g); g.connect(ctx.destination);
  n.start(0); n.stop(dur);
}
function tone(ctx, { type = "sine", f0, f1, t0 = 0, dur, peak = 0.7, attack = 0.005, curve = "exp" }) {
  const o = osc(ctx, type, f0), g = ctx.createGain();
  o.frequency.setValueAtTime(f0, t0);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  if (curve === "exp") g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); else g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(ctx.destination);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
function clickBurst(ctx, t0, { hp = 2500, dur = 0.03, peak = 0.7 }) {
  const n = noiseSrc(ctx, dur, "white"), f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = "highpass"; f.frequency.value = hp;
  g.gain.setValueAtTime(peak, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  n.connect(f); f.connect(g); g.connect(ctx.destination);
  n.start(t0); n.stop(t0 + dur + 0.02);
}
function tail(ctx, t0, dur, { lp = 1800, peak = 0.25 }) { // ekor "ruang" sederhana
  const n = noiseSrc(ctx, dur, "pink"), f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = "lowpass"; f.frequency.setValueAtTime(lp, t0); f.frequency.exponentialRampToValueAtTime(200, t0 + dur);
  g.gain.setValueAtTime(peak, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  n.connect(f); f.connect(g); g.connect(ctx.destination);
  n.start(t0); n.stop(t0 + dur);
}

/* ---------- resep ---------- */
export const SFX_CATEGORIES = ["Whoosh & Swoosh", "Pop & UI", "Impact & Hit", "Riser & Shake", "Glitch & Digital", "Lainnya"];

export const SFX_LIBRARY = [
  // Whoosh & Swoosh
  { id: "whoosh-fast", name: "Whoosh Cepat", cat: "Whoosh & Swoosh", dur: 0.7, build: (c) => sweepNoise(c, 0.7, { from: 400, to: 4200, q: 1.1, peak: 0.95, attack: 0.4 }) },
  { id: "swoosh-long", name: "Swoosh Panjang", cat: "Whoosh & Swoosh", dur: 1.3, build: (c) => sweepNoise(c, 1.3, { from: 180, to: 6500, q: 0.8, peak: 0.9, attack: 0.5, color: "pink" }) },
  { id: "whoosh-up", name: "Whoosh Naik", cat: "Whoosh & Swoosh", dur: 1.0, build: (c) => { sweepNoise(c, 1.0, { from: 300, to: 7000, q: 1.4, peak: 0.85, attack: 0.8 }); } },
  { id: "whoosh-down", name: "Whoosh Turun", cat: "Whoosh & Swoosh", dur: 0.9, build: (c) => sweepNoise(c, 0.9, { from: 6000, to: 250, q: 1.2, peak: 0.9, attack: 0.15 }) },
  { id: "whip-pan", name: "Whip Pan", cat: "Whoosh & Swoosh", dur: 0.45, build: (c) => { sweepNoise(c, 0.45, { from: 600, to: 5200, q: 2.2, peak: 1, attack: 0.3 }); tone(c, { type: "sawtooth", f0: 900, f1: 250, dur: 0.4, peak: 0.12 }); } },
  { id: "swipe", name: "Swipe Ringan", cat: "Whoosh & Swoosh", dur: 0.35, build: (c) => sweepNoise(c, 0.35, { from: 1500, to: 7500, q: 0.9, peak: 0.6, attack: 0.5 }) },
  { id: "swoosh-air", name: "Swoosh Udara", cat: "Whoosh & Swoosh", dur: 0.9, build: (c) => { sweepNoise(c, 0.9, { from: 900, to: 3200, q: 0.5, peak: 0.7, attack: 0.45, color: "pink" }); sweepNoise(c, 0.9, { from: 2000, to: 9000, q: 0.6, peak: 0.35, attack: 0.5 }); } },
  // Pop & UI
  { id: "pop", name: "Pop", cat: "Pop & UI", dur: 0.22, build: (c) => { tone(c, { f0: 820, f1: 190, dur: 0.16, peak: 0.9 }); clickBurst(c, 0, { hp: 3000, dur: 0.02, peak: 0.35 }); } },
  { id: "pop-bubble", name: "Pop Bubble", cat: "Pop & UI", dur: 0.3, build: (c) => { tone(c, { f0: 380, f1: 1250, dur: 0.14, peak: 0.8, attack: 0.01 }); tone(c, { f0: 1250, f1: 900, t0: 0.14, dur: 0.12, peak: 0.25 }); } },
  { id: "click", name: "Click", cat: "Pop & UI", dur: 0.12, build: (c) => { clickBurst(c, 0, { hp: 2200, dur: 0.035, peak: 0.9 }); tone(c, { f0: 1800, f1: 900, dur: 0.05, peak: 0.25 }); } },
  { id: "tap", name: "Tap Lembut", cat: "Pop & UI", dur: 0.2, build: (c) => tone(c, { f0: 640, f1: 420, dur: 0.14, peak: 0.8 }) },
  { id: "toggle", name: "Toggle On", cat: "Pop & UI", dur: 0.25, build: (c) => { tone(c, { f0: 520, dur: 0.08, peak: 0.5 }); tone(c, { f0: 780, t0: 0.07, dur: 0.14, peak: 0.55 }); } },
  { id: "ding", name: "Ding", cat: "Pop & UI", dur: 1.4, build: (c) => { [[880, 0.6], [2217, 0.25], [3320, 0.12]].forEach(([f, p], i) => tone(c, { f0: f, dur: 1.3 - i * 0.25, peak: p, attack: 0.003 })); } },
  { id: "notif", name: "Notifikasi", cat: "Pop & UI", dur: 0.7, build: (c) => { tone(c, { f0: 988, dur: 0.22, peak: 0.55 }); tone(c, { f0: 1319, t0: 0.15, dur: 0.5, peak: 0.55 }); } },
  { id: "success", name: "Sukses", cat: "Pop & UI", dur: 0.9, build: (c) => { [523, 659, 784, 1047].forEach((f, i) => tone(c, { type: "triangle", f0: f, t0: i * 0.1, dur: 0.5, peak: 0.45 })); } },
  { id: "error", name: "Error", cat: "Pop & UI", dur: 0.45, build: (c) => { tone(c, { type: "square", f0: 160, f1: 130, dur: 0.18, peak: 0.28, curve: "lin" }); tone(c, { type: "square", f0: 160, f1: 120, t0: 0.2, dur: 0.2, peak: 0.28, curve: "lin" }); } },
  { id: "coin", name: "Koin", cat: "Pop & UI", dur: 0.6, build: (c) => { tone(c, { type: "square", f0: 988, dur: 0.07, peak: 0.28, curve: "lin" }); tone(c, { type: "square", f0: 1319, t0: 0.07, dur: 0.4, peak: 0.28 }); } },
  // Impact & Hit
  { id: "impact-deep", name: "Impact Dalam", cat: "Impact & Hit", dur: 1.6, build: (c) => { tone(c, { f0: 95, f1: 32, dur: 1.2, peak: 1, attack: 0.002 }); sweepNoise(c, 0.5, { from: 2500, to: 120, q: 0.7, type: "lowpass", peak: 0.8, attack: 0.02 }); tail(c, 0, 1.5, { peak: 0.2 }); } },
  { id: "hit-cinematic", name: "Hit Sinematik", cat: "Impact & Hit", dur: 2.2, build: (c) => { tone(c, { f0: 70, f1: 28, dur: 1.8, peak: 1, attack: 0.003 }); tone(c, { type: "triangle", f0: 140, f1: 55, dur: 0.9, peak: 0.5 }); clickBurst(c, 0, { hp: 400, dur: 0.12, peak: 0.6 }); tail(c, 0, 2.1, { peak: 0.3, lp: 2600 }); } },
  { id: "bass-drop", name: "Bass Drop", cat: "Impact & Hit", dur: 1.6, build: (c) => { tone(c, { f0: 160, f1: 28, dur: 1.4, peak: 1, attack: 0.01, curve: "exp" }); tone(c, { type: "sawtooth", f0: 160, f1: 40, dur: 0.8, peak: 0.12 }); } },
  { id: "thud", name: "Thud", cat: "Impact & Hit", dur: 0.4, build: (c) => { tone(c, { f0: 120, f1: 45, dur: 0.3, peak: 1 }); clickBurst(c, 0, { hp: 300, dur: 0.04, peak: 0.4 }); } },
  { id: "slam", name: "Slam", cat: "Impact & Hit", dur: 0.9, build: (c) => { clickBurst(c, 0, { hp: 200, dur: 0.18, peak: 0.9 }); tone(c, { f0: 110, f1: 38, dur: 0.7, peak: 0.95 }); tail(c, 0, 0.8, { peak: 0.25, lp: 3000 }); } },
  { id: "punch", name: "Punch / Zoom Hit", cat: "Impact & Hit", dur: 0.5, build: (c) => { tone(c, { f0: 200, f1: 60, dur: 0.22, peak: 1 }); clickBurst(c, 0, { hp: 800, dur: 0.05, peak: 0.6 }); sweepNoise(c, 0.3, { from: 3000, to: 400, q: 0.8, peak: 0.5, attack: 0.05 }); } },
  // Riser & Shake
  { id: "riser", name: "Riser", cat: "Riser & Shake", dur: 3.0, build: (c) => { sweepNoise(c, 3.0, { from: 250, to: 9000, q: 1.6, peak: 0.8, attack: 0.95 }); tone(c, { type: "sawtooth", f0: 110, f1: 880, dur: 3.0, peak: 0.14, attack: 2.4, curve: "lin" }); } },
  { id: "reverse-swell", name: "Reverse Swell", cat: "Riser & Shake", dur: 1.6, build: (c) => { sweepNoise(c, 1.6, { from: 500, to: 5000, q: 0.7, peak: 0.9, attack: 0.9, color: "pink" }); } },
  { id: "shake-rumble", name: "Shake Rumble", cat: "Riser & Shake", dur: 0.9, build: (c) => { const n = noiseSrc(c, 0.9, "pink"), f = c.createBiquadFilter(), g = c.createGain(), lfo = osc(c, "sine", 22), lg = c.createGain(); f.type = "lowpass"; f.frequency.value = 420; env(g, 0, [[0, 0.0001], [0.06, 0.9], [0.55, 0.6], [0.9, 0.0001]]); lg.gain.value = 0.35; lfo.connect(lg); lg.connect(g.gain); n.connect(f); f.connect(g); g.connect(c.destination); n.start(0); n.stop(0.9); lfo.start(0); lfo.stop(0.9); tone(c, { f0: 60, f1: 45, dur: 0.85, peak: 0.55, attack: 0.04, curve: "lin" }); } },
  { id: "shake-hit", name: "Shake Hit", cat: "Riser & Shake", dur: 0.7, build: (c) => { tone(c, { f0: 90, f1: 40, dur: 0.5, peak: 1 }); const n = noiseSrc(c, 0.7, "pink"), f = c.createBiquadFilter(), g = c.createGain(); f.type = "lowpass"; f.frequency.value = 900; env(g, 0, [[0, 0.9], [0.1, 0.5], [0.7, 0.0001]]); n.connect(f); f.connect(g); g.connect(c.destination); n.start(0); n.stop(0.7); } },
  { id: "tension", name: "Tension Naik", cat: "Riser & Shake", dur: 2.0, build: (c) => { tone(c, { type: "triangle", f0: 220, f1: 440, dur: 2.0, peak: 0.4, attack: 1.7, curve: "lin" }); tone(c, { type: "triangle", f0: 223, f1: 447, dur: 2.0, peak: 0.4, attack: 1.7, curve: "lin" }); sweepNoise(c, 2.0, { from: 800, to: 6000, q: 1, peak: 0.35, attack: 0.9 }); } },
  // Glitch & Digital
  { id: "glitch", name: "Glitch", cat: "Glitch & Digital", dur: 0.55, build: (c) => { for (let i = 0; i < 9; i++) { const t0 = i * 0.055 + Math.random() * 0.02; tone(c, { type: i % 2 ? "square" : "sawtooth", f0: 200 + Math.random() * 3000, f1: 100 + Math.random() * 2500, t0, dur: 0.03 + Math.random() * 0.04, peak: 0.25, curve: "lin" }); clickBurst(c, t0, { hp: 1500, dur: 0.02, peak: 0.3 }); } } },
  { id: "static", name: "Static Digital", cat: "Glitch & Digital", dur: 0.45, build: (c) => { const n = noiseSrc(c, 0.45, "white"), g = c.createGain(); env(g, 0, [[0, 0.0001], [0.02, 0.5], [0.12, 0.1], [0.2, 0.45], [0.3, 0.05], [0.45, 0.0001]]); n.connect(g); g.connect(c.destination); n.start(0); n.stop(0.45); } },
  { id: "zap", name: "Zap", cat: "Glitch & Digital", dur: 0.35, build: (c) => { tone(c, { type: "sawtooth", f0: 2400, f1: 160, dur: 0.28, peak: 0.45, curve: "lin" }); clickBurst(c, 0, { hp: 3000, dur: 0.03, peak: 0.4 }); } },
  { id: "power-up", name: "Power Up", cat: "Glitch & Digital", dur: 0.9, build: (c) => { tone(c, { type: "square", f0: 220, f1: 1760, dur: 0.7, peak: 0.2, curve: "lin", attack: 0.02 }); tone(c, { type: "triangle", f0: 440, f1: 3520, dur: 0.7, peak: 0.25, curve: "lin" }); } },
  { id: "power-down", name: "Power Down", cat: "Glitch & Digital", dur: 0.9, build: (c) => { tone(c, { type: "square", f0: 1760, f1: 110, dur: 0.8, peak: 0.2, curve: "lin" }); } },
  // Lainnya
  { id: "shutter", name: "Shutter Kamera", cat: "Lainnya", dur: 0.35, build: (c) => { clickBurst(c, 0, { hp: 1200, dur: 0.03, peak: 0.9 }); clickBurst(c, 0.07, { hp: 800, dur: 0.05, peak: 0.7 }); tone(c, { f0: 1100, f1: 500, t0: 0.07, dur: 0.1, peak: 0.12 }); } },
  { id: "typing", name: "Ketik", cat: "Lainnya", dur: 0.8, build: (c) => { [0, 0.12, 0.2, 0.34, 0.47, 0.58].forEach((t) => clickBurst(c, t, { hp: 1800 + Math.random() * 800, dur: 0.03, peak: 0.7 })); } },
  { id: "sparkle", name: "Kilau / Sparkle", cat: "Lainnya", dur: 1.2, build: (c) => { for (let i = 0; i < 14; i++) tone(c, { f0: 2000 + Math.random() * 5000, t0: Math.random() * 0.7, dur: 0.25 + Math.random() * 0.25, peak: 0.12 + Math.random() * 0.1, attack: 0.004 }); } },
  { id: "magic", name: "Magic Chime", cat: "Lainnya", dur: 1.6, build: (c) => { [1047, 1319, 1568, 2093, 2637].forEach((f, i) => tone(c, { f0: f, t0: i * 0.07, dur: 1.1, peak: 0.28, attack: 0.004 })); } },
  { id: "slide-pop", name: "Slide Pop", cat: "Lainnya", dur: 0.45, build: (c) => { sweepNoise(c, 0.3, { from: 800, to: 3800, q: 1, peak: 0.45, attack: 0.5 }); tone(c, { f0: 600, f1: 220, t0: 0.26, dur: 0.16, peak: 0.8 }); } },
  { id: "heartbeat", name: "Detak Jantung", cat: "Lainnya", dur: 1.1, build: (c) => { tone(c, { f0: 70, f1: 40, dur: 0.18, peak: 1 }); tone(c, { f0: 62, f1: 38, t0: 0.22, dur: 0.22, peak: 0.85 }); tone(c, { f0: 70, f1: 40, t0: 0.8, dur: 0.18, peak: 1 }); } },
];

/* ---------- render → WAV ---------- */
function encodeWav(buffer) {
  const ch = buffer.numberOfChannels, len = buffer.length, sr = buffer.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); out.setUint32(4, 36 + len * ch * 2, true); w(8, "WAVE"); w(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, sr, true);
  out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  let peak = 0.0001;
  for (const d of chans) for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  const norm = Math.min(1.6, 0.89 / peak); // normalisasi ke ≈ -1 dBFS
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, chans[c][i] * norm)); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Blob([out], { type: "audio/wav" });
}

const fileCache = new Map();
export async function renderSfxFile(id) {
  if (fileCache.has(id)) return fileCache.get(id);
  const def = SFX_LIBRARY.find((s) => s.id === id);
  if (!def) throw new Error("SFX tidak ditemukan");
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctor(2, Math.ceil(SR * def.dur), SR);
  def.build(ctx);
  const rendered = await ctx.startRendering();
  const file = new File([encodeWav(rendered)], `SFX ${def.name}.wav`, { type: "audio/wav" });
  fileCache.set(id, file);
  return file;
}

let previewEl = null;
export async function previewSfx(id) {
  const file = await renderSfxFile(id);
  if (!previewEl) previewEl = new Audio();
  previewEl.pause();
  if (previewEl.__url) URL.revokeObjectURL(previewEl.__url);
  previewEl.__url = URL.createObjectURL(file);
  previewEl.src = previewEl.__url;
  previewEl.currentTime = 0;
  await previewEl.play().catch(() => {});
}
