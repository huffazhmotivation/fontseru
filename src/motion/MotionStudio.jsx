import React, { useRef, useEffect, useState, useReducer, useCallback, useMemo, useImperativeHandle } from "react";
import { ModeTabs } from "@/mode/ModeTabs";
import { loadMotionProject, saveMotionProject, clearMotionProject, serializeProjectForExport, deserializeImportedProject } from "@/motion/motionPersist";
import {
  Play, Pause, Upload, Plus, Trash2, Type, Sparkles, Repeat,
  GripVertical, RotateCcw, Wand2, Move, Image as ImageIcon,
  Film, Music, Wand, Volume2, VolumeX, Palette, Loader2, Clapperboard,
  Smartphone, Square, RectangleVertical, RectangleHorizontal, Monitor,
  Settings2, X, AlertTriangle, Undo2, Redo2, Eye,
  Feather, Minus, Gem, LayoutGrid, Zap, Keyboard, Cpu, Activity,
  Focus, MoveHorizontal, Rocket, CloudFog, FlipHorizontal, Tv, Ban,
  Waves, Wind, Flame, TrendingUp, AlignJustify,
  Sun, MoonStar,
  AlignLeft, AlignCenter, AlignRight,
  Download, FolderOpen, FilePlus2,
} from "lucide-react";

/* ============================================================
   MATH HELPERS
   ============================================================ */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function cubicBezier(p1x, p1y, p2x, p2y, t) {
  const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
  const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
  const sampleX = (u) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u) => ((ay * u + by) * u + cy) * u;
  let u = t;
  for (let i = 0; i < 8; i++) {
    const x = sampleX(u) - t;
    if (Math.abs(x) < 1e-4) break;
    const d = (3 * ax * u + 2 * bx) * u + cx || 1e-6;
    u -= x / d;
  }
  return sampleY(u);
}

function ease(kind, t) {
  t = clamp(t, 0, 1);
  switch (kind) {
    case "linear": return t;
    case "easeIn": return t * t * t;
    case "easeOut": return 1 - Math.pow(1 - t, 3);
    case "easeInOut": return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    default: return t;
  }
}

function elasticOut(t, amp = 1) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c4 = (2 * Math.PI) / 3;
  return 1 + Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) * amp;
}

/* ============================================================
   PRESET LIBRARY (animasi per-huruf/kata/baris untuk klip teks)
   ============================================================ */

const REST_POSE = { x: 0, y: 0, opacity: 1, scale: 1, rotation: 0, blur: 0, letterSpacing: 0 };
const pose = (overrides) => ({ ...REST_POSE, ...overrides });

const PRESET_LIB = [
  { id: "none", name: "Tanpa Animasi (Statis)", animateBy: "all", stagger: 0, entranceMs: 1, exitMs: 0, icon: Ban,
    curve: () => pose({}) },
  { id: "apple", name: "Apple Style", animateBy: "char", stagger: 35, entranceMs: 420, exitMs: 360, icon: Feather,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, y: 22 * (1 - e), scale: 0.94 + 0.06 * e, blur: 5 * (1 - e) }); } },
  { id: "minimal", name: "Minimal", animateBy: "word", stagger: 60, entranceMs: 480, exitMs: 400, icon: Minus,
    curve: (t) => pose({ opacity: ease("linear", t) }) },
  { id: "luxury", name: "Luxury", animateBy: "line", stagger: 150, entranceMs: 1000, exitMs: 650, icon: Gem,
    curve: (t) => { const e = ease("easeInOut", t); return pose({ opacity: e, blur: 8 * (1 - e), letterSpacing: 16 * (1 - e) }); } },
  { id: "cinematic", name: "Cinematic", animateBy: "all", stagger: 0, entranceMs: 650, exitMs: 450, icon: Clapperboard,
    curve: (t) => { const e = cubicBezier(0.16, 1, 0.3, 1, t); const eo = ease("easeOut", t); return pose({ opacity: eo, scale: 1.35 - 0.35 * e, blur: 22 * (1 - eo) }); } },
  { id: "modernui", name: "Modern UI", animateBy: "word", stagger: 70, entranceMs: 560, exitMs: 380, icon: LayoutGrid,
    curve: (t) => { const eo = ease("easeOut", Math.min(t * 2.6, 1)); const ey = elasticOut(t, 1); return pose({ opacity: eo, y: 34 * (1 - ey) }); } },
  { id: "neon", name: "Neon Pulse", animateBy: "word", stagger: 50, entranceMs: 480, exitMs: 360, icon: Zap,
    curve: (t) => { const eo = ease("easeOut", t); const eb = elasticOut(t, 0.35); return pose({ opacity: eo, scale: 0.85 + 0.15 * eb, blur: 12 * (1 - eo), y: 6 * (1 - eo) }); } },
  { id: "typewriter", name: "Typewriter", animateBy: "char", stagger: 45, entranceMs: 60, exitMs: 200, icon: Keyboard,
    curve: (t) => pose({ opacity: t < 0.4 ? 0 : 1, scale: t < 0.4 ? 1.15 : 1 }) },
  { id: "glitch", name: "Glitch Digital", animateBy: "char", stagger: 18, entranceMs: 300, exitMs: 220, icon: Cpu,
    curve: (t, seed = 0) => { const eo = ease("easeOut", t); const flick = t < 0.75 ? (Math.sin(seed * 97 + t * 60) > 0.15 ? 1 : 0.18) : 1;
      return pose({ opacity: Math.min(1, eo) * flick, x: (1 - eo) * Math.sin(seed * 53) * 14, rotation: (1 - eo) * Math.sin(seed * 13) * 6, blur: (1 - eo) * 3 }); } },
  { id: "elastic", name: "Elastic Bounce", animateBy: "word", stagger: 80, entranceMs: 650, exitMs: 420, icon: Activity,
    curve: (t) => { const e = elasticOut(t, 1); const eo = ease("easeOut", Math.min(t * 2, 1)); return pose({ opacity: eo, scale: e }); } },
  { id: "blurzoom", name: "Blur Zoom Blast", animateBy: "all", stagger: 0, entranceMs: 550, exitMs: 380, icon: Focus,
    curve: (t) => { const e = cubicBezier(0.11, 0.84, 0.24, 1, t); const eo = ease("easeOut", Math.min(t * 2, 1)); return pose({ opacity: eo, scale: 1.8 - 0.8 * e, blur: 30 * (1 - e) }); } },
  { id: "slidecinema", name: "Slide Cinematic", animateBy: "line", stagger: 120, entranceMs: 550, exitMs: 400, icon: MoveHorizontal,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, x: 80 * (1 - e), blur: 4 * (1 - e) }); } },
  { id: "kinetic", name: "Kinetic Bounce", animateBy: "word", stagger: 90, entranceMs: 520, exitMs: 360, icon: Rocket,
    curve: (t) => { const e = elasticOut(t, 0.7); const eo = ease("easeOut", Math.min(t * 2.2, 1)); return pose({ opacity: eo, y: -40 * (1 - e), rotation: -6 * (1 - e) }); } },
  { id: "softfocus", name: "Soft Focus Dream", animateBy: "line", stagger: 200, entranceMs: 1300, exitMs: 850, icon: CloudFog,
    curve: (t) => { const e = ease("easeInOut", t); return pose({ opacity: e, blur: 20 * (1 - e), scale: 1.05 - 0.05 * e }); } },
  { id: "flip3d", name: "Flip Masuk", animateBy: "char", stagger: 30, entranceMs: 380, exitMs: 300, icon: FlipHorizontal,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, rotation: (1 - e) * 35, scale: 0.5 + 0.5 * e }); } },
  { id: "retrovhs", name: "Retro VHS", animateBy: "line", stagger: 100, entranceMs: 480, exitMs: 380, icon: Tv,
    curve: (t, seed = 0) => { const e = ease("easeOut", t); return pose({ opacity: e, x: (1 - e) * Math.sin(seed * 71 + t * 30) * 10, rotation: (1 - e) * Math.sin(seed * 19) * 3, blur: (1 - e) * 6 }); } },
  // --- Tambahan: varian gaya Apple yang lebih halus/cinematic, dan
  // beberapa gaya kinetic-typography populer ala paket preset motion
  // (mis. "Mister Horse") — pop overshoot, whip-pan, split-flap, dst.
  { id: "applesoft", name: "Apple Soft Reveal", animateBy: "word", stagger: 65, entranceMs: 560, exitMs: 420, icon: Feather,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, y: 14 * (1 - e), scale: 0.97 + 0.03 * e, blur: 6 * (1 - e), letterSpacing: 2 * (1 - e) }); } },
  { id: "appletitle", name: "Apple Keynote Title", animateBy: "all", stagger: 0, entranceMs: 700, exitMs: 420, icon: Minus,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, letterSpacing: 34 * (1 - e), scale: 1.02 - 0.02 * e, blur: 4 * (1 - e) }); } },
  { id: "popbold", name: "Pop Bold Overshoot", animateBy: "word", stagger: 75, entranceMs: 460, exitMs: 340, icon: Flame,
    curve: (t) => { const e = elasticOut(t, 1.15); const eo = ease("easeOut", Math.min(t * 3, 1)); return pose({ opacity: eo, scale: 0.35 + 0.65 * e, rotation: (1 - e) * -4 }); } },
  { id: "wordwave", name: "Word Wave", animateBy: "word", stagger: 55, entranceMs: 520, exitMs: 380, icon: Waves,
    curve: (t, seed = 0) => { const e = ease("easeOut", t); return pose({ opacity: e, y: (1 - e) * 28 * Math.sin(seed * Math.PI * 2), scale: 0.92 + 0.08 * e }); } },
  { id: "splitflap", name: "Split Flap Board", animateBy: "char", stagger: 22, entranceMs: 260, exitMs: 220, icon: AlignJustify,
    curve: (t, seed = 0) => { const e = ease("easeOut", t); const flick = t < 0.6 ? (Math.sin(seed * 80 + t * 90) > -0.1 ? 1 : 0.1) : 1; return { ...pose({ opacity: Math.min(1, e) * flick }), scaleX: 1, scaleY: Math.max(0.15 + 0.85 * e, 0.001) }; } },
  { id: "whipswish", name: "Whip Pan Swish", animateBy: "all", stagger: 0, entranceMs: 360, exitMs: 280, icon: Wind,
    curve: (t) => { const e = cubicBezier(0.65, 0, 0.35, 1, t); return pose({ opacity: e, x: (1 - e) * -170, blur: (1 - e) * 20 }); } },
  { id: "risingconfidence", name: "Rising Confidence", animateBy: "line", stagger: 130, entranceMs: 620, exitMs: 420, icon: TrendingUp,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, y: 46 * (1 - e), scale: 0.94 + 0.06 * e }); } },
  { id: "popcornchars", name: "Popcorn Chars", animateBy: "char", stagger: 26, entranceMs: 380, exitMs: 300, icon: Sparkles,
    curve: (t, seed = 0) => { const e = elasticOut(t, 0.8); const eo = ease("easeOut", Math.min(t * 2.4, 1)); return pose({ opacity: eo, y: (1 - e) * -18 * (0.4 + Math.abs(Math.sin(seed * 41))), rotation: (1 - e) * Math.sin(seed * 33) * 10, scale: 0.7 + 0.3 * e }); } },
  // ---- Paket tambahan: gaya kinetic-typography terbaik, termasuk gerak
  // MELINGKAR (orbit/spiral) yang diminta, plus varian bersih ala Reels/TikTok.
  { id: "orbitin", name: "Melingkar Masuk (Orbit)", animateBy: "char", stagger: 22, entranceMs: 640, exitMs: 380, icon: RotateCcw,
    curve: (t, seed = 0) => { const e = ease("easeOut", t); const a = seed * Math.PI * 2; const R = 130 * (1 - e); return pose({ opacity: Math.min(1, e * 1.4), x: Math.cos(a) * R, y: Math.sin(a) * R, rotation: (1 - e) * 180 * (seed < 0.5 ? 1 : -1), scale: 0.4 + 0.6 * e }); } },
  { id: "spiralin", name: "Spiral Masuk", animateBy: "char", stagger: 26, entranceMs: 720, exitMs: 420, icon: Repeat,
    curve: (t, seed = 0) => { const e = ease("easeOut", t); const a = (1 - e) * Math.PI * 3 + seed * Math.PI * 2; const R = 170 * (1 - e); return pose({ opacity: e, x: Math.cos(a) * R, y: Math.sin(a) * R, rotation: (1 - e) * -160, scale: 0.3 + 0.7 * e }); } },
  { id: "orbitword", name: "Orbit Kata", animateBy: "word", stagger: 60, entranceMs: 640, exitMs: 400, icon: Sparkles,
    curve: (t, seed = 0) => { const e = ease("easeOut", t); const a = seed * Math.PI * 2 + Math.PI / 4; const R = 95 * (1 - e); return pose({ opacity: e, x: Math.cos(a) * R, y: Math.sin(a) * R, scale: 0.7 + 0.3 * e, rotation: (1 - e) * 30 }); } },
  // Tata letak MELINGKAR sejati: huruf disusun membentuk lingkaran lalu
  // cincinnya berputar terus (bukan cuma animasi masuk). `layout: "circle"`
  // ditangani khusus di drawTextClip → drawCircularText.
  { id: "circletext", name: "Teks Melingkar (Putar Kanan)", animateBy: "all", stagger: 0, entranceMs: 1, exitMs: 0, icon: RotateCcw, layout: "circle", spinDir: 1,
    curve: () => pose({}) },
  { id: "circletextccw", name: "Teks Melingkar (Putar Kiri)", animateBy: "all", stagger: 0, entranceMs: 1, exitMs: 0, icon: Repeat, layout: "circle", spinDir: -1,
    curve: () => pose({}) },
  { id: "riseup", name: "Naik Halus (Reels)", animateBy: "word", stagger: 70, entranceMs: 560, exitMs: 380, icon: TrendingUp,
    curve: (t) => { const e = cubicBezier(0.22, 1, 0.36, 1, t); return pose({ opacity: Math.min(1, t * 2), y: 48 * (1 - e) }); } },
  { id: "dropbounce", name: "Jatuh Memantul", animateBy: "char", stagger: 34, entranceMs: 720, exitMs: 380, icon: Activity,
    curve: (t) => { const e = elasticOut(t, 0.9); const eo = ease("easeOut", Math.min(t * 2.2, 1)); return pose({ opacity: eo, y: -70 * (1 - e) }); } },
  { id: "zoomkinetic", name: "Zoom Kinetik", animateBy: "word", stagger: 60, entranceMs: 520, exitMs: 360, icon: Rocket,
    curve: (t) => { const e = elasticOut(t, 0.5); const eo = ease("easeOut", Math.min(t * 2.5, 1)); return pose({ opacity: eo, scale: 0.2 + 0.8 * e, blur: 8 * (1 - eo) }); } },
  { id: "wavevert", name: "Gelombang Vertikal", animateBy: "char", stagger: 40, entranceMs: 560, exitMs: 360, icon: Waves,
    curve: (t, seed = 0) => { const e = ease("easeOut", t); return pose({ opacity: e, y: (1 - e) * 42 * Math.sin(seed * Math.PI * 3 + 0.6) }); } },
  { id: "counterspin", name: "Putar Bergantian", animateBy: "char", stagger: 24, entranceMs: 520, exitMs: 340, icon: Redo2,
    curve: (t, seed = 0) => { const e = ease("easeOut", t); const dir = (Math.floor(seed * 10) % 2 === 0) ? 1 : -1; return pose({ opacity: e, rotation: (1 - e) * 90 * dir, scale: 0.5 + 0.5 * e }); } },
  { id: "popchar", name: "Pop Per-Huruf", animateBy: "char", stagger: 28, entranceMs: 420, exitMs: 300, icon: Flame,
    curve: (t) => { const e = elasticOut(t, 1.1); const eo = ease("easeOut", Math.min(t * 3, 1)); return pose({ opacity: eo, scale: e }); } },
  { id: "blurinfast", name: "Blur Masuk Cepat", animateBy: "word", stagger: 45, entranceMs: 440, exitMs: 320, icon: Focus,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, blur: 16 * (1 - e), scale: 1.08 - 0.08 * e }); } },
  { id: "stretchin", name: "Regang Vertikal", animateBy: "char", stagger: 22, entranceMs: 420, exitMs: 300, icon: AlignJustify,
    curve: (t) => { const e = elasticOut(t, 0.6); const eo = ease("easeOut", Math.min(t * 2.5, 1)); return { ...pose({ opacity: eo }), scaleX: 1, scaleY: Math.max(0.05, e) }; } },
  { id: "flipline", name: "Flip Baris 3D", animateBy: "line", stagger: 140, entranceMs: 560, exitMs: 380, icon: FlipHorizontal,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, rotation: (1 - e) * 50, scale: 0.6 + 0.4 * e, y: 20 * (1 - e) }); } },
  { id: "neonflicker", name: "Neon Berkedip", animateBy: "char", stagger: 20, entranceMs: 460, exitMs: 320, icon: Zap,
    curve: (t, seed = 0) => { const eo = ease("easeOut", t); const fl = t < 0.7 ? (Math.sin(seed * 61 + t * 50) > -0.2 ? 1 : 0.25) : 1; return pose({ opacity: Math.min(1, eo) * fl, scale: 0.9 + 0.1 * eo, blur: 6 * (1 - eo) }); } },
  { id: "swingin", name: "Ayun Masuk", animateBy: "word", stagger: 65, entranceMs: 620, exitMs: 400, icon: Wind,
    curve: (t) => { const e = elasticOut(t, 0.7); return pose({ opacity: Math.min(1, t * 2), rotation: (1 - e) * -25, y: -20 * (1 - e) }); } },
];
// PRESET_LIB[0] sekarang "none" (dipakai sebagai default klip gambar/video
// yang belum diberi animasi apa pun) — fallback preset untuk id yang tak
// dikenal tetap "apple" seperti sebelumnya, bukan "none", supaya perilaku
// klip teks lama tidak berubah.
const DEFAULT_PRESET = PRESET_LIB.find((p) => p.id === "apple") || PRESET_LIB[0];

/* ============================================================
   PRESET KHUSUS GAMBAR/VIDEO — gambar & video tidak punya "huruf/kata",
   jadi semua preset di sini bergerak sebagai SATU objek utuh (animateBy
   "all"). Ini menggantikan pemakaian preset teks (yang banyak per-huruf,
   tidak berlaku untuk gambar). Daftar ini yang ditampilkan di tab
   "Gambar & Video" pada panel Preset.
   ============================================================ */

const IMAGE_PRESET_LIB = [
  { id: "none", name: "Tanpa Animasi (Statis)", animateBy: "all", stagger: 0, entranceMs: 1, exitMs: 0, icon: Ban, curve: () => pose({}) },
  { id: "img_fade", name: "Fade", animateBy: "all", stagger: 0, entranceMs: 500, exitMs: 400, icon: Eye,
    curve: (t) => pose({ opacity: ease("easeOut", t) }) },
  { id: "img_zoomin", name: "Zoom Masuk", animateBy: "all", stagger: 0, entranceMs: 560, exitMs: 400, icon: Focus,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, scale: 0.6 + 0.4 * e }); } },
  { id: "img_zoomout", name: "Zoom Keluar", animateBy: "all", stagger: 0, entranceMs: 560, exitMs: 400, icon: Focus,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, scale: 1.4 - 0.4 * e }); } },
  { id: "img_kenburns", name: "Ken Burns (Zoom Halus)", animateBy: "all", stagger: 0, entranceMs: 100, exitMs: 0, icon: Film,
    // Zoom sangat lambat sepanjang klip — entranceMs dibuat kecil supaya
    // "pose sampai" cepat, lalu scale terus naik pelan mengikuti t di kurva.
    curve: (t) => pose({ opacity: Math.min(1, t * 8), scale: 1.04 + 0.12 * t }) },
  { id: "img_slideup", name: "Geser Naik", animateBy: "all", stagger: 0, entranceMs: 520, exitMs: 380, icon: TrendingUp,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, y: 80 * (1 - e) }); } },
  { id: "img_slidedown", name: "Geser Turun", animateBy: "all", stagger: 0, entranceMs: 520, exitMs: 380, icon: TrendingUp,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, y: -80 * (1 - e) }); } },
  { id: "img_slideleft", name: "Geser dari Kanan", animateBy: "all", stagger: 0, entranceMs: 520, exitMs: 380, icon: MoveHorizontal,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, x: 90 * (1 - e) }); } },
  { id: "img_slideright", name: "Geser dari Kiri", animateBy: "all", stagger: 0, entranceMs: 520, exitMs: 380, icon: MoveHorizontal,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, x: -90 * (1 - e) }); } },
  { id: "img_rotatein", name: "Putar Masuk", animateBy: "all", stagger: 0, entranceMs: 560, exitMs: 400, icon: RotateCcw,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, rotation: -160 * (1 - e), scale: 0.7 + 0.3 * e }); } },
  { id: "img_bounce", name: "Bounce Masuk", animateBy: "all", stagger: 0, entranceMs: 640, exitMs: 420, icon: Activity,
    curve: (t) => { const e = elasticOut(t, 1); const eo = ease("easeOut", Math.min(t * 2, 1)); return pose({ opacity: eo, scale: e }); } },
  { id: "img_pop", name: "Pop Overshoot", animateBy: "all", stagger: 0, entranceMs: 480, exitMs: 340, icon: Flame,
    curve: (t) => { const e = elasticOut(t, 1.15); const eo = ease("easeOut", Math.min(t * 3, 1)); return pose({ opacity: eo, scale: 0.3 + 0.7 * e }); } },
  { id: "img_blurin", name: "Blur Masuk", animateBy: "all", stagger: 0, entranceMs: 560, exitMs: 400, icon: CloudFog,
    curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, blur: 22 * (1 - e), scale: 1.06 - 0.06 * e }); } },
  { id: "img_flip", name: "Flip Horizontal", animateBy: "all", stagger: 0, entranceMs: 500, exitMs: 360, icon: FlipHorizontal,
    curve: (t) => { const e = ease("easeOut", t); return { ...pose({ opacity: Math.min(1, t * 2) }), scaleX: Math.max(0.05, e), scaleY: 1 }; } },
  { id: "img_whip", name: "Whip Pan", animateBy: "all", stagger: 0, entranceMs: 380, exitMs: 300, icon: Wind,
    curve: (t) => { const e = cubicBezier(0.65, 0, 0.35, 1, t); return pose({ opacity: e, x: (1 - e) * -180, blur: (1 - e) * 18 }); } },
];
const DEFAULT_IMAGE_PRESET = IMAGE_PRESET_LIB[0];

/* ============================================================
   TRANSITION LIBRARY — dipakai per sisi klip (masuk & keluar).
   Bisa diseret langsung ke sela-sela (seam) antar bar di linimasa:
   otomatis diterapkan sebagai transisi-keluar klip kiri DAN
   transisi-masuk klip kanan sekaligus.
   ============================================================ */

const TRANSITION_LIB = [
  { id: "none", name: "Tanpa Transisi", entranceMs: 1, exitMs: 1, curve: () => pose({ opacity: 1 }) },
  { id: "fade", name: "Fade", entranceMs: 450, exitMs: 350, curve: (t) => pose({ opacity: ease("easeOut", t) }) },
  { id: "slideL", name: "Slide Kiri", entranceMs: 480, exitMs: 380, curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, x: 70 * (1 - e) }); } },
  { id: "slideR", name: "Slide Kanan", entranceMs: 480, exitMs: 380, curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, x: -70 * (1 - e) }); } },
  { id: "slideUp", name: "Geser Naik", entranceMs: 480, exitMs: 380, curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, y: 55 * (1 - e) }); } },
  { id: "slideDown", name: "Geser Turun", entranceMs: 480, exitMs: 380, curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, y: -55 * (1 - e) }); } },
  { id: "zoomIn", name: "Zoom Masuk", entranceMs: 420, exitMs: 340, curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, scale: 0.55 + 0.45 * e }); } },
  { id: "zoomOut", name: "Zoom Keluar", entranceMs: 420, exitMs: 340, curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, scale: 1.55 - 0.55 * e }); } },
  { id: "blurDiss", name: "Blur Dissolve", entranceMs: 520, exitMs: 420, curve: (t) => { const e = ease("easeInOut", t); return pose({ opacity: e, blur: 24 * (1 - e) }); } },
  { id: "spin", name: "Putar Masuk", entranceMs: 520, exitMs: 380, curve: (t) => { const e = ease("easeOut", t); return pose({ opacity: e, rotation: -170 * (1 - e), scale: 0.65 + 0.35 * e }); } },
  { id: "bounce", name: "Bounce Masuk", entranceMs: 620, exitMs: 420, curve: (t) => { const e = elasticOut(t, 1); const eo = ease("easeOut", Math.min(t * 2, 1)); return pose({ opacity: eo, scale: e }); } },
  { id: "glitchCut", name: "Glitch Cut", entranceMs: 260, exitMs: 200, curve: (t, seed = 0) => { const eo = ease("easeOut", t); const flick = t < 0.7 ? (Math.sin(t * 70 + seed * 30) > 0.1 ? 1 : 0.15) : 1; return pose({ opacity: Math.min(1, eo) * flick, x: (1 - eo) * 12 * Math.sin(seed * 40) }); } },
  { id: "wipeH", name: "Wipe Horizontal", entranceMs: 480, exitMs: 360, curve: (t) => { const e = ease("easeInOut", t); return { ...pose({ opacity: e > 0.04 ? 1 : 0 }), scaleX: Math.max(e, 0.001), scaleY: 1 }; } },
  { id: "shutterV", name: "Shutter Vertikal", entranceMs: 480, exitMs: 360, curve: (t) => { const e = ease("easeInOut", t); return { ...pose({ opacity: e > 0.04 ? 1 : 0 }), scaleX: 1, scaleY: Math.max(e, 0.001) }; } },
  { id: "crossDiss", name: "Cross Dissolve", entranceMs: 500, exitMs: 500, curve: (t) => { const e = ease("linear", t); return pose({ opacity: e, scale: 0.97 + 0.03 * e }); } },
];
const DEFAULT_TRANSITION = TRANSITION_LIB[0];

// opts (opsional): { animateIn, animateOut, easing }
//  - animateIn=false  → tidak ada animasi MASUK (objek langsung di pose diam).
//  - animateOut=false → tidak ada animasi KELUAR (objek diam sampai habis).
//  - easing: "auto" (pakai easing bawaan kurva preset) | "linear" | "easeIn"
//    | "easeOut" | "easeInOut" — meng-ulang-petakan waktu t supaya pengguna
//    bisa mengatur "rasa" percepatan/perlambatan animasi.
function samplePose(preset, rank, staggerMs, localClipTime, clipDuration, seed, opts) {
  const animateIn = !opts || opts.animateIn !== false;
  const animateOut = !opts || opts.animateOut !== false;
  const easing = (opts && opts.easing) || "auto";
  const remap = (t) => (easing === "auto" ? t : ease(easing, t));
  const rankDelay = rank * staggerMs;
  const exitStart = clipDuration - preset.exitMs - rankDelay;
  if (animateOut && preset.exitMs > 0 && localClipTime >= exitStart) {
    const tOut = clamp((localClipTime - exitStart) / preset.exitMs, 0, 1);
    return preset.curve(1 - remap(tOut), seed);
  }
  if (!animateIn) return preset.curve(1, seed); // pose "sudah sampai" (diam)
  const tIn = clamp((localClipTime - rankDelay) / preset.entranceMs, 0, 1);
  return preset.curve(remap(tIn), seed);
}

// Menggabungkan transisi-masuk & transisi-keluar (bisa dua preset berbeda,
// karena tiap sisi bisa diseret dari transisi yang berbeda).
function sampleTransitionPose(inTrans, outTrans, localClipTime, clipDuration, seed = 0) {
  const exitStart = clipDuration - outTrans.exitMs;
  if (outTrans.exitMs > 0 && localClipTime >= exitStart) {
    const tOut = clamp((localClipTime - exitStart) / outTrans.exitMs, 0, 1);
    return outTrans.curve(1 - tOut, seed);
  }
  const tIn = clamp(localClipTime / inTrans.entranceMs, 0, 1);
  return inTrans.curve(tIn, seed);
}

function getTransition(id) { return TRANSITION_LIB.find((t) => t.id === id) || DEFAULT_TRANSITION; }
function getPreset(id) { return PRESET_LIB.find((p) => p.id === id) || IMAGE_PRESET_LIB.find((p) => p.id === id) || DEFAULT_PRESET; }

/* ============================================================
   STORE
   ============================================================ */

let uidCounter = 0;
const uid = (p) => `${p}_${(uidCounter++).toString(36)}`;

// Sebelumnya file media dibaca lewat URL.createObjectURL(file) — di
// lingkungan preview yang sandboxed (mis. panel Artifact), blob: URL
// semacam itu kerap DITOLAK diam-diam oleh kebijakan keamanan konten
// (CSP) untuk <img>/<video>/<audio>, sehingga elemen selalu gagal
// dimuat (event "error" langsung terpicu) walau file yang dipilih
// pengguna itu sendiri valid. data: URI (base64) jauh lebih diterima
// secara luas karena kontennya menyatu langsung di dalam atribut src,
// tidak bergantung pada skema blob: khusus — jadi ini dipakai sebagai
// cara utama mengimpor semua file media di aplikasi ini.
// Cek cepat "kemungkinan bisa diputar" SEBELUM file dibaca sama sekali —
// canPlayType() bisa langsung memberi tahu di awal kalau kontainer/codec
// filenya (mis. .mov/HEVC dari iPhone atau hasil screen-record Mac) tidak
// didukung sama sekali oleh browser ini, jadi pengguna tak perlu menunggu
// proses impor selesai dulu baru tahu videonya "gagal" secara misterius.
function checkVideoPlayability(file) {
  if (!file.type) return null; // MIME tak diketahui — biarkan proses impor normal yang menentukan.
  const probe = document.createElement("video");
  const support = probe.canPlayType(file.type);
  if (support === "") {
    return `Tipe file "${file.type}" kemungkinan besar TIDAK didukung untuk diputar oleh browser ini. File tetap akan dicoba diimpor, tapi kemungkinan besar akan gagal — untuk preview Artifact yang paling andal, pakai .webm (VP9) atau .mp4 (H.264).`;
  }
  return null;
}

function checkAudioPlayability(file) {
  if (!file.type) return null;
  const probe = document.createElement("audio");
  if (probe.canPlayType(file.type) === "") {
    return `Tipe audio "${file.type}" kemungkinan tidak didukung browser ini. Coba format .mp3, .wav, .m4a, atau .ogg.`;
  }
  return null;
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Gagal membaca file dari disk."));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Gagal membaca file dari disk."));
    reader.readAsText(file);
  });
}

/* ============================================================
   IMPOR & PEWARNAAN ULANG SVG — supaya gambar SVG (ikon/logo satu
   warna) bisa diubah-ubah warnanya persis seperti warna teks, klip
   gambar SVG menyimpan markup XML aslinya (svgSource) SELAIN data-URL
   yang dipakai untuk digambar (src). Saat pengguna memilih warna,
   markup itu diproses ulang lewat DOMParser (bukan cari-ganti string
   mentah, biar tetap benar walau atributnya ditulis dengan urutan/gaya
   berbeda-beda) lalu dirender ulang jadi data-URL baru.
   ============================================================ */

function isSvgFile(file) {
  return file.type === "image/svg+xml" || /\.svg$/i.test(file.name || "");
}

function svgTextToDataUrl(svgText) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
}

// Membaca file gambar apa pun: kalau SVG, markup aslinya ikut disimpan
// (svgSource) supaya bisa diwarnai ulang belakangan; kalau bukan (PNG/JPG
// dst), berperilaku sama seperti sebelumnya.
async function readImageAsset(file) {
  if (isSvgFile(file)) {
    const svgSource = await readFileAsText(file);
    const src = svgTextToDataUrl(svgSource);
    return { src, isSvg: true, svgSource, svgOriginalSrc: src };
  }
  // Gambar non-SVG: pakai blob: URL (jauh lebih ringan daripada data URL
  // base64 untuk file besar) sambil menyimpan File aslinya sebagai cadangan,
  // supaya bisa otomatis fallback ke data URL kalau blob: diblokir CSP.
  const src = URL.createObjectURL(file);
  return { src, isSvg: false, svgSource: null, svgOriginalSrc: null, file };
}

// Mewarnai ulang SEMUA warna isi (fill) & garis (stroke) di dalam markup
// SVG jadi satu warna solid, sama seperti warna teks — bukan cuma
// cari-ganti string "fill=..." mentah (rapuh kalau atributnya ditulis
// beda gaya), tapi betul-betul mem-parsing-nya sebagai dokumen XML lewat
// DOMParser lalu jalan ke tiap elemen. `fill="none"`/`stroke="none"`
// (dipakai ikon berbasis garis, mis. gaya outline) sengaja DIBIARKAN apa
// adanya supaya bentuknya tidak berubah jadi kotak solid. `color` null
// berarti "kembalikan ke warna asli" (dipakai tombol reset).
function recolorSvgMarkup(svgText, color) {
  if (!color || !svgText) return svgText;
  try {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svgEl = doc.documentElement;
    if (!svgEl || svgEl.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) return svgText;
    const isSkippable = (v) => {
      const low = (v || "").trim().toLowerCase();
      return !v || low === "none" || low === "transparent" || low.startsWith("url(");
    };
    // Rewrite warna fill/stroke di dalam sebuah blok teks CSS (dipakai untuk
    // isi elemen <style>). `stroke-width`, `fill-opacity`, dst. sengaja TIDAK
    // ikut kena karena regex mewajibkan properti diikuti langsung oleh ":".
    const rewriteCss = (css) => css.replace(
      /(^|[;{\s])(fill|stroke)\s*:\s*([^;}\s]+)/gi,
      (m, pre, prop, val) => (isSkippable(val) ? m : `${pre}${prop}:${color}`)
    );
    // Pastikan namespace SVG selalu ada — sebagian file hasil ekspor bisa
    // kehilangan xmlns setelah diproses ulang, membuat gambar gagal dimuat.
    if (!svgEl.getAttribute("xmlns")) svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    // Set warna dasar di elemen <svg> akar — elemen turunan yang TIDAK punya
    // fill sendiri (defaultnya hitam) otomatis mewarisi ini. `color` juga
    // di-set supaya fill/stroke bernilai "currentColor" ikut berubah warna.
    svgEl.setAttribute("fill", color);
    svgEl.setAttribute("color", color);
    svgEl.querySelectorAll("*").forEach((el) => {
      // Elemen <style> ditangani terpisah di bawah (isinya CSS, bukan atribut).
      if (el.nodeName.toLowerCase() === "style") return;
      const fillAttr = el.getAttribute("fill");
      if (!isSkippable(fillAttr)) el.setAttribute("fill", color);
      const strokeAttr = el.getAttribute("stroke");
      if (!isSkippable(strokeAttr)) el.setAttribute("stroke", color);
      const style = el.getAttribute("style");
      if (style && /(fill|stroke)\s*:/i.test(style)) {
        const next = rewriteCss(style);
        if (next !== style) el.setAttribute("style", next);
      }
    });
    // Blok <style> CSS — paling sering dipakai file ekspor Illustrator/Figma,
    // mis. `.cls-1{fill:#000}`. Aturan CSS class MENGALAHKAN atribut presentasi
    // (fill=...) berdasarkan spesifisitas, jadi tanpa menulis ulang warna DI
    // DALAM CSS ini, warna gambar tidak akan pernah berubah walau fill= tiap
    // elemen sudah diganti — inilah penyebab utama keluhan "ganti warna SVG
    // tidak berfungsi / nge-bug" pada kebanyakan logo hasil ekspor desainer.
    svgEl.querySelectorAll("style").forEach((styleEl) => {
      const css = styleEl.textContent || "";
      const nextCss = rewriteCss(css);
      if (nextCss !== css) styleEl.textContent = nextCss;
    });
    return new XMLSerializer().serializeToString(svgEl);
  } catch (err) {
    return svgText;
  }
}

// Cache hasil pewarnaan ulang SVG per (svgText, color) — pewarnaan ulang
// mem-parsing seluruh markup lewat DOMParser lalu serialize lagi lewat
// XMLSerializer, yang untuk SVG besar/kompleks lumayan berat kalau
// dijalankan berulang-ulang pada setiap event pointermove saat pengguna
// menyeret color picker (puluhan kali per detik). Cache ini memastikan
// kombinasi svgText+color yang SAMA hanya diproses sekali. Dibatasi
// ukurannya (LRU sederhana) supaya tidak bocor memori kalau banyak SVG
// berbeda diwarnai berulang kali sepanjang sesi.
const RECOLOR_CACHE_LIMIT = 60;
const recolorCache = new Map();
function getRecoloredSvgDataUrl(svgText, color) {
  if (!color || !svgText) return svgText ? svgTextToDataUrl(svgText) : svgText;
  const key = `${svgText.length}:${svgText.slice(0, 64)}::${color}`;
  const cached = recolorCache.get(key);
  if (cached !== undefined) {
    // Sentuh ulang entri ini supaya paling baru dipakai (LRU).
    recolorCache.delete(key);
    recolorCache.set(key, cached);
    return cached;
  }
  const dataUrl = svgTextToDataUrl(recolorSvgMarkup(svgText, color));
  recolorCache.set(key, dataUrl);
  if (recolorCache.size > RECOLOR_CACHE_LIMIT) {
    recolorCache.delete(recolorCache.keys().next().value);
  }
  return dataUrl;
}

const BASE_OFFSET = { x: 0, y: 0, rotation: 0, scale: 1 };
const BG_SEL = "__background__";

/* ============================================================
   ERROR TOASTS — supaya kegagalan impor/ekspor terlihat oleh
   pengguna (sebelumnya hanya console.error, jadi terasa "diam
   saja" ketika gagal).
   ============================================================ */

const errorListeners = new Set();
// Cegah spam: kalau pesan error yang SAMA dilaporkan berkali-kali dalam
// waktu singkat (mis. gagal memuat gambar dipicu ulang tiap frame karena
// bug lain, atau banyak layer gagal bersamaan), jangan buat toast baru
// setiap kali — cukup satu toast dengan hitungan "×N" yang di-refresh
// jangka waktunya. Tanpa ini, puluhan/ratusan elemen toast bisa menumpuk
// di DOM sekaligus dan bikin seluruh aplikasi terasa berat/nge-lag,
// persis seperti pada screenshot.
let lastErrorMsg = null;
let lastErrorAt = 0;
const ERROR_DEDUPE_WINDOW_MS = 4000;
function reportError(msg) {
  console.error(msg);
  const now = Date.now();
  const isRepeat = msg === lastErrorMsg && now - lastErrorAt < ERROR_DEDUPE_WINDOW_MS;
  lastErrorMsg = msg;
  lastErrorAt = now;
  errorListeners.forEach((fn) => fn(msg, isRepeat));
}
const MAX_TOASTS = 4;
function useErrorToasts() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    const fn = (msg, isRepeat) => {
      setToasts((t) => {
        if (isRepeat && t.length && t[t.length - 1].msg === msg) {
          // Perbarui toast terakhir (naikkan hitungan) alih-alih menambah
          // toast baru.
          const last = t[t.length - 1];
          return [...t.slice(0, -1), { ...last, count: last.count + 1 }];
        }
        const id = uid("toast");
        // Batasi jumlah toast yang tampil bersamaan; buang yang paling
        // lama supaya DOM/reflow tidak membengkak saat banyak error
        // muncul sekaligus (mis. banyak layer/gambar gagal bareng).
        const next = [...t, { id, msg, count: 1 }];
        return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
      });
      setTimeout(() => setToasts((t) => t.filter((x) => x.msg !== msg)), 6000);
    };
    errorListeners.add(fn);
    return () => errorListeners.delete(fn);
  }, []);
  const dismiss = (id) => setToasts((t) => t.filter((x) => x.id !== id));
  return { toasts, dismiss };
}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, msg: "" }; }
  static getDerivedStateFromError(err) { return { hasError: true, msg: (err && err.message) || String(err) }; }
  componentDidCatch(err, info) { console.error("Motion Font Studio crash:", err, info); }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 28, color: "#fff", background: "#0a0a0c", height: "100%", width: "100%", fontFamily: "Inter, sans-serif", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Terjadi kesalahan pada aplikasi</div>
          <div style={{ color: "#9a9aa5", fontSize: 12.5, maxWidth: 420, textAlign: "center" }}>{this.state.msg}</div>
          <button className="mfs-btn mfs-btn-primary" style={{ marginTop: 6 }} onClick={() => this.setState({ hasError: false, msg: "" })}>Coba lagi</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function makeTextClip(name, text, start, presetId = "apple", trackId = null) {
  const preset = getPreset(presetId);
  return {
    id: uid("clip"), type: "text", name, text, start, trackId,
    duration: 2200,
    fontFamily: "Inter, sans-serif",
    fontSize: 58,
    letterSpacing: 0,
    lineHeight: 1.25,
    align: "center",
    color: "#F3F3F6",
    presetId: preset.id,
    animateBy: preset.animateBy,
    stagger: preset.stagger,
    animateIn: true, animateOut: true, easing: "auto",
    transitionInId: "none",
    transitionOutId: "none",
    offset: { ...BASE_OFFSET },
  };
}

function makeMediaClip(kind, asset, start, trackId = null) {
  const isAudio = kind === "audio";
  const isSvg = kind === "image" && !!asset.isSvg;
  return {
    id: uid("clip"), type: kind, name: asset.name, src: asset.src, start, trackId,
    duration: isAudio ? 3000 : kind === "video" ? 3200 : 2400,
    // Gambar/video sekarang juga bisa diberi preset animasi lewat panel
    // Preset (tab "Gambar & Video") — defaultnya "none" (statis) supaya
    // klip yang baru diimpor tidak tiba-tiba bergerak tanpa diminta.
    presetId: "none", animateBy: "all", stagger: 0,
    animateIn: true, animateOut: true, easing: "auto",
    transitionInId: isAudio ? "fade" : "none",
    transitionOutId: isAudio ? "fade" : "none",
    volume: 1, muted: false,
    offset: { ...BASE_OFFSET },
    // File asli disimpan (referensi ringan, bukan salinan) supaya elemen media
    // bisa otomatis fallback ke data URL kalau src blob:-nya diblokir CSP.
    file: asset.file || null,
    // Untuk gambar SVG: markup asli + data-URL asli disimpan supaya bisa
    // diwarnai ulang (dan dikembalikan ke warna asli) kapan saja dari
    // panel kanan — svgColor null berarti "warna asli, belum diubah".
    ...(isSvg ? { isSvg: true, svgSource: asset.svgSource, svgOriginalSrc: asset.svgOriginalSrc || asset.src, svgColor: null } : {}),
  };
}

function makeTrack(type) { return { id: uid("track"), type }; }

const FRAME_PRESETS = [
  { id: "story", name: "Story / Reels / TikTok (9:16)", w: 1080, h: 1920, icon: Smartphone },
  { id: "square", name: "Instagram Feed (1:1)", w: 1080, h: 1080, icon: Square },
  { id: "portrait45", name: "Instagram Portrait (4:5)", w: 1080, h: 1350, icon: RectangleVertical },
  { id: "youtube", name: "YouTube (16:9)", w: 1920, h: 1080, icon: Monitor },
  { id: "shorts", name: "YouTube Shorts (9:16)", w: 1080, h: 1920, icon: Smartphone },
  { id: "twitter", name: "X / Twitter Post (16:9)", w: 1200, h: 675, icon: RectangleHorizontal },
  { id: "custom", name: "Custom (px)", w: 1080, h: 1080, icon: Settings2 },
];
const DEFAULT_FRAME = FRAME_PRESETS[0];

function makeInitialProject() {
  const textTrack = makeTrack("text");
  const clip1 = makeTextClip("Klip 1", "Motion Font\nStudio", 0, "apple", textTrack.id);
  const clip2 = makeTextClip("Klip 2", "Edit Teks Anda", 2200, "kinetic", textTrack.id);
  clip2.duration = 1800;
  return {
    fonts: [], clips: [clip1, clip2], selectedClipId: clip1.id,
    // "tracks" adalah daftar linimasa yang fleksibel — bisa lebih dari satu
    // track per jenis (teks/gambar/video/audio). Pengguna bisa menambah
    // track baru lewat tombol "+" di linimasa, atau otomatis saat sebuah
    // klip diseret ke area kosong di atas/bawah track yang ada.
    tracks: [textTrack],
    library: { images: [], videos: [], audios: [] },
    background: { type: "solid", color: "#0d0d10", gradFrom: "#1c1c28", gradTo: "#08080a", gradAngle: 135, imageSrc: null },
    frameSize: { presetId: DEFAULT_FRAME.id, w: DEFAULT_FRAME.w, h: DEFAULT_FRAME.h },
  };
}
const initialProjectState = makeInitialProject();
const initialPlayback = { playhead: 0, playing: false, loop: true, previewOpen: false };

const TRACK_TYPES = [
  { type: "text", label: "Teks", color: "#7c6cff", icon: Type },
  { type: "video", label: "Video", color: "#4fa3ff", icon: Film },
  { type: "image", label: "Gambar", color: "#45d483", icon: ImageIcon },
  { type: "audio", label: "Audio", color: "#ffb454", icon: Music },
];
function trackColor(type) { return TRACK_TYPES.find((t) => t.type === type)?.color || "#7c6cff"; }

function projectReducer(state, action) {
  switch (action.type) {
    case "ADD_FONT":
      return { ...state, fonts: [...state.fonts, action.font] };
    case "ADD_CLIP": {
      // Taruh di track teks terakhir (paling bawah) yang sudah ada; kalau
      // belum ada track teks sama sekali, buat satu baru secara otomatis.
      let tracks = state.tracks;
      let track = [...tracks].reverse().find((t) => t.type === "text");
      if (!track) { track = makeTrack("text"); tracks = [...tracks, track]; }
      const lastEnd = state.clips.filter((c) => c.trackId === track.id).reduce((m, c) => Math.max(m, c.start + c.duration), 0);
      const clip = makeTextClip(`Klip ${state.clips.length + 1}`, "Teks Baru", lastEnd, "apple", track.id);
      return { ...state, tracks, clips: [...state.clips, clip], selectedClipId: clip.id };
    }
    case "ADD_MEDIA_CLIP": {
      let tracks = state.tracks;
      let track = [...tracks].reverse().find((t) => t.type === action.kind);
      if (!track) { track = makeTrack(action.kind); tracks = [...tracks, track]; }
      const lastEnd = state.clips.filter((c) => c.trackId === track.id).reduce((m, c) => Math.max(m, c.start + c.duration), 0);
      const clip = makeMediaClip(action.kind, action.asset, lastEnd, track.id);
      return { ...state, tracks, clips: [...state.clips, clip], selectedClipId: clip.id };
    }
    case "ADD_TRACK": {
      const track = { id: action.id || uid("track"), type: action.trackType };
      const tracks = action.atStart ? [track, ...state.tracks] : [...state.tracks, track];
      return { ...state, tracks };
    }
    case "DELETE_TRACK": {
      // Hanya boleh menghapus track yang benar-benar kosong, supaya klip
      // tidak pernah "hilang" karena track-nya dibuang.
      const hasClips = state.clips.some((c) => c.trackId === action.id);
      if (hasClips) return state;
      return { ...state, tracks: state.tracks.filter((t) => t.id !== action.id) };
    }
    case "MOVE_CLIP_TO_TRACK": {
      const clips = state.clips.map((c) => (c.id === action.clipId ? { ...c, trackId: action.trackId, start: Math.max(0, Math.round(action.start)) } : c));
      return { ...state, clips };
    }
    case "ADD_TRACK_WITH_CLIP": {
      // Dipakai saat klip diseret ke zona kosong di atas/bawah daftar
      // track — membuat track baru dan langsung memindahkan klip itu ke
      // dalamnya, dalam satu langkah supaya tetap konsisten (atomic).
      const track = { id: action.trackId, type: action.trackType };
      const tracks = action.atStart ? [track, ...state.tracks] : [...state.tracks, track];
      const clips = state.clips.map((c) => (c.id === action.clipId ? { ...c, trackId: track.id, start: Math.max(0, Math.round(action.start)) } : c));
      return { ...state, tracks, clips };
    }
    case "ADD_LIBRARY_ASSET": {
      const key = `${action.kind}s`;
      return { ...state, library: { ...state.library, [key]: [...state.library[key], action.asset] } };
    }
    case "DELETE_LIBRARY_ASSET": {
      const key = `${action.kind}s`;
      return { ...state, library: { ...state.library, [key]: state.library[key].filter((a) => a.id !== action.id) } };
    }
    case "DELETE_CLIP": {
      const clips = state.clips.filter((c) => c.id !== action.id);
      const selectedClipId = state.selectedClipId === action.id ? (clips[0]?.id ?? null) : state.selectedClipId;
      return { ...state, clips, selectedClipId };
    }
    case "SELECT_CLIP":
      return { ...state, selectedClipId: action.id };
    case "REORDER_CLIP": {
      // Dipakai saat sebuah layer diseret di panel Layer untuk mengubah
      // urutan tumpukan (stacking order). Urutan di array `clips` = urutan
      // render: elemen paling akhir digambar TERAKHIR sehingga tampil PALING
      // DEPAN. Panel Layer menampilkan urutan terbalik (atas = depan), jadi
      // di sini kita pindahkan klip ke posisi array yang sesuai.
      const fromIdx = state.clips.findIndex((c) => c.id === action.clipId);
      if (fromIdx === -1) return state;
      const clips = [...state.clips];
      const [moved] = clips.splice(fromIdx, 1);
      let toIdx = clips.findIndex((c) => c.id === action.beforeId);
      if (action.beforeId == null || toIdx === -1) toIdx = clips.length;
      clips.splice(toIdx, 0, moved);
      return { ...state, clips };
    }
    case "UPDATE_CLIP": {
      const clips = state.clips.map((c) => (c.id === action.id ? { ...c, ...action.patch } : c));
      return { ...state, clips };
    }
    case "SET_OFFSET": {
      const clips = state.clips.map((c) => (c.id === action.id ? { ...c, offset: { ...c.offset, ...action.patch } } : c));
      return { ...state, clips };
    }
    case "APPLY_PRESET": {
      const preset = getPreset(action.presetId);
      const clips = state.clips.map((c) => (c.id === action.id ? { ...c, presetId: preset.id, animateBy: preset.animateBy, stagger: preset.stagger } : c));
      return { ...state, clips };
    }
    case "APPLY_TRANSITION_BOTH": {
      const clips = state.clips.map((c) => (c.id === action.id ? { ...c, transitionInId: action.transitionId, transitionOutId: action.transitionId } : c));
      return { ...state, clips };
    }
    case "APPLY_TRANSITION_SIDE": {
      const clips = state.clips.map((c) => (c.id === action.id ? { ...c, [action.side === "in" ? "transitionInId" : "transitionOutId"]: action.transitionId } : c));
      return { ...state, clips };
    }
    case "SET_BACKGROUND":
      return { ...state, background: { ...state.background, ...action.patch } };
    case "SET_FRAME_PRESET":
      return { ...state, frameSize: { presetId: action.presetId, w: action.w, h: action.h } };
    case "SET_FRAME_CUSTOM":
      return { ...state, frameSize: { ...state.frameSize, presetId: "custom", ...action.patch } };
    default:
      return state;
  }
}

/* ============================================================
   UNDO / REDO — membungkus projectReducer supaya semua aktivitas
   pengeditan proyek (tambah/hapus/ubah klip, track, preset,
   transisi, background, ukuran frame, dst.) bisa di-undo/redo.
   Aksi berturut-turut yang "sejenis" dalam jeda waktu singkat
   (mis. menyeret slider atau mengetik teks) digabung jadi SATU
   langkah undo, supaya undo tidak perlu ditekan puluhan kali
   hanya untuk membatalkan satu gestur drag.
   ============================================================ */

const HISTORY_LIMIT = 80;
const COALESCE_MS = 500;
// Aksi yang murni soal "apa yang sedang dipilih/di-hover", bukan
// perubahan data proyek yang sesungguhnya — tidak pernah masuk ke
// riwayat undo/redo sendiri.
const NON_HISTORY_ACTIONS = new Set(["SELECT_CLIP"]);

function actionCoalesceKey(action) {
  switch (action.type) {
    case "UPDATE_CLIP": return `UPDATE_CLIP:${action.id}:${Object.keys(action.patch || {}).sort().join(",")}`;
    case "SET_OFFSET": return `SET_OFFSET:${action.id}:${Object.keys(action.patch || {}).sort().join(",")}`;
    case "SET_BACKGROUND": return `SET_BACKGROUND:${Object.keys(action.patch || {}).sort().join(",")}`;
    case "SET_FRAME_CUSTOM": return "SET_FRAME_CUSTOM";
    default: return `${action.type}:${action.id || ""}`;
  }
}

const initialHistoryState = {
  past: [],
  present: initialProjectState,
  future: [],
  lastKey: null,
  lastTime: 0,
};

function historyReducer(state, action) {
  // Muat ulang seluruh proyek dari penyimpanan (IndexedDB) — mengganti
  // "present" dan mengosongkan riwayat undo/redo, karena proyek yang dimuat
  // adalah titik awal yang baru, bukan hasil sebuah aksi edit.
  if (action.type === "HYDRATE_PROJECT") {
    if (!action.project) return state;
    return { past: [], present: action.project, future: [], lastKey: null, lastTime: 0 };
  }
  if (action.type === "UNDO") {
    if (state.past.length === 0) return state;
    const previous = state.past[state.past.length - 1];
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future],
      lastKey: null,
      lastTime: 0,
    };
  }
  if (action.type === "REDO") {
    if (state.future.length === 0) return state;
    const next = state.future[0];
    return {
      past: [...state.past, state.present],
      present: next,
      future: state.future.slice(1),
      lastKey: null,
      lastTime: 0,
    };
  }

  const newPresent = projectReducer(state.present, action);
  if (newPresent === state.present) return state; // no-op, jangan kotori riwayat

  if (NON_HISTORY_ACTIONS.has(action.type)) {
    // Perubahan seleksi: perbarui present tapi jangan sentuh past/future.
    return { ...state, present: newPresent };
  }

  const now = Date.now();
  const key = actionCoalesceKey(action);
  const shouldCoalesce = key === state.lastKey && now - state.lastTime < COALESCE_MS;

  if (shouldCoalesce) {
    return { ...state, present: newPresent, lastTime: now };
  }

  const past = [...state.past, state.present].slice(-HISTORY_LIMIT);
  return { past, present: newPresent, future: [], lastKey: key, lastTime: now };
}

function playbackReducer(state, action) {
  switch (action.type) {
    case "SET_PLAYHEAD": return { ...state, playhead: action.value };
    case "SET_PLAYING": return { ...state, playing: action.value };
    case "SET_LOOP": return { ...state, loop: action.value };
    case "SET_PREVIEW_OPEN": return { ...state, previewOpen: action.value };
    default: return state;
  }
}

function computeTimelineDuration(clips) {
  const maxEnd = clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  return Math.max(3000, maxEnd + 700);
}

/* ============================================================
   TEXT LAYOUT
   ============================================================ */

function splitUnits(text, mode) {
  const lines = (text || "").split("\n");
  if (mode === "all") return { units: [{ text, index: 0, line: 0 }], totalUnits: 1, lines };
  if (mode === "line") return { units: lines.map((l, i) => ({ text: l, index: i, line: i })), totalUnits: lines.length, lines };
  let idx = 0;
  const units = [];
  lines.forEach((line, li) => {
    const pieces = mode === "char" ? line.split("") : line.split(/(\s+)/).filter((s) => s.length > 0);
    pieces.forEach((p) => units.push({ text: p, index: idx++, line: li }));
  });
  return { units, totalUnits: units.length, lines };
}

function measureLine(ctx, str, letterSpacing) {
  if (!str) return 0;
  if (!letterSpacing) return ctx.measureText(str).width;
  let w = 0;
  for (const ch of str) w += ctx.measureText(ch).width + letterSpacing;
  return w - letterSpacing;
}

function drawSpacedText(ctx, text, x, y, spacing) {
  // Kalau teksnya cuma satu karakter (kasus paling umum: preset animasi
  // per-HURUF seperti Apple/Glitch/Typewriter/Flip/Split Flap/Popcorn,
  // tiap "unit" ya cuma 1 huruf), tidak ada karakter lain di sebelahnya
  // untuk diberi jarak — jadi tidak perlu masuk ke loop pengukuran per
  // karakter sama sekali, langsung fillText biasa. Ini menghindari satu
  // ctx.measureText() yang sia-sia per huruf per frame.
  if (!spacing || text.length <= 1) { ctx.fillText(text, x, y); return; }
  let cx = x;
  for (const ch of text) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + spacing; }
}

// FIX PERFORMA (preset kompleks tersendat): splitUnits() dulu dipanggil
// ulang dari NOL setiap frame (bisa 60x/detik saat memutar) walau hasilnya
// selalu sama persis selama teks & mode animasi klip itu tidak berubah —
// pemisahan string per-huruf/kata pakai regex jadi beban yang terbuang
// percuma tiap frame. Di-cache di sini per OBJEK klip (bukan per id klip)
// memakai WeakMap: karena reducer proyek selalu membuat objek klip BARU
// setiap kali ada perubahan (lihat UPDATE_CLIP — pola immutable), cache
// ini otomatis "basi" dengan sendirinya begitu teks/animateBy diedit,
// tanpa perlu bandingkan field satu-satu, dan entry lama otomatis dibuang
// dari memori oleh garbage collector begitu objek klip lama tidak dipakai
// lagi (itulah kenapa WeakMap, bukan Map biasa).
const unitsCache = new WeakMap();
function getCachedUnits(clip) {
  let hit = unitsCache.get(clip);
  if (!hit) {
    hit = splitUnits(clip.text, clip.animateBy);
    unitsCache.set(clip, hit);
  }
  return hit;
}

function combinePose(unitP, transP) {
  const s = (unitP.scale ?? 1) * (transP.scale ?? 1);
  return {
    opacity: clamp((unitP.opacity ?? 1) * (transP.opacity ?? 1), 0, 1),
    x: (unitP.x || 0) + (transP.x || 0),
    y: (unitP.y || 0) + (transP.y || 0),
    rotation: (unitP.rotation || 0) + (transP.rotation || 0),
    blur: Math.max(unitP.blur || 0, transP.blur || 0),
    scale: s,
    scaleX: s * (transP.scaleX ?? 1),
    scaleY: s * (transP.scaleY ?? 1),
    letterSpacing: unitP.letterSpacing || 0,
  };
}

/* ============================================================
   BACKGROUND
   ============================================================ */

function gradientPoints(angleDeg, w, h) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  const cx = w / 2, cy = h / 2;
  const len = Math.sqrt(w * w + h * h) / 2;
  const dx = Math.cos(rad) * len, dy = Math.sin(rad) * len;
  return { x0: cx - dx, y0: cy - dy, x1: cx + dx, y1: cy + dy };
}

function paintBackground(ctx, bg, w, h, imgEl) {
  if (bg.type === "gradient") {
    const { x0, y0, x1, y1 } = gradientPoints(bg.gradAngle || 135, w, h);
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, bg.gradFrom || "#1c1c28");
    g.addColorStop(1, bg.gradTo || "#08080a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  } else if (bg.type === "image" && imgEl && imgEl.naturalWidth) {
    const iw = imgEl.naturalWidth, ih = imgEl.naturalHeight;
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale, dh = ih * scale;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(imgEl, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = bg.color || "#0d0d10";
    ctx.fillRect(0, 0, w, h);
  }
}

/* ============================================================
   RENDERING
   ============================================================ */

// TEKS MELINGKAR — huruf disusun mengelilingi sebuah lingkaran (bukan pada
// baris lurus) lalu SELURUH cincinnya berputar terus selama klip berjalan.
// Ini mode LAYOUT, bukan sekadar animasi masuk: dipakai preset ber-`layout:
// "circle"`. Kecepatan putar konstan (spinDir menentukan arah), dan huruf
// dibuat tangensial terhadap lingkaran supaya terbaca melingkar rapi.
function drawCircularText(mainCtx, offCtx, clip, localTime, w, h, spinDir) {
  const raw = (clip.text || "").replace(/\s*\n\s*/g, " ").trim();
  const chars = [...raw];
  if (chars.length === 0) return null;
  const off = clip.offset;
  const inTrans = getTransition(clip.transitionInId);
  const outTrans = getTransition(clip.transitionOutId);
  const tp = sampleTransitionPose(inTrans, outTrans, localTime, clip.duration, 0.42);
  const baseAlpha = clamp(tp.opacity ?? 1, 0, 1);
  const cx = w / 2 + off.x + (tp.x || 0);
  const cy = h / 2 + off.y + (tp.y || 0);

  const font = `${clip.fontSize}px ${clip.fontFamily}`;
  offCtx.font = font;
  const gap = (clip.letterSpacing || 0) + clip.fontSize * 0.18; // jarak antar huruf pada busur
  const widths = chars.map((c) => offCtx.measureText(c).width || clip.fontSize * 0.4);
  const arcTotal = widths.reduce((a, b) => a + b, 0) + gap * chars.length;
  const naturalR = arcTotal / (2 * Math.PI);
  const maxR = Math.max(clip.fontSize * 1.1, Math.min(w, h) * 0.42 - clip.fontSize * 0.5);
  const R = clamp(naturalR, clip.fontSize * 1.1, maxR);
  // Putaran konstan: ~1 putaran penuh tiap 7 detik, arah sesuai spinDir.
  const spin = spinDir * (localTime / 1000) * (2 * Math.PI / 7);

  const s = (tp.scale ?? 1) * off.scale;
  mainCtx.save();
  mainCtx.translate(cx, cy);
  mainCtx.rotate(((tp.rotation || 0) + off.rotation) * Math.PI / 180);
  mainCtx.scale(s, s);
  mainCtx.globalAlpha = baseAlpha;
  mainCtx.fillStyle = clip.color;
  mainCtx.font = font;
  mainCtx.textBaseline = "middle";
  mainCtx.textAlign = "left";
  let arcPos = 0;
  for (let i = 0; i < chars.length; i++) {
    const cwid = widths[i];
    const a = spin + (arcPos + (cwid + gap) / 2) / R; // sudut pusat huruf pada lingkaran
    arcPos += cwid + gap;
    mainCtx.save();
    mainCtx.translate(Math.sin(a) * R, -Math.cos(a) * R);
    mainCtx.rotate(a);
    mainCtx.fillText(chars[i], -cwid / 2, 0);
    mainCtx.restore();
  }
  mainCtx.restore();

  const half = (R + clip.fontSize) * s;
  return { cx, cy, halfW: half, halfH: half, rotation: 0 };
}

function drawTextClip(mainCtx, offCtx, offCanvas, clip, playheadMs, w, h, blurCanvas, blurCtx) {
  const localTime = playheadMs - clip.start;
  if (localTime < 0 || localTime > clip.duration) return null;
  const preset = getPreset(clip.presetId);
  // Preset khusus dengan tata letak melingkar mengambil alih seluruh
  // penggambaran (huruf disusun & diputar mengelilingi lingkaran).
  if (preset.layout === "circle") {
    return drawCircularText(mainCtx, offCtx, clip, localTime, w, h, preset.spinDir || 1);
  }
  const inTrans = getTransition(clip.transitionInId);
  const outTrans = getTransition(clip.transitionOutId);
  const transPose = sampleTransitionPose(inTrans, outTrans, localTime, clip.duration, 0.42);

  offCtx.clearRect(0, 0, w, h);
  offCtx.font = `${clip.fontSize}px ${clip.fontFamily}`;
  offCtx.textBaseline = "alphabetic";
  offCtx.fillStyle = clip.color;

  const { units, totalUnits, lines } = getCachedUnits(clip);
  const lineHeight = clip.fontSize * (clip.lineHeight ?? 1.25);
  const blockH = lines.length * lineHeight;
  const off = clip.offset;
  let maxBlur = 0;
  const animOpts = { animateIn: clip.animateIn, animateOut: clip.animateOut, easing: clip.easing };

  const pose0raw = samplePose(preset, 0, clip.stagger, localTime, clip.duration, 0, animOpts);
  const pose0 = combinePose(pose0raw, transPose);
  const ls = (pose0.letterSpacing || 0) + (clip.letterSpacing || 0);
  const measure = (str) => measureLine(offCtx, str, ls);

  // Perataan teks (kiri/tengah/kanan). Untuk itu lebar tiap baris & lebar
  // baris TERPANJANG dihitung dulu; tiap baris lalu digeser supaya rata ke
  // tepi blok bersama. `align` undefined dianggap "center" (perilaku lama).
  const align = clip.align || "center";
  const lineEffW = lines.map((line, li) => {
    if (clip.animateBy === "word") {
      return units.filter((u) => u.line === li).reduce((a, u) => a + measure(u.text), 0);
    }
    return measure(line);
  });
  const maxLineW = Math.max(1, ...lineEffW);
  // Pergeseran pusat sebuah baris (lebar lw) relatif terhadap pusat blok.
  const alignShift = (lw) => (align === "left" ? (lw - maxLineW) / 2 : align === "right" ? (maxLineW - lw) / 2 : 0);

  // `uw` (lebar unit) sekarang WAJIB dihitung sekali oleh pemanggil dan
  // dioper masuk ke sini lewat parameter — sebelumnya applyUnit mengukur
  // ULANG teks yang sama persis dengan yang sudah/akan diukur pemanggil
  // untuk menata posisi cursor, jadi tiap unit bisa kena ctx.measureText()
  // sampai 2-3x per frame. Preset per-huruf yang unitnya banyak (Apple,
  // Glitch, Typewriter, Flip, Split Flap, Popcorn Chars) paling kerasa
  // dampaknya — itulah sumber utama keluhan "tersendat-sendat" pada
  // preset kompleks.
  const applyUnit = (text, cx, cy, pRaw, uw) => {
    const p = combinePose(pRaw, transPose);
    maxBlur = Math.max(maxBlur, p.blur || 0);
    offCtx.save();
    offCtx.translate(cx + p.x + off.x, cy + p.y + off.y);
    offCtx.rotate(((p.rotation || 0) + off.rotation) * Math.PI / 180);
    offCtx.scale((p.scaleX ?? p.scale ?? 1) * off.scale, (p.scaleY ?? p.scale ?? 1) * off.scale);
    offCtx.globalAlpha = clamp(p.opacity ?? 1, 0, 1);
    if (ls) drawSpacedText(offCtx, text, -uw / 2, 0, ls); else offCtx.fillText(text, -uw / 2, 0);
    offCtx.restore();
  };

  let maxW = 0;
  if (clip.animateBy === "all") {
    const p = combinePose(pose0raw, transPose);
    maxBlur = p.blur || 0;
    offCtx.save();
    offCtx.translate(w / 2 + p.x + off.x, h / 2 + p.y + off.y);
    offCtx.rotate(((p.rotation || 0) + off.rotation) * Math.PI / 180);
    offCtx.scale((p.scaleX ?? p.scale ?? 1) * off.scale, (p.scaleY ?? p.scale ?? 1) * off.scale);
    offCtx.globalAlpha = clamp(p.opacity ?? 1, 0, 1);
    lines.forEach((line, li) => {
      const lw = measure(line);
      maxW = Math.max(maxW, lw);
      const ly = -blockH / 2 + li * lineHeight + clip.fontSize * 0.35 + lineHeight / 2;
      const sx = -lw / 2 + alignShift(lw);
      if (ls) drawSpacedText(offCtx, line, sx, ly, ls); else offCtx.fillText(line, sx, ly);
    });
    offCtx.restore();
  } else if (clip.animateBy === "line") {
    units.forEach((u) => {
      const seed = totalUnits > 1 ? u.index / (totalUnits - 1) : 0;
      const p = samplePose(preset, u.index, clip.stagger, localTime, clip.duration, seed, animOpts);
      const baseY = -blockH / 2 + u.line * lineHeight + clip.fontSize * 0.35 + lineHeight / 2;
      const uw = measure(u.text);
      maxW = Math.max(maxW, uw);
      applyUnit(u.text, w / 2 + alignShift(uw), h / 2 + baseY, p, uw);
    });
  } else {
    const isChar = clip.animateBy === "char";
    lines.forEach((line, li) => {
      const lineUnits = units.filter((u) => u.line === li);
      // Lebar tiap unit diukur SATU KALI di sini (bukan diukur lagi di
      // dalam applyUnit), lalu dipakai dua kali: untuk menata posisi
      // cursor di baris ini, dan dioper ke applyUnit untuk memusatkan
      // teksnya — lihat catatan performa di atas applyUnit.
      const uws = lineUnits.map((u) => measure(u.text));
      const totalW = uws.reduce((a, b) => a + b, 0) + (isChar ? ls * Math.max(0, lineUnits.length - 1) : 0);
      maxW = Math.max(maxW, totalW);
      let cursor = -totalW / 2 + alignShift(totalW);
      const baseY = -blockH / 2 + li * lineHeight + clip.fontSize * 0.35 + lineHeight / 2;
      lineUnits.forEach((u, i) => {
        const uw = uws[i];
        const centerX = cursor + uw / 2;
        const seed = totalUnits > 1 ? u.index / (totalUnits - 1) : 0;
        const p = samplePose(preset, u.index, clip.stagger, localTime, clip.duration, seed, animOpts);
        applyUnit(u.text, w / 2 + centerX, h / 2 + baseY, p, uw);
        cursor += uw + (isChar ? ls : 0);
      });
    });
  }

  // Ketika preset punya blur (mis. Cinematic, Blur Zoom, Soft Focus dst),
  // ctx.filter = blur(...) itu OPERASI CANVAS 2D YANG PALING MAHAL di
  // seluruh alur gambar ini — biayanya sebanding dengan luas area yang
  // di-filter. Sebelumnya kita selalu mem-blur & meng-composite SATU
  // FRAME PENUH (mis. 1080×1920) walau teksnya sendiri cuma menutupi
  // sebagian kecil area itu — itulah sumber "tersendat" yang dilaporkan
  // khusus muncul di preset ber-blur. Di sini area yang di-composite
  // dipersempit ke kotak pembungkus teks (+ padding besar untuk jaga-jaga
  // gerak per-karakter yang belum presis sinkron dengan pose acuannya),
  // bukan seluruh kanvas — hasil visualnya identik, cuma areanya lebih
  // kecil sehingga jauh lebih ringan tanpa mengorbankan akurasi tampilan.
  const s = (pose0.scale ?? 1) * off.scale;
  const rot = ((pose0.rotation || 0) + off.rotation) * Math.PI / 180;
  const rawHalfW = (Math.max(maxW, 20) * s) / 2 + 14;
  const rawHalfH = (Math.max(blockH, lineHeight) * s) / 2 + 10;
  const rotHalfW = Math.abs(rawHalfW * Math.cos(rot)) + Math.abs(rawHalfH * Math.sin(rot));
  const rotHalfH = Math.abs(rawHalfW * Math.sin(rot)) + Math.abs(rawHalfH * Math.cos(rot));
  const cx = w / 2 + pose0.x + off.x, cy = h / 2 + pose0.y + off.y;
  const pad = maxBlur * 3 + 100;
  const csx = Math.max(0, Math.floor(cx - rotHalfW - pad));
  const csy = Math.max(0, Math.floor(cy - rotHalfH - pad));
  const cex = Math.min(w, Math.ceil(cx + rotHalfW + pad));
  const cey = Math.min(h, Math.ceil(cy + rotHalfH + pad));
  const cw = cex - csx, ch = cey - csy;

  if (cw > 0 && ch > 0) {
    if (maxBlur > 0.4 && blurCanvas && blurCtx) {
      // FIX STUTTER: ctx.filter = blur(...) itu mahal SEBANDING DENGAN
      // JUMLAH PIKSEL TUJUAN yang dirender-ulang — bukan konten sumbernya.
      // Sebelumnya blur langsung dijalankan di kanvas utama pada ukuran
      // penuh area teks, dan itulah yang bikin frame nyendat/ngebug tiap
      // preset ber-blur diputar. Triknya: gambar dulu area yang sama ke
      // kanvas "scratch" berukuran JAUH LEBIH KECIL (diperkecil sesuai
      // besar blur-nya — makin blur, makin kecil), blur di situ (murah
      // karena piksel sedikit), lalu tempel hasilnya membesar ke kanvas
      // utama TANPA filter (cuma resize gambar, operasi paling murah).
      // Detail halus toh sudah hilang karena diblur, jadi hasil visualnya
      // identik dengan sebelumnya, hanya jauh lebih ringan & mulus.
      const dscale = clamp(1 - maxBlur / 60, 0.35, 1);
      const sw = Math.max(1, Math.round(cw * dscale)), sh = Math.max(1, Math.round(ch * dscale));
      if (blurCanvas.width !== sw) blurCanvas.width = sw;
      if (blurCanvas.height !== sh) blurCanvas.height = sh;
      blurCtx.clearRect(0, 0, sw, sh);
      blurCtx.filter = `blur(${maxBlur * dscale}px)`;
      blurCtx.drawImage(offCanvas, csx, csy, cw, ch, 0, 0, sw, sh);
      blurCtx.filter = "none";
      mainCtx.drawImage(blurCanvas, 0, 0, sw, sh, csx, csy, cw, ch);
    } else {
      mainCtx.save();
      mainCtx.drawImage(offCanvas, csx, csy, cw, ch, csx, csy, cw, ch);
      mainCtx.restore();
    }
  }

  return {
    cx, cy,
    halfW: rawHalfW,
    halfH: rawHalfH,
    rotation: (pose0.rotation || 0) + off.rotation,
  };
}

function drawMediaVisual(mainCtx, el, clip, playheadMs, w, h, blurCanvas, blurCtx) {
  const localTime = playheadMs - clip.start;
  if (localTime < 0 || localTime > clip.duration) return null;
  const inTrans = getTransition(clip.transitionInId);
  const outTrans = getTransition(clip.transitionOutId);
  const transPose = sampleTransitionPose(inTrans, outTrans, localTime, clip.duration, 0.31);
  // Preset animasi (sama seperti klip teks, dievaluasi sebagai satu unit
  // utuh — gambar/video tidak punya "per-karakter") dikombinasikan dengan
  // pose transisi masuk/keluar di atas, jadi keduanya bisa dipakai
  // bersamaan: preset untuk gaya gerak utamanya, transisi untuk potongan
  // di batas klip.
  const preset = getPreset(clip.presetId || "none");
  const presetPose = clip.presetId && clip.presetId !== "none"
    ? samplePose(preset, 0, 0, localTime, clip.duration, 0, { animateIn: clip.animateIn, animateOut: clip.animateOut, easing: clip.easing })
    : REST_POSE;
  const p = combinePose(presetPose, transPose);
  const off = clip.offset;

  const naturalW = el?.naturalWidth || el?.videoWidth || 0;
  const naturalH = el?.naturalHeight || el?.videoHeight || 0;
  const maxW = w * 0.62, maxH = h * 0.62;
  // Beberapa aset (mis. SVG tanpa atribut width/height) melaporkan
  // naturalWidth/Height = 0 walau sudah termuat sempurna — jangan sampai
  // itu membuat elemen selamanya digambar sebagai kotak placeholder.
  // Kalau dimensi asli tidak diketahui, jatuhkan ke rasio persegi.
  let dw = maxW, dh = naturalW && naturalH ? dw * naturalH / naturalW : maxW;
  if (dh > maxH) { dh = maxH; dw = naturalW && naturalH ? dh * naturalW / naturalH : maxH; }

  const cx = w / 2 + (p.x || 0) + off.x, cy = h / 2 + (p.y || 0) + off.y;
  const sx = (p.scaleX ?? p.scale ?? 1) * off.scale, sy = (p.scaleY ?? p.scale ?? 1) * off.scale;

  mainCtx.save();
  mainCtx.translate(cx, cy);
  mainCtx.rotate(((p.rotation || 0) + off.rotation) * Math.PI / 180);
  mainCtx.scale(sx, sy);
  mainCtx.globalAlpha = clamp(p.opacity ?? 1, 0, 1);
  const blurPx = p.blur || 0;
  if (el && el.__mfsReady && !el.__mfsFailed) {
    try {
      if (blurPx > 0.4 && blurCanvas && blurCtx) {
        // Sama seperti drawTextClip: blur di kanvas kecil dulu (murah),
        // lalu tempel membesar via drawImage biasa ke mainCtx yang sudah
        // ditranslate/dirotasi/discale — jadi rotasi & posisi tetap benar,
        // cuma proses blur-nya yang tidak lagi membebani frame penuh.
        const dscale = clamp(1 - blurPx / 60, 0.35, 1);
        const sw = Math.max(1, Math.round(dw * dscale)), sh = Math.max(1, Math.round(dh * dscale));
        if (blurCanvas.width !== sw) blurCanvas.width = sw;
        if (blurCanvas.height !== sh) blurCanvas.height = sh;
        blurCtx.clearRect(0, 0, sw, sh);
        blurCtx.filter = `blur(${blurPx * dscale}px)`;
        blurCtx.drawImage(el, 0, 0, sw, sh);
        blurCtx.filter = "none";
        mainCtx.drawImage(blurCanvas, 0, 0, sw, sh, -dw / 2, -dh / 2, dw, dh);
      } else {
        mainCtx.drawImage(el, -dw / 2, -dh / 2, dw, dh);
      }
    } catch (e) { /* elemen sempat belum siap saat digambar, akan dicoba lagi frame berikutnya */ }
  } else if (el && el.__mfsFailed) {
    mainCtx.fillStyle = "#2a1418";
    mainCtx.strokeStyle = "#6a2530";
    mainCtx.lineWidth = 1.5;
    mainCtx.fillRect(-dw / 2, -dh / 2, dw, dh);
    mainCtx.strokeRect(-dw / 2, -dh / 2, dw, dh);
  } else {
    // Masih memuat — kotak placeholder redup, akan otomatis diganti
    // gambar/video aslinya begitu event "ready" media ini terpicu.
    mainCtx.fillStyle = "#1c1c22";
    mainCtx.fillRect(-dw / 2, -dh / 2, dw, dh);
  }
  mainCtx.restore();

  return { cx, cy, halfW: (dw * sx) / 2 + 8, halfH: (dh * sy) / 2 + 8, rotation: (p.rotation || 0) + off.rotation };
}

function drawSelectionOverlay(ctx, bbox) {
  ctx.save();
  ctx.translate(bbox.cx, bbox.cy);
  ctx.rotate((bbox.rotation * Math.PI) / 180);
  ctx.strokeStyle = "#7c6cff";
  ctx.lineWidth = 1.25;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(-bbox.halfW, -bbox.halfH, bbox.halfW * 2, bbox.halfH * 2);
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(0, -bbox.halfH); ctx.lineTo(0, -bbox.halfH - 26); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, -bbox.halfH - 26, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = "#7c6cff"; ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = "#0d0d10"; ctx.stroke();
  ctx.restore();
}

/* ============================================================
   MEDIA ELEMENT MANAGEMENT (video/image/audio)
   ============================================================ */

function useMediaElements(clips, onReady, onVideoDuration) {
  const mapRef = useRef({ image: {}, video: {}, audio: {} });
  const containerRef = useRef(null);

  // Video & audio elements (dan, untuk aman, gambar juga) sengaja
  // dipasang ke DOM nyata — banyak browser (terutama di mobile) tidak mau
  // mendekode frame video / memicu event "loadeddata" secara andal untuk
  // elemen <video> yang tidak pernah ditempel ke document. Wadahnya
  // disembunyikan total (0×0, opacity 0, di luar layar) jadi tidak
  // memengaruhi tampilan apa pun.
  useEffect(() => {
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;";
    document.body.appendChild(el);
    containerRef.current = el;
    return () => { el.remove(); containerRef.current = null; };
  }, []);

  useEffect(() => {
    const wantIds = { image: new Set(), video: new Set(), audio: new Set() };
    clips.forEach((c) => {
      if (c.type !== "image" && c.type !== "video" && c.type !== "audio") return;
      wantIds[c.type].add(c.id);
      const bucket = mapRef.current[c.type];
      const existing = bucket[c.id];
      if (!existing || existing.src !== c.src) {
        if (existing) { try { existing.el.pause && existing.el.pause(); existing.el.remove && existing.el.remove(); } catch (e) {} }
        let el;
        // __mfsReady menandai elemen media ini SUDAH BENAR-BENAR SIAP untuk
        // digambar/diputar. Sebelumnya kode ini menandakan "siap" hanya
        // lewat naturalWidth (untuk gambar) — itu gagal untuk SVG tanpa
        // atribut width/height eksplisit (naturalWidth-nya 0 walau sudah
        // termuat sempurna), sehingga canvas TERUS menampilkan kotak
        // kosong walau file sebenarnya berhasil diimpor. Flag eksplisit
        // ini dipakai di drawMediaVisual() sebagai gerbang utama.
        if (c.type === "image") {
          el = new Image();
          el.__mfsReady = false;
          el.__mfsFailed = false;
          const markReady = () => { el.__mfsReady = true; onReady && onReady(); };
          el.onload = markReady;
          // decode() memberi sinyal "siap digambar" yang lebih andal di
          // sebagian browser dibanding onload saja (terutama untuk SVG).
          el.decode ? el.decode().then(markReady).catch(() => {}) : null;
          el.onerror = () => {
            // Kalau src blob:-nya diblokir CSP, coba sekali lagi lewat data URL
            // dari File aslinya sebelum menyerah.
            if (!el.__mfsTriedData && c.file) {
              el.__mfsTriedData = true;
              readFileAsDataURL(c.file).then((u) => { el.src = u; }).catch(() => {
                el.__mfsFailed = true;
                reportError(`Gagal memuat gambar "${c.name || c.src}". File mungkin rusak atau formatnya tidak didukung browser.`);
                onReady && onReady();
              });
              return;
            }
            el.__mfsFailed = true;
            reportError(`Gagal memuat gambar "${c.name || c.src}". File mungkin rusak, formatnya tidak didukung browser, atau sumbernya sudah tidak berlaku (coba impor ulang filenya).`);
            onReady && onReady();
          };
          el.src = c.src;
        } else if (c.type === "video") {
          el = document.createElement("video");
          el.__mfsReady = false;
          el.__mfsFailed = false;
          el.muted = true; el.playsInline = true; el.setAttribute("playsinline", ""); el.preload = "auto"; el.loop = false;
          el.style.cssText = "position:absolute;width:2px;height:2px;";
          const markReady = () => { el.__mfsReady = true; onReady && onReady(); };
          // Klip video baru selalu dibuat dengan durasi placeholder (lihat
          // makeMediaClip) karena panjang video sesungguhnya belum diketahui
          // saat itu — begitu metadata file benar-benar termuat, sinkronkan
          // durasi klip di linimasa dengan durasi ASLI videonya, sekali
          // saja, supaya klip tidak "terpotong" secara diam-diam di 3.2dtk
          // atau justru lebih panjang dari videonya.
          let durationSynced = false;
          const syncDuration = () => {
            if (durationSynced) return;
            if (Number.isFinite(el.duration) && el.duration > 0) {
              durationSynced = true;
              onVideoDuration && onVideoDuration(c.id, Math.round(el.duration * 1000));
            }
          };
          // Beberapa browser (terutama di mobile / saat elemen video tak
          // pernah ditampilkan) tidak konsisten menembakkan "loadeddata" —
          // dengarkan beberapa event supaya frame pertama tetap tertangkap.
          el.onloadeddata = markReady;
          el.onloadedmetadata = () => { markReady(); syncDuration(); };
          el.oncanplay = () => { markReady(); syncDuration(); };
          // MediaError.code memberi tahu ALASAN SESUNGGUHNYA kenapa video
          // gagal (bukan cuma "gagal" generik) — ini sangat menentukan:
          // code 4 (SRC_NOT_SUPPORTED) hampir selalu berarti kontainer/codec
          // filenya (mis. .mov H.265/HEVC dari iPhone atau layar Mac) memang
          // tidak bisa didekode browser ini sama sekali, sedangkan code 2
          // (NETWORK) menunjuk ke masalah lain (mis. data URI-nya terlalu
          // besar/rusak saat dibaca). Tanpa ini pengguna hanya melihat kotak
          // merah tanpa tahu harus memperbaiki apa.
          const MEDIA_ERR_MSG = {
            1: "dibatalkan sebelum selesai dimuat (MEDIA_ERR_ABORTED).",
            2: "kegagalan jaringan saat memuat sumbernya (MEDIA_ERR_NETWORK).",
            3: "gagal saat proses decode — filenya kemungkinan rusak/tidak lengkap (MEDIA_ERR_DECODE).",
            4: "kontainer/codec videonya TIDAK didukung sama sekali oleh browser ini (MEDIA_ERR_SRC_NOT_SUPPORTED) — ini penyebab paling umum untuk file .mov H.265/HEVC dari iPhone atau hasil rekam layar Mac.",
          };
          const failVideo = (reason) => {
            if (el.__mfsFailed || el.__mfsReady) return;
            // Percobaan kedua lewat data URL kalau blob: diblokir CSP (kasus
            // umum di sandbox preview Artifact) — banyak video yang "gagal"
            // sebetulnya cuma soal skema src-nya, bukan codec-nya.
            if (!el.__mfsTriedData && c.file) {
              el.__mfsTriedData = true;
              readFileAsDataURL(c.file).then((u) => { el.src = u; el.load(); }).catch(() => {});
              return;
            }
            el.__mfsFailed = true;
            const detail = el.error ? MEDIA_ERR_MSG[el.error.code] : null;
            reportError(`Gagal memuat video "${c.name || c.src}". ${detail || reason} Di preview Artifact, .mp4 (H.264) dan .mov (H.265/HEVC) sering tak bisa didekode — format paling andal adalah .webm (VP9) atau .mp4 H.264.`);
            onReady && onReady();
          };
          el.onerror = () => failVideo("File mungkin rusak atau formatnya tidak didukung.");
          el.onstalled = () => failVideo("Pemuatan file berhenti di tengah jalan.");
          // Jika tak ada event apa pun yang menyala dalam 15 detik (mis.
          // file terlalu besar sebagai data URI, atau browser diam-diam
          // menolak mendekodenya), anggap gagal alih-alih diam selamanya
          // — sebelumnya kegagalan semacam ini tidak pernah terlihat oleh
          // pengguna karena tak ada event yang tertangkap sama sekali.
          const stallTimer = setTimeout(() => {
            if (!el.__mfsReady && !el.__mfsFailed && el.isConnected) {
              failVideo("Videonya tidak kunjung selesai dimuat (timeout).");
            }
          }, 15000);
          const clearStallTimer = () => clearTimeout(stallTimer);
          el.addEventListener("loadeddata", clearStallTimer);
          el.addEventListener("error", clearStallTimer);
          el.src = c.src;
          el.load();
        } else {
          el = new Audio();
          el.__mfsReady = false;
          el.__mfsFailed = false;
          el.preload = "auto";
          const markReady = () => { el.__mfsReady = true; onReady && onReady(); };
          el.onloadeddata = markReady;
          el.onloadedmetadata = markReady;
          el.onerror = () => {
            if (!el.__mfsTriedData && c.file) {
              el.__mfsTriedData = true;
              readFileAsDataURL(c.file).then((u) => { el.src = u; el.load(); }).catch(() => {});
              return;
            }
            el.__mfsFailed = true;
            reportError(`Gagal memuat audio "${c.name || c.src}". Coba format .mp3, .wav, .m4a, atau .ogg.`);
            onReady && onReady();
          };
          el.src = c.src;
          el.load();
        }
        if (containerRef.current) containerRef.current.appendChild(el);
        bucket[c.id] = { el, src: c.src, srcNode: null };
      }
    });
    ["image", "video", "audio"].forEach((kind) => {
      const bucket = mapRef.current[kind];
      Object.keys(bucket).forEach((id) => {
        if (!wantIds[kind].has(id)) {
          try { if (bucket[id].el.pause) bucket[id].el.pause(); if (bucket[id].el.remove) bucket[id].el.remove(); } catch (e) {}
          delete bucket[id];
        }
      });
    });
  }, [clips, onReady]);
  return mapRef;
}

// Browser modern hanya mengizinkan pemutaran otomatis (autoplay) media
// yang punya suara jika elemen itu pernah "diaktifkan" oleh gestur
// pengguna yang nyata (klik) — memanggil .play() dari dalam efek React
// (yang berjalan setelah event klik selesai) sering dianggap BUKAN gestur
// asli lagi, sehingga video/audio "berhasil diimpor" tapi diam-diam gagal
// diputar. Fungsi ini memicu play()+pause() secara sinkron tepat di dalam
// handler klik tombol Play untuk "mengaktifkan" semua elemen media sekali,
// supaya panggilan .play() berikutnya dari loop playback tetap diizinkan.
function primeMediaElements(mediaMapRef) {
  const entries = [...Object.values(mediaMapRef.current.video), ...Object.values(mediaMapRef.current.audio)];
  entries.forEach((entry) => {
    if (!entry || !entry.el) return;
    try {
      const p = entry.el.play();
      if (p && p.catch) p.catch(() => {});
      entry.el.pause();
    } catch (e) { /* elemen belum siap, akan dicoba lagi saat playback jalan */ }
  });
}

function syncMediaPlayback(clips, mediaMapRef, timeMs, playing) {
  clips.forEach((c) => {
    if (c.type !== "video" && c.type !== "audio") return;
    const entry = mediaMapRef.current[c.type][c.id];
    if (!entry) return;
    const el = entry.el;
    const local = timeMs - c.start;
    const active = local >= 0 && local <= c.duration;
    if (active) {
      const inTrans = getTransition(c.transitionInId);
      const outTrans = getTransition(c.transitionOutId);
      const tp = sampleTransitionPose(inTrans, outTrans, local, c.duration, 0.31);
      const targetVol = clamp((c.volume ?? 1) * clamp(tp.opacity ?? 1, 0, 1), 0, 1);
      try { el.muted = c.type === "video" ? !!c.muted : false; el.volume = targetVol; } catch (e) {}
      if (playing) {
        if (el.paused) {
          try { el.currentTime = Math.max(0, local / 1000); } catch (e) {}
          el.play().catch(() => {});
        }
      } else {
        if (!el.paused) el.pause();
        try { el.currentTime = Math.max(0, local / 1000); } catch (e) {}
      }
    } else if (!el.paused) {
      el.pause();
    }
  });
}

/* ============================================================
   STYLES
   ============================================================ */

const GlobalStyle = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
    :root {
      --bg:#0a0a0c; --bg-panel:#111114; --bg-elevated:#17171b; --bg-hover:#1c1c21;
      --border:#232328; --border-light:#2a2a30; --text:#eceef0; --text-muted:#8c8c96; --text-dim:#55555f;
      --accent:#7c6cff; --accent-soft:rgba(124,108,255,0.16); --accent-dim:rgba(124,108,255,0.55); --radius:7px;
      --popover-shadow:rgba(0,0,0,0.5); --stage-checker:#1c1c21;
    }
    /* Mode Terang — semua komponen sudah dibangun di atas variabel CSS ini,
       jadi cukup timpa nilainya di sini; tidak perlu sentuh style lain. */
    .mfs-root[data-theme="light"] {
      --bg:#f4f4f6; --bg-panel:#ffffff; --bg-elevated:#f7f7f9; --bg-hover:#ececef;
      --border:#e2e2e7; --border-light:#dcdce2; --text:#1c1c22; --text-muted:#6b6b76; --text-dim:#9c9ca6;
      --accent:#6a56f0; --accent-soft:rgba(106,86,240,0.12); --accent-dim:rgba(106,86,240,0.5);
      --popover-shadow:rgba(20,20,40,0.14); --stage-checker:#e6e6ea;
    }
    * { box-sizing: border-box; }
    .mfs-root { font-family:'Inter',-apple-system,sans-serif; background:var(--bg); color:var(--text); height:100vh; width:100%;
      display:grid; grid-template-columns:200px 268px 1fr 320px; grid-template-rows:48px 1fr 226px;
      grid-template-areas:"top top top top" "layers left center right" "timeline timeline timeline timeline"; overflow:hidden; font-size:13px;
      transition:background .15s ease, color .15s ease; }
    .mfs-theme-toggle { position:relative; overflow:hidden; }
    .mfs-theme-toggle svg { transition:transform .2s ease, opacity .2s ease; }
    ::-webkit-scrollbar{width:8px;height:8px;} ::-webkit-scrollbar-thumb{background:var(--border-light);border-radius:4px;} ::-webkit-scrollbar-track{background:transparent;}

    .mfs-top { grid-area:top; display:flex; align-items:center; justify-content:space-between; padding:0 14px; border-bottom:1px solid var(--border); background:var(--bg-panel); }
    .mfs-top-left { display:flex; align-items:center; gap:16px; }
    .mfs-top-right { display:flex; align-items:center; gap:6px; }
    .mfs-top-info { font-size:11.5px; color:var(--text-dim); margin-right:6px; white-space:nowrap; }
    .mfs-top-sep { width:1px; height:18px; background:var(--border); margin:0 4px; flex-shrink:0; }
    .mfs-align-group { display:flex; align-items:center; gap:1px; }
    .mfs-align-div { width:1px; height:16px; background:var(--border); margin:0 4px; flex-shrink:0; }
    /* Perataan teks di panel kanan: ikon polos tanpa kotak/border. */
    .mfs-align-inline { display:flex; align-items:center; gap:10px; }
    .mfs-align-ibtn { background:transparent; border:none; padding:4px; border-radius:6px; color:var(--text-dim); cursor:pointer; display:flex; align-items:center; justify-content:center; transition:color .12s ease, background .12s ease; }
    .mfs-align-ibtn:hover { color:var(--text); background:var(--bg-hover); }
    .mfs-align-ibtn.active { color:var(--accent); background:transparent; }
    /* Baris centang animasi masuk/keluar. */
    .mfs-check-row { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--text); cursor:pointer; padding:3px 0; user-select:none; }
    .mfs-check-row input { width:15px; height:15px; accent-color:var(--accent); cursor:pointer; }
    .mfs-select { cursor:pointer; }
    .mfs-preview-btn { display:flex; align-items:center; gap:6px; height:28px; padding:0 12px; border-radius:var(--radius); background:transparent; border:1px solid var(--border-light); color:var(--text); font-size:12px; font-weight:500; cursor:pointer; }
    .mfs-preview-btn:hover { background:var(--bg-hover); }
    .mfs-preview-btn.active { border-color:var(--accent-dim); color:var(--accent); }
    .mfs-export-btn { display:flex; align-items:center; gap:6px; height:28px; padding:0 14px; border-radius:var(--radius); background:var(--accent); border:1px solid var(--accent); color:#fff; font-size:12px; font-weight:600; cursor:pointer; }
    .mfs-export-btn:hover { background:#6a5aff; }
    .mfs-export-btn:disabled, .mfs-preview-btn:disabled { opacity:0.5; cursor:not-allowed; }
    .mfs-brand { display:flex; align-items:center; gap:8px; font-weight:600; letter-spacing:-0.01em; }
    .mfs-brand-mark { width:20px; height:20px; border-radius:5px; background:linear-gradient(135deg,var(--accent),#4b3ff0); display:flex; align-items:center; justify-content:center; }

    .mfs-btn { display:inline-flex; align-items:center; gap:6px; background:var(--bg-elevated); border:1px solid var(--border-light); color:var(--text); padding:6px 10px; border-radius:var(--radius); font-size:12.5px; font-weight:500; cursor:pointer; }
    .mfs-btn:hover { background:var(--bg-hover); border-color:#3a3a42; }
    .mfs-btn:disabled { opacity:0.5; cursor:not-allowed; }
    .mfs-btn-sm { padding:4px 8px; font-size:11px; }
    .mfs-btn-primary { background:var(--accent); border-color:var(--accent); }
    .mfs-btn-primary:hover { background:#6a5aff; }
    .mfs-icon-btn { display:flex; align-items:center; justify-content:center; width:28px; height:28px; border-radius:var(--radius); background:transparent; border:1px solid transparent; color:var(--text-muted); cursor:pointer; flex-shrink:0; }
    .mfs-icon-btn:hover { background:var(--bg-hover); color:var(--text); }
    .mfs-icon-btn.active { background:var(--accent-soft); color:var(--accent); }
    .mfs-icon-btn:disabled { opacity:0.4; cursor:not-allowed; }

    /* LAYERS (panel paling kiri, menetap) */
    .mfs-layers { grid-area:layers; background:var(--bg-panel); border-right:1px solid var(--border); display:flex; flex-direction:column; min-height:0; }
    .mfs-layers-head { height:40px; flex-shrink:0; display:flex; align-items:center; justify-content:space-between; padding:0 12px; border-bottom:1px solid var(--border); }
    .mfs-layers-bg { border-top:1px solid var(--border); padding:8px; flex-shrink:0; }
    .mfs-popover { position:absolute; top:32px; right:0; background:var(--bg-elevated); border:1px solid var(--border-light); border-radius:var(--radius); box-shadow:0 12px 30px var(--popover-shadow); z-index:20; width:150px; overflow:hidden; padding:4px; }
    .mfs-popover-item { display:flex; align-items:center; gap:8px; padding:7px 9px; font-size:12px; font-weight:500; border-radius:5px; cursor:pointer; }
    .mfs-popover-item:hover { background:var(--bg-hover); }
    .mfs-menu-backdrop { position:fixed; inset:0; z-index:19; }

    .mfs-left { grid-area:left; background:var(--bg-panel); border-right:1px solid var(--border); display:flex; flex-direction:column; min-height:0; }
    .mfs-tabs { display:flex; border-bottom:1px solid var(--border); }
    .mfs-tab { flex:1; padding:9px 0; text-align:center; font-size:10.5px; font-weight:600; color:var(--text-dim); cursor:pointer; border-bottom:2px solid transparent; white-space:nowrap; }
    .mfs-tab.active { color:var(--text); border-bottom-color:var(--accent); }
    /* Sub-tab di dalam panel Preset (Teks vs Gambar & Video) — gaya pill
       kecil, sengaja dibedakan dari tab utama di atasnya (yang bergaya
       underline) supaya jelas ini navigasi tingkat kedua, bukan tab
       utama panel kiri. */
    .mfs-tabs-sub { display:flex; gap:6px; border-bottom:none; background:var(--bg-elevated); border:1px solid var(--border-light); border-radius:999px; padding:3px; margin-bottom:10px; }
    .mfs-tabs-sub .mfs-tab { flex:1; padding:6px 8px; border-radius:999px; border-bottom:none; font-size:10px; }
    .mfs-tabs-sub .mfs-tab.active { color:#fff; background:var(--accent); }
    .mfs-panel-body { flex:1; overflow-y:auto; padding:12px; }
    .mfs-section-label { font-size:11px; font-weight:600; color:var(--text-dim); text-transform:uppercase; letter-spacing:.04em; margin:4px 0 10px; display:flex; align-items:center; justify-content:space-between; }
    .mfs-upload-zone { border:1.5px dashed var(--border-light); border-radius:var(--radius); padding:14px 8px; text-align:center; cursor:pointer; color:var(--text-muted); font-size:11.5px; margin-bottom:10px; }
    .mfs-upload-zone:hover { border-color:var(--accent-dim); color:var(--text); }
    .mfs-font-item, .mfs-clip-item, .mfs-list-item { display:flex; align-items:center; gap:8px; padding:8px; border-radius:var(--radius); cursor:pointer; margin-bottom:3px; border:1px solid transparent; }
    .mfs-font-item:hover, .mfs-clip-item:hover, .mfs-list-item:hover { background:var(--bg-hover); }
    .mfs-clip-item.selected, .mfs-list-item.selected { background:var(--accent-soft); border-color:var(--accent-dim); }
    .mfs-clip-item .name, .mfs-list-item .name { flex:1; font-size:12.5px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .mfs-clip-item .del, .mfs-list-item .del { opacity:0; color:var(--text-dim); }
    .mfs-clip-item:hover .del, .mfs-list-item:hover .del { opacity:1; }
    .mfs-layer-grip { cursor:grab; flex-shrink:0; }
    .mfs-layer-grip:active { cursor:grabbing; }
    .mfs-clip-item.dragging { opacity:0.4; }
    .mfs-layer-drop-line { height:2px; margin:0 8px 3px; border-radius:2px; background:var(--accent); }
    .mfs-empty { color:var(--text-dim); font-size:12px; text-align:center; padding:26px 8px; line-height:1.6; }
    .mfs-type-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
    .mfs-asset-thumb { width:30px; height:30px; border-radius:5px; object-fit:cover; flex-shrink:0; background:var(--bg-elevated); border:1px solid var(--border-light); }
    .mfs-asset-icon { width:30px; height:30px; border-radius:5px; flex-shrink:0; background:var(--bg-elevated); border:1px solid var(--border-light); display:flex; align-items:center; justify-content:center; }
    .mfs-add-btn { width:22px; height:22px; border-radius:5px; background:var(--accent-soft); color:var(--accent); border:none; display:flex; align-items:center; justify-content:center; cursor:pointer; flex-shrink:0; }
    .mfs-add-btn:hover { background:var(--accent-dim); color:#fff; }
    .mfs-subhead { font-size:10.5px; color:var(--text-dim); font-weight:600; margin:14px 0 6px; text-transform:uppercase; letter-spacing:.03em; display:flex; align-items:center; gap:5px; }
    .mfs-subhead:first-child { margin-top:0; }
    .mfs-list-item[draggable="true"] { cursor:grab; }

    .mfs-center { grid-area:center; background:var(--bg); display:flex; flex-direction:column; min-height:0; }
    .mfs-canvas-wrap { flex:1; display:flex; align-items:center; justify-content:center; position:relative; overflow:auto; background-image:radial-gradient(circle,var(--stage-checker) 1px,transparent 1px); background-size:22px 22px; background-position:center; }
    /* Mode preview penuh-layar: keluar dari tata letak grid (position:fixed
       menutupi seluruh viewport). PENTING soal performa: dulu lapisan ini
       memakai backdrop-filter: blur(34px) menutupi SELURUH viewport. Karena
       kanvas di atasnya beranimasi tiap frame, blur latar itu ikut dihitung
       ULANG tiap frame — salah satu efek CSS paling mahal — sehingga preview
       jatuh ke ~20fps (patah-patah) walau penggambaran kanvasnya sendiri
       ringan. Diganti latar gelap PADAT (tanpa backdrop-filter) supaya
       preview mulus 60fps. */
    .mfs-canvas-wrap.is-playing {
      position: fixed; inset: 0; z-index: 500; padding: 32px;
      background: radial-gradient(circle at 50% 40%, #14141a 0%, #050507 80%);
      background-image: radial-gradient(circle at 50% 40%, #14141a 0%, #050507 80%);
      animation: mfs-fade-in .16s ease;
    }
    @keyframes mfs-fade-in { from { opacity:0; } to { opacity:1; } }
    .mfs-canvas-hint { position:absolute; top:12px; left:50%; transform:translateX(-50%); font-size:11px; color:var(--text-dim); background:rgba(17,17,20,0.85); border:1px solid var(--border-light); padding:5px 10px; border-radius:20px; display:flex; align-items:center; gap:6px; pointer-events:none; }
    .mfs-fullscreen-close {
      position:absolute; top:22px; right:22px; width:36px; height:36px; border-radius:50%;
      background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.14); color:#fff;
      display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:2;
    }
    .mfs-fullscreen-close:hover { background:rgba(255,255,255,0.18); }
    .mfs-fullscreen-controls {
      position:absolute; left:50%; bottom:28px; transform:translateX(-50%); z-index:2;
      display:flex; align-items:center; gap:10px; background:rgba(20,20,24,0.7);
      border:1px solid rgba(255,255,255,0.1); padding:8px 16px; border-radius:999px;
      -webkit-backdrop-filter:blur(16px); backdrop-filter:blur(16px);
    }
    .mfs-fullscreen-controls .mfs-icon-btn { background:transparent; color:rgba(255,255,255,0.8); }
    .mfs-fullscreen-controls .mfs-icon-btn:hover { background:rgba(255,255,255,0.14); color:#fff; }
    .mfs-fullscreen-controls .mfs-icon-btn.active { background:rgba(124,108,255,0.35); color:#fff; }
    .mfs-fullscreen-time { font-family:'JetBrains Mono',monospace; font-size:11.5px; color:rgba(255,255,255,0.75); margin-left:2px; white-space:nowrap; }
    /* Selalu diberi stacking context sendiri supaya transport bar edit
       normal tidak pernah tertimbun z-index overlay preview di atas. */
    .mfs-transport { height:46px; border-top:1px solid var(--border); background:var(--bg-panel); display:flex; align-items:center; justify-content:center; gap:12px; position:relative; z-index:501; }
    .mfs-transport-time { position:absolute; right:14px; font-family:'JetBrains Mono',monospace; font-size:11.5px; color:var(--text-muted); }
    .mfs-play-btn { width:32px; height:32px; border-radius:50%; background:var(--accent); border:none; color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; }
    .mfs-play-btn:hover { background:#6a5aff; }
    .mfs-play-btn:disabled { opacity:0.5; cursor:not-allowed; }
    .mfs-spin { animation:mfs-spin 1s linear infinite; }
    @keyframes mfs-spin { to { transform:rotate(360deg); } }

    .mfs-right { grid-area:right; background:var(--bg-panel); border-left:1px solid var(--border); overflow-y:auto; padding:14px; }
    .mfs-field { margin-bottom:14px; }
    .mfs-field label { display:block; font-size:11px; color:var(--text-dim); margin-bottom:5px; font-weight:500; text-transform:uppercase; letter-spacing:.03em; }
    .mfs-input, .mfs-select, textarea.mfs-input { width:100%; background:var(--bg-elevated); border:1px solid var(--border-light); color:var(--text); padding:7px 9px; border-radius:var(--radius); font-size:12.5px; font-family:inherit; }
    .mfs-input:focus, .mfs-select:focus, textarea:focus { outline:none; border-color:var(--accent-dim); }
    textarea.mfs-input { resize:vertical; min-height:52px; line-height:1.4; }
    .mfs-row2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .mfs-row3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
    .mfs-row4 { display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:8px; }
    .mfs-color-swatch { width:28px; height:28px; border-radius:6px; border:1px solid var(--border-light); cursor:pointer; padding:0; background:none; }
    .mfs-color-picker-wrap { position:relative; width:100%; }
    .mfs-color-picker { position:relative; display:flex; align-items:center; gap:9px; width:100%; background:var(--bg-elevated); border:1px solid var(--border-light); border-radius:var(--radius); padding:6px 10px; cursor:pointer; transition:border-color .12s ease, background .12s ease; font:inherit; color:inherit; text-align:left; }
    .mfs-color-picker:hover { background:var(--bg-hover); }
    .mfs-color-picker:focus-visible { outline:none; border-color:var(--accent-dim); }
    .mfs-color-picker-swatch { width:22px; height:22px; border-radius:50%; flex-shrink:0; border:2px solid var(--bg-panel); box-shadow:0 0 0 1px var(--border-light); }
    .mfs-color-picker-swatch.large { width:32px; height:32px; }
    .mfs-color-picker-hex { font-family:'JetBrains Mono',monospace; font-size:12px; letter-spacing:.02em; color:var(--text-muted); text-transform:uppercase; }
    .mfs-color-popover { top:calc(100% + 8px); left:0; right:auto; width:100%; min-width:220px; padding:14px; display:flex; flex-direction:column; gap:13px; }
    .mfs-color-preview-row { display:flex; align-items:center; gap:10px; }
    .mfs-color-hex-input { flex:1; font-family:'JetBrains Mono',monospace; letter-spacing:.03em; text-transform:uppercase; }
    .mfs-color-slider-row label { display:block; font-size:10px; color:var(--text-dim); font-weight:600; text-transform:uppercase; letter-spacing:.03em; margin-bottom:6px; }
    input.mfs-rgb-slider::-webkit-slider-thumb { box-shadow:0 1px 4px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08); }
    input.mfs-rgb-slider-r::-webkit-slider-thumb, input.mfs-rgb-slider-r::-moz-range-thumb { background:#ff5c72; }
    input.mfs-rgb-slider-g::-webkit-slider-thumb, input.mfs-rgb-slider-g::-moz-range-thumb { background:#3ee08a; }
    input.mfs-rgb-slider-b::-webkit-slider-thumb, input.mfs-rgb-slider-b::-moz-range-thumb { background:#4f9dff; }
    /* Picker warna HSV/HSB gaya Photoshop/Figma: kotak Saturation/Value +
       slider Hue di bawahnya, minimalis-modern menyesuaikan tema aplikasi. */
    .mfs-color-popover-hsv { width:220px; }
    .mfs-sv-square { position:relative; width:100%; height:148px; border-radius:8px; border:1px solid var(--border-light); cursor:crosshair; touch-action:none; overflow:hidden; box-shadow:inset 0 0 0 1px rgba(0,0,0,0.15); }
    .mfs-sv-thumb { position:absolute; width:14px; height:14px; margin:-7px 0 0 -7px; border-radius:50%; border:2px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.55), 0 1px 4px rgba(0,0,0,0.5); pointer-events:none; }
    input.mfs-hue-slider { margin-top:2px; background:linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000); }
    input.mfs-hue-slider::-webkit-slider-thumb { background:#fff; border:2px solid rgba(0,0,0,0.35); box-shadow:0 1px 4px rgba(0,0,0,0.5); }
    input.mfs-hue-slider::-moz-range-thumb { background:#fff; border:2px solid rgba(0,0,0,0.35); }
    .mfs-segmented { display:flex; background:var(--bg-elevated); border:1px solid var(--border-light); border-radius:var(--radius); overflow:hidden; }
    .mfs-segmented button { flex:1; padding:6px 0; background:transparent; border:none; color:var(--text-muted); font-size:11px; font-weight:500; cursor:pointer; }
    .mfs-segmented button.active { background:var(--accent-soft); color:var(--accent); }
    .mfs-segmented button:not(:last-child) { border-right:1px solid var(--border-light); }
    .mfs-divider { height:1px; background:var(--border); margin:14px 0; }
    .mfs-chip { display:inline-flex; align-items:center; gap:6px; padding:5px 10px; border-radius:20px; background:var(--bg-elevated); border:1px solid var(--border-light); font-size:11.5px; color:var(--text-muted); }
    .mfs-media-preview { width:100%; aspect-ratio:16/9; border-radius:var(--radius); background:var(--bg-elevated); border:1px solid var(--border-light); display:flex; align-items:center; justify-content:center; overflow:hidden; margin-bottom:12px; }
    .mfs-media-preview img, .mfs-media-preview video { width:100%; height:100%; object-fit:contain; }
    .mfs-bg-preview { width:100%; height:64px; border-radius:var(--radius); border:1px solid var(--border-light); margin-bottom:12px; overflow:hidden; background-size:cover; background-position:center; }

    .mfs-slider-val { float:right; color:var(--text-muted); font-weight:600; text-transform:none; letter-spacing:0; }
    input.mfs-slider { -webkit-appearance:none; appearance:none; width:100%; height:4px; border-radius:3px; background:var(--border-light); outline:none; cursor:pointer; margin-top:4px; accent-color:var(--accent); }
    input.mfs-slider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:14px; height:14px; border-radius:50%; background:var(--accent); border:2px solid #fff1; cursor:pointer; box-shadow:0 1px 4px rgba(0,0,0,0.4); transition:transform .1s; }
    input.mfs-slider::-webkit-slider-thumb:hover { transform:scale(1.15); }
    input.mfs-slider::-moz-range-thumb { width:14px; height:14px; border-radius:50%; background:var(--accent); border:2px solid #fff1; cursor:pointer; }
    input.mfs-slider::-moz-range-track { height:4px; border-radius:3px; background:var(--border-light); }

    .mfs-frame-ctrl { position:relative; display:flex; align-items:center; gap:6px; }
    .mfs-frame-trigger { white-space:nowrap; }
    .mfs-frame-select { width:auto; max-width:230px; padding:5px 8px; font-size:11.5px; }
    .mfs-frame-num { width:60px; padding:5px 6px; font-size:11.5px; text-align:center; }
    .mfs-frame-dims { font-size:10.5px; color:var(--text-dim); font-family:'JetBrains Mono',monospace; white-space:nowrap; }
    .mfs-frame-popover { left:0; right:auto; top:32px; width:250px; max-height:340px; overflow-y:auto; }
    .mfs-frame-option .name { flex:1; font-size:12px; font-weight:500; }
    .mfs-frame-option .mfs-frame-dims { flex-shrink:0; }
    .mfs-frame-custom-row { display:flex; align-items:center; gap:6px; padding:8px 6px 4px; border-top:1px solid var(--border-light); margin-top:6px; }
    .mfs-popover-item.selected { background:var(--accent-soft); color:var(--accent); }
    .mfs-popover-item.mfs-popover-danger { color:#ff8a8a; }
    .mfs-popover-item.mfs-popover-danger:hover { background:#3a1a1e; }
    .mfs-transition-popover { top:22px; left:-96px; right:auto; width:200px; max-height:280px; overflow-y:auto; }
    .mfs-zoom-badge { font-size:10.5px; color:var(--text-muted); font-family:'JetBrains Mono',monospace; min-width:38px; text-align:center; user-select:none; }

    .mfs-timeline { grid-area:timeline; background:var(--bg-panel); border-top:1px solid var(--border); display:flex; flex-direction:column; min-height:0; }
    .mfs-timeline-head { height:32px; flex-shrink:0; display:flex; align-items:center; justify-content:space-between; padding:0 14px; border-bottom:1px solid var(--border); }
    .mfs-timeline-title { font-size:11px; color:var(--text-dim); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
    .mfs-tracks-outer { flex:1; display:flex; min-height:0; padding:0 14px; }
    .mfs-track-labels { width:60px; flex-shrink:0; display:flex; flex-direction:column; }
    .mfs-track-labels .mfs-ruler-spacer { height:20px; display:flex; align-items:center; justify-content:center; }
    .mfs-track-label { height:38px; display:flex; align-items:center; gap:5px; font-size:10px; color:var(--text-muted); font-weight:600; position:relative; }
    .mfs-track-label .dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
    .mfs-track-label .label-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
    .mfs-track-label .mfs-track-del { opacity:0; width:14px; height:14px; flex-shrink:0; border:none; background:transparent; color:var(--text-dim); cursor:pointer; display:flex; align-items:center; justify-content:center; }
    .mfs-track-label:hover .mfs-track-del { opacity:1; }
    .mfs-add-track-btn { width:20px; height:20px; border-radius:5px; border:1px dashed var(--border-light); background:transparent; color:var(--text-dim); display:flex; align-items:center; justify-content:center; cursor:pointer; }
    .mfs-add-track-btn:hover { color:var(--accent); border-color:var(--accent-dim); background:var(--accent-soft); }
    .mfs-track-ghost { height:0; overflow:hidden; border-radius:6px; border:1.5px dashed transparent; transition:height .12s ease, border-color .12s ease, background .12s ease; }
    .mfs-track-ghost.showing { height:26px; margin:2px 0; border-color:var(--border-light); }
    .mfs-track-ghost.over { border-color:var(--accent); background:var(--accent-soft); }
    .mfs-track-ghost-label { font-size:9.5px; color:var(--text-dim); display:flex; align-items:center; justify-content:center; height:100%; pointer-events:none; }
    .mfs-tracks-scroll { flex:1; position:relative; min-width:0; }
    .mfs-ruler { height:20px; border-bottom:1px solid var(--border-light); position:relative; cursor:pointer; }
    .mfs-ruler-tick { position:absolute; top:0; height:100%; display:flex; align-items:center; font-size:9.5px; color:var(--text-dim); font-family:'JetBrains Mono',monospace; border-left:1px solid var(--border-light); padding-left:3px; }
    .mfs-lane { position:relative; height:38px; border-bottom:1px solid var(--border); transition:height .12s ease, background .12s ease; }
    .mfs-lane.track-over { background:var(--accent-soft); }
    .mfs-clip-block { position:absolute; top:3px; bottom:3px; border-radius:7px; cursor:grab; overflow:hidden; min-width:22px; border:1px solid; }
    .mfs-clip-block.selected { box-shadow:0 0 0 2px var(--accent-dim); border-color:var(--accent); z-index:5; }
    .mfs-clip-body { padding:0 8px; display:flex; align-items:center; height:100%; pointer-events:none; }
    .mfs-clip-name { font-size:11px; font-weight:600; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .mfs-clip-handle { position:absolute; top:0; bottom:0; width:8px; cursor:ew-resize; z-index:2; }
    .mfs-clip-handle.left { left:0; } .mfs-clip-handle.right { right:0; }
    .mfs-clip-del { position:absolute; top:3px; right:3px; width:15px; height:15px; border-radius:4px; background:rgba(0,0,0,0.55); border:none; color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:3; }
    .mfs-playhead { position:absolute; top:0; bottom:0; width:1px; background:var(--accent); z-index:6; pointer-events:none; }
    .mfs-playhead-flag { position:absolute; top:-1px; left:-5px; width:11px; height:11px; background:var(--accent); border-radius:2px 2px 2px 0; transform:rotate(45deg); }

    /* Transisi hidup di STRIP TERSENDIRI di bagian bawah tiap lane — bukan
       lagi di atas/menimpa bar klip. Karena punya ruang sendiri, ia tidak
       pernah menutupi atau menghalangi drag/resize klip di atasnya. Kalau
       belum ada transisi terpasang di sela itu, bar ini transparan total
       (tidak tampil) — hanya "hidup" (terlihat) saat memang ada transisi
       aktif, atau sedang di-hover/di-drag-over untuk memasang satu. */
    .mfs-transition-bar { position:absolute; bottom:1px; width:18px; height:11px; margin-left:-9px; border-radius:4px; z-index:2;
      display:flex; align-items:center; justify-content:center; cursor:grab; border:1px solid transparent;
      background:transparent; opacity:0; pointer-events:auto;
      transition:opacity .15s ease, transform .15s ease, width .15s ease, background .15s ease, border-color .15s ease; }
    .mfs-transition-bar > svg { flex-shrink:0; width:9px; height:9px; }
    .mfs-transition-bar:hover { opacity:0.7; border-color:#ff8fc466; background:linear-gradient(180deg, #ff5fa233, #ff5fa211); }
    .mfs-transition-bar.active { opacity:1; border-color:#ff8fc4; background:linear-gradient(180deg, #ff5fa2aa, #ff5fa255); }
    .mfs-transition-bar.over { opacity:1; width:26px; margin-left:-13px; transform:scale(1.05); border-color:#ffb3d9; background:linear-gradient(180deg, #ff5fa2cc, #ff5fa266); }
    .mfs-toast-stack { position:fixed; top:14px; right:14px; z-index:999; display:flex; flex-direction:column; gap:8px; max-width:320px; }
    .mfs-toast { display:flex; align-items:flex-start; gap:8px; background:#2a1418; border:1px solid #6a2530; color:#ffd7dc; font-size:11.5px; line-height:1.5;
      padding:10px 12px; border-radius:8px; cursor:pointer; box-shadow:0 4px 16px rgba(0,0,0,0.4); }

    /* ===== RESPONSIF ===== */
    /* Navigasi bawah khusus HP/tablet kecil — disembunyikan di desktop. */
    .mfs-mobile-nav, .mfs-mobile-backdrop { display:none; }

    /* Tablet: ciutkan lebar panel samping supaya kanvas tetap lega. */
    @media (max-width: 1200px) and (min-width: 861px) {
      .mfs-root { grid-template-columns: 168px 216px 1fr 284px; }
    }

    /* HP & tablet kecil (≤860px): satu kolom. Panel Layer/Kreasi/Atur jadi
       "bottom sheet" yang muncul saat tab di bilah bawah ditekan, jadi kanvas
       tetap besar & semua kontrol tetap terjangkau dengan satu tangan. */
    @media (max-width: 860px) {
      .mfs-root { display:flex; flex-direction:column; height:100dvh; }
      .mfs-top { height:auto; min-height:48px; flex-wrap:wrap; row-gap:6px; padding:6px 10px; }
      .mfs-top-left, .mfs-top-right { gap:6px; flex-wrap:wrap; }
      .mfs-top-info { display:none; }
      .mfs-center { flex:1 1 auto; min-height:0; }
      .mfs-timeline { height:150px; flex:0 0 150px; margin-bottom:56px; }

      .mfs-layers, .mfs-left, .mfs-right {
        position:fixed; left:0; right:0; bottom:56px; top:auto;
        height:62dvh; max-height:62dvh; z-index:640;
        border:1px solid var(--border); border-bottom:none; border-radius:16px 16px 0 0;
        box-shadow:0 -12px 40px rgba(0,0,0,0.55);
        transform:translateY(112%); transition:transform .24s ease; will-change:transform;
      }
      .mfs-layers, .mfs-left { overflow:hidden; }
      .mfs-right { overflow-y:auto; -webkit-overflow-scrolling:touch; }
      .mfs-root[data-mpane="layers"] .mfs-layers { transform:none; }
      .mfs-root[data-mpane="left"]   .mfs-left   { transform:none; }
      .mfs-root[data-mpane="right"]  .mfs-right  { transform:none; }

      .mfs-mobile-backdrop { display:block; position:fixed; inset:0 0 56px 0; z-index:630; background:rgba(0,0,0,0.45); animation:mfs-fade-in .16s ease; }

      .mfs-mobile-nav {
        display:flex; position:fixed; left:0; right:0; bottom:0; height:56px; z-index:660;
        background:var(--bg-panel); border-top:1px solid var(--border); align-items:stretch; justify-content:space-around;
        padding-bottom:env(safe-area-inset-bottom,0);
      }
      .mfs-mobile-nav button {
        flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px;
        background:transparent; border:none; color:var(--text-dim); font-size:10.5px; font-weight:500; cursor:pointer;
      }
      .mfs-mobile-nav button.active { color:var(--accent); background:var(--accent-soft); }

      /* Sedikit rapikan kontrol agar pas di layar sempit. */
      .mfs-preview-btn, .mfs-export-btn { padding:0 10px; font-size:11.5px; }
      .mfs-frame-dims { font-size:10.5px; }
    }
  `}</style>
);

/* ============================================================
   LAYERS PANEL — kolom paling kiri, menetap seperti panel layer
   ============================================================ */

// Baris layer tunggal, di-memo. KUNCI performa "banyak layer tersendat":
// reducer proyek memakai pola immutable yang MEMPERTAHANKAN referensi objek
// klip yang TIDAK berubah (lihat UPDATE_CLIP → hanya klip yang diedit yang
// jadi objek baru). Karena itu, dengan React.memo di sini, mengedit/memilih
// SATU klip hanya me-render ulang barisnya sendiri — bukan seluruh 50+ baris
// tiap ketukan keyboard seperti sebelumnya.
const LayerRow = React.memo(function LayerRow({ clip, selected, isDragging, showDropLine, dispatch, onGripDown, registerRef }) {
  const color = trackColor(clip.type);
  const Icon = TRACK_TYPES.find((t) => t.type === clip.type)?.icon || Type;
  return (
    <React.Fragment>
      {showDropLine && <div className="mfs-layer-drop-line" />}
      <div
        ref={(el) => registerRef(clip.id, el)}
        className={`mfs-clip-item ${selected ? "selected" : ""} ${isDragging ? "dragging" : ""}`}
        onClick={() => dispatch({ type: "SELECT_CLIP", id: clip.id })}
      >
        <GripVertical size={13} color="var(--text-dim)" className="mfs-layer-grip" onMouseDown={(e) => onGripDown(e, clip.id)} />
        <span className="mfs-type-dot" style={{ background: color }} />
        <Icon size={13} color={selected ? "var(--accent)" : "var(--text-dim)"} />
        <span className="name">{clip.type === "text" ? (clip.text.split("\n")[0] || clip.name) : clip.name}</span>
        <Trash2 size={13} className="del" onClick={(e) => { e.stopPropagation(); dispatch({ type: "DELETE_CLIP", id: clip.id }); }} />
      </div>
    </React.Fragment>
  );
});

const LayersPanel = React.memo(function LayersPanel({ project, dispatch }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const imgRef = useRef(null), vidRef = useRef(null), audRef = useRef(null);
  const itemRefs = useRef({});
  const [dragClipId, setDragClipId] = useState(null);
  // undefined = tidak sedang drag; string clipId = taruh SEBELUM layer itu;
  // null = taruh paling bawah (jadi layer paling belakang/dasar).
  const [dropBeforeId, setDropBeforeId] = useState(undefined);

  // Seret gagang (grip) sebuah layer untuk mengubah urutan tumpukannya.
  // Urutan di panel ini = urutan render: layer paling ATAS = paling DEPAN.
  // Callback stabil untuk baris layer yang di-memo: identitasnya tidak
  // berubah antar-render supaya React.memo pada <LayerRow> tetap efektif.
  const registerRef = useCallback((id, el) => {
    if (el) itemRefs.current[id] = el; else delete itemRefs.current[id];
  }, []);
  const startLayerDragRef = useRef(() => {});
  const onGripDown = useCallback((e, id) => startLayerDragRef.current(e, id), []);

  const startLayerDrag = (e, clipId) => {
    e.stopPropagation();
    e.preventDefault();
    const startY = e.clientY;
    const DRAG_THRESHOLD = 4;
    let hasStartedDrag = false;
    let lastBeforeId = null;

    const computeDropTarget = (clientY) => {
      for (const c of project.clips) {
        if (c.id === clipId) continue;
        const el = itemRefs.current[c.id];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (clientY < r.top + r.height / 2) return c.id;
      }
      return null;
    };

    const move = (ev) => {
      if (!hasStartedDrag) {
        if (Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
        hasStartedDrag = true;
        setDragClipId(clipId);
      }
      lastBeforeId = computeDropTarget(ev.clientY);
      setDropBeforeId(lastBeforeId);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (hasStartedDrag) {
        dispatch({ type: "REORDER_CLIP", clipId, beforeId: lastBeforeId });
      }
      setDragClipId(null);
      setDropBeforeId(undefined);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  startLayerDragRef.current = startLayerDrag;

  const pickFile = (kind) => {
    setMenuOpen(false);
    if (kind === "text") { dispatch({ type: "ADD_CLIP" }); return; }
    const ref = kind === "image" ? imgRef : kind === "video" ? vidRef : audRef;
    ref.current?.click();
  };
  const handleFile = async (e, kind) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size === 0) { reportError(`File "${file.name}" kosong (0 byte), tidak bisa diimpor.`); return; }
    if (file.size > 150 * 1024 * 1024) {
      reportError(`File "${file.name}" berukuran ${(file.size / (1024 * 1024)).toFixed(1)}MB — file sebesar ini mungkin lambat diimpor atau membuat tab browser berat.`);
    }
    if (kind === "video") {
      const warn = checkVideoPlayability(file);
      if (warn) reportError(warn);
    } else if (kind === "audio") {
      const warn = checkAudioPlayability(file);
      if (warn) reportError(warn);
    }
    try {
      let imgData;
      if (kind === "image") {
        imgData = await readImageAsset(file);
      } else {
        // Video & audio: utamakan blob: URL (ringan untuk file besar) sambil
        // menyimpan File aslinya. Kalau blob: diblokir CSP (mis. di sandbox
        // preview Artifact), elemen media otomatis fallback ke data URL.
        imgData = { src: URL.createObjectURL(file), file };
      }
      const asset = { id: uid("asset"), name: file.name, kind, ...imgData };
      dispatch({ type: "ADD_LIBRARY_ASSET", kind, asset });
      dispatch({ type: "ADD_MEDIA_CLIP", kind, asset });
    } catch (err) {
      reportError(`Gagal mengimpor "${file.name}": ${err.message || err}`);
    }
  };

  const bgSelected = project.selectedClipId === BG_SEL;

  return (
    <div className="mfs-layers">
      <div className="mfs-layers-head">
        <span className="mfs-timeline-title">Layer</span>
        <div style={{ position: "relative" }}>
          <button className="mfs-icon-btn" onClick={() => setMenuOpen((v) => !v)} title="Tambah layer"><Plus size={15} /></button>
          {menuOpen && (
            <>
              <div className="mfs-menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="mfs-popover">
                <div className="mfs-popover-item" onClick={() => pickFile("text")}><Type size={13} /> Teks</div>
                <div className="mfs-popover-item" onClick={() => pickFile("image")}><ImageIcon size={13} /> Gambar</div>
                <div className="mfs-popover-item" onClick={() => pickFile("video")}><Film size={13} /> Video</div>
                <div className="mfs-popover-item" onClick={() => pickFile("audio")}><Music size={13} /> Audio</div>
              </div>
            </>
          )}
          <input ref={imgRef} type="file" hidden accept="image/*,.svg" onChange={(e) => handleFile(e, "image")} />
          <input ref={vidRef} type="file" hidden accept="video/*" onChange={(e) => handleFile(e, "video")} />
          <input ref={audRef} type="file" hidden accept="audio/*" onChange={(e) => handleFile(e, "audio")} />
        </div>
      </div>
      <div className="mfs-panel-body" style={{ padding: 8 }}>
        {project.clips.length === 0 && <div className="mfs-empty">Belum ada layer.<br />Klik + untuk menambah teks, gambar, video, atau audio.</div>}
        {project.clips.map((c) => {
          return (
            <LayerRow
              key={c.id}
              clip={c}
              selected={c.id === project.selectedClipId}
              isDragging={dragClipId === c.id}
              showDropLine={!!dragClipId && dropBeforeId === c.id}
              dispatch={dispatch}
              onGripDown={onGripDown}
              registerRef={registerRef}
            />
          );
        })}
        {dragClipId && dropBeforeId === null && <div className="mfs-layer-drop-line" />}
      </div>
      <div className="mfs-layers-bg">
        <div className={`mfs-clip-item ${bgSelected ? "selected" : ""}`} style={{ margin: 0 }} onClick={() => dispatch({ type: "SELECT_CLIP", id: BG_SEL })}>
          <Palette size={13} color={bgSelected ? "var(--accent)" : "var(--text-dim)"} />
          <span className="name">Background</span>
        </div>
      </div>
    </div>
  );
});

/* ============================================================
   LEFT PANEL — Preset / Transisi / Library / Font
   ============================================================ */

function PresetPanel({ selectedClip, dispatch }) {
  const isMediaType = (t) => t === "image" || t === "video";
  const [tab, setTab] = useState(selectedClip?.type === "text" ? "text" : "media");
  // Ikut pindah tab otomatis saat pilihan klip berganti jenis, supaya
  // panel selalu menampilkan daftar yang relevan dengan klip aktif —
  // tapi pengguna tetap bebas pindah tab manual untuk sekadar melihat-
  // lihat preset di kategori lain.
  useEffect(() => {
    if (selectedClip?.type === "text") setTab("text");
    else if (isMediaType(selectedClip?.type)) setTab("media");
  }, [selectedClip?.id, selectedClip?.type]);

  if (!selectedClip || (!isMediaType(selectedClip.type) && selectedClip.type !== "text")) {
    return <div className="mfs-panel-body"><div className="mfs-empty">Pilih klip teks, gambar, atau video di panel Layer untuk menerapkan preset animasi.</div></div>;
  }

  const applicable = tab === "text" ? selectedClip.type === "text" : isMediaType(selectedClip.type);
  // Tab "Teks" memakai preset teks; tab "Gambar & Video" memakai preset khusus
  // gambar (gerak satu objek utuh) — bukan lagi daftar yang sama dengan teks.
  const list = tab === "text" ? PRESET_LIB : IMAGE_PRESET_LIB;

  return (
    <div className="mfs-panel-body">
      <div className="mfs-tabs mfs-tabs-sub">
        <div className={`mfs-tab ${tab === "text" ? "active" : ""}`} onClick={() => setTab("text")}>Teks ({PRESET_LIB.length})</div>
        <div className={`mfs-tab ${tab === "media" ? "active" : ""}`} onClick={() => setTab("media")}>Gambar & Video ({IMAGE_PRESET_LIB.length})</div>
      </div>
      {!applicable && (
        <div className="mfs-empty" style={{ margin: "10px 0" }}>
          Klip yang sedang dipilih ({selectedClip.type === "text" ? "teks" : selectedClip.type}) bukan jenis ini — memilih preset di bawah akan tetap diterapkan ke klip yang sedang dipilih itu.
        </div>
      )}
      <div className="mfs-section-label">Preset Animasi</div>
      {list.map((p) => {
        const Icon = p.icon || Sparkles;
        const selected = selectedClip.presetId === p.id;
        return (
          <div key={p.id} className={`mfs-list-item ${selected ? "selected" : ""}`} onClick={() => dispatch({ type: "APPLY_PRESET", id: selectedClip.id, presetId: p.id })}>
            <Icon size={13} color={selected ? "var(--accent)" : "var(--text-dim)"} />
            <span className="name">{p.name}</span>
          </div>
        );
      })}
    </div>
  );
}

function TransitionPanel({ selectedClip, dispatch }) {
  return (
    <div className="mfs-panel-body">
      <div className="mfs-section-label">Transisi ({TRANSITION_LIB.length})</div>
      <div style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.5, marginBottom: 10 }}>
        Seret transisi langsung ke bar pink di sela-sela klip pada linimasa bawah, atau klik untuk menerapkannya ke klip yang sedang dipilih.
      </div>
      {TRANSITION_LIB.map((t) => (
        <div
          key={t.id}
          draggable
          onDragStart={(e) => { e.dataTransfer.setData("text/transition-id", t.id); e.dataTransfer.effectAllowed = "copy"; }}
          className={`mfs-list-item ${selectedClip && (selectedClip.transitionInId === t.id || selectedClip.transitionOutId === t.id) ? "selected" : ""}`}
          onClick={() => selectedClip && dispatch({ type: "APPLY_TRANSITION_BOTH", id: selectedClip.id, transitionId: t.id })}
        >
          <Wand size={13} color="var(--text-dim)" />
          <span className="name">{t.name}</span>
        </div>
      ))}
    </div>
  );
}

function LibraryPanel({ library, dispatch }) {
  const imgRef = useRef(null), vidRef = useRef(null), audRef = useRef(null);

  const handleUpload = (files, kind) => {
    Array.from(files).forEach(async (file) => {
      if (file.size === 0) { reportError(`File "${file.name}" kosong (0 byte), tidak bisa diimpor.`); return; }
      if (file.size > 150 * 1024 * 1024) {
        reportError(`File "${file.name}" berukuran ${(file.size / (1024 * 1024)).toFixed(1)}MB — file sebesar ini mungkin lambat diimpor atau membuat tab browser berat.`);
      }
      if (kind === "video") {
        const warn = checkVideoPlayability(file);
        if (warn) reportError(warn);
      } else if (kind === "audio") {
        const warn = checkAudioPlayability(file);
        if (warn) reportError(warn);
      }
      try {
        const imgData = kind === "image" ? await readImageAsset(file) : { src: URL.createObjectURL(file), file };
        const asset = { id: uid("asset"), name: file.name, kind, ...imgData };
        dispatch({ type: "ADD_LIBRARY_ASSET", kind, asset });
      } catch (err) {
        reportError(`Gagal mengimpor "${file.name}": ${err.message || err}`);
      }
    });
  };

  const Section = ({ kind, label, accept, icon: Icon, assets, inputRef, hint }) => (
    <div>
      <div className="mfs-subhead"><Icon size={12} />{label}</div>
      <div className="mfs-upload-zone" onClick={() => inputRef.current?.click()}>
        <Upload size={14} style={{ marginBottom: 4 }} />
        <div>Seret {hint}</div>
        <div style={{ fontSize: 10, marginTop: 2, color: "var(--text-dim)" }}>atau klik untuk memilih</div>
        <input ref={inputRef} type="file" multiple hidden accept={accept} onChange={(e) => e.target.files.length && handleUpload(e.target.files, kind)} />
      </div>
      {assets.length === 0 && <div className="mfs-empty" style={{ padding: "8px 4px 16px" }}>Belum ada {label.toLowerCase()} diunggah.</div>}
      {assets.map((a) => (
        <div key={a.id} className="mfs-list-item">
          {kind === "image"
            ? <img className="mfs-asset-thumb" src={a.src} alt="" />
            : <div className="mfs-asset-icon"><Icon size={14} color={trackColor(kind)} /></div>}
          <span className="name">{a.name}</span>
          <button className="mfs-add-btn" title="Tambah ke frame" onClick={() => dispatch({ type: "ADD_MEDIA_CLIP", kind, asset: a })}><Plus size={13} /></button>
          <Trash2 size={13} className="del" onClick={() => dispatch({ type: "DELETE_LIBRARY_ASSET", kind, id: a.id })} />
        </div>
      ))}
    </div>
  );

  return (
    <div className="mfs-panel-body">
      <Section kind="image" label="Gambar" accept="image/*,.svg" icon={ImageIcon} assets={library.images} inputRef={imgRef} hint=".svg / .png / .jpg" />
      <Section kind="video" label="Video" accept="video/*" icon={Film} assets={library.videos} inputRef={vidRef} hint="file video" />
      <Section kind="audio" label="Audio" accept="audio/*" icon={Music} assets={library.audios} inputRef={audRef} hint="file audio" />
    </div>
  );
}

function FontsPanel({ fonts, selectedClip, dispatch }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const handleFiles = async (files) => {
    setBusy(true);
    for (const file of Array.from(files)) {
      try {
        const family = `CustomFont-${uid("f")}`;
        const buf = await file.arrayBuffer();
        const face = new FontFace(family, buf);
        await face.load();
        document.fonts.add(face);
        // Simpan juga buffer font mentah supaya font bisa didaftarkan ulang
        // (FontFace) saat proyek dimuat kembali di kunjungan berikutnya.
        dispatch({ type: "ADD_FONT", font: { family, name: file.name.replace(/\.(otf|ttf|woff2?)$/i, ""), buffer: buf } });
      } catch (e) { reportError(`Gagal memuat font "${file.name}": ${e.message || e}`); }
    }
    setBusy(false);
  };
  const isText = selectedClip && selectedClip.type === "text";
  return (
    <div className="mfs-panel-body">
      <div className="mfs-section-label">Unggah Font</div>
      <div className="mfs-upload-zone" onClick={() => fileRef.current?.click()}>
        <Upload size={16} style={{ marginBottom: 6 }} />
        <div>{busy ? "Memuat…" : "Seret .otf / .ttf / .woff2"}</div>
        <div style={{ fontSize: 10.5, marginTop: 2, color: "var(--text-dim)" }}>atau klik untuk memilih</div>
        <input ref={fileRef} type="file" multiple hidden accept=".otf,.ttf,.woff2,.woff" onChange={(e) => e.target.files.length && handleFiles(e.target.files)} />
      </div>
      <div className="mfs-section-label">Pustaka Font</div>
      <div className="mfs-font-item" style={{ fontFamily: "Inter", opacity: isText ? 1 : 0.5 }} onClick={() => isText && dispatch({ type: "UPDATE_CLIP", id: selectedClip.id, patch: { fontFamily: "Inter, sans-serif" } })}>
        <Type size={13} color="var(--text-dim)" /><span className="name">Inter (sistem)</span>
      </div>
      {!isText && <div className="mfs-empty">Pilih klip teks untuk menerapkan font.</div>}
      {fonts.map((f) => (
        <div key={f.family} className="mfs-font-item" style={{ fontFamily: f.family, opacity: isText ? 1 : 0.5 }} onClick={() => isText && dispatch({ type: "UPDATE_CLIP", id: selectedClip.id, patch: { fontFamily: f.family } })}>
          <Type size={13} color="var(--text-dim)" /><span className="name">{f.name}</span>
        </div>
      ))}
    </div>
  );
}

const LEFT_TABS = [
  { id: "preset", label: "Preset" },
  { id: "transisi", label: "Transisi" },
  { id: "library", label: "Library" },
];

const LeftPanel = React.memo(function LeftPanel({ project, dispatch }) {
  const [tab, setTab] = useState("preset");
  const selectedClip = project.clips.find((c) => c.id === project.selectedClipId);
  return (
    <div className="mfs-left">
      <div className="mfs-tabs">
        {LEFT_TABS.map((t) => (
          <div key={t.id} className={`mfs-tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</div>
        ))}
      </div>
      {tab === "preset" && <PresetPanel selectedClip={selectedClip} dispatch={dispatch} />}
      {tab === "transisi" && <TransitionPanel selectedClip={selectedClip} dispatch={dispatch} />}
      {tab === "library" && <LibraryPanel library={project.library} dispatch={dispatch} />}
    </div>
  );
});

/* ============================================================
   CENTER STAGE
   ============================================================ */

const CenterStage = React.forwardRef(function CenterStage({ project, playback, dispatchProject, dispatchPlayback, exportState, setExportState, playClock }, ref) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const ctxRef = useRef(null);
  const offCanvasRef = useRef(null);
  const offCtxRef = useRef(null);
  // Kanvas kecil terpisah, dipakai bersama oleh drawTextClip & drawMediaVisual
  // sebagai "tempat kerja" blur beresolusi rendah (lihat komentar di kedua
  // fungsi itu) — ini kunci perbaikan stutter saat memutar preset ber-blur.
  const blurCanvasRef = useRef(null);
  const blurCtxRef = useRef(null);
  const dimsRef = useRef({ w: 0, h: 0 });
  const bboxRef = useRef(null);
  const dragRef = useRef(null);
  const bgImgRef = useRef(null);
  const exporting = exportState.exporting;
  const exportProgress = exportState.progress;
  const setExporting = useCallback((v) => setExportState((s) => ({ ...s, exporting: v })), [setExportState]);
  const setExportProgress = useCallback((v) => setExportState((s) => ({ ...s, progress: v })), [setExportState]);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  const frameRef = useRef(project.frameSize);
  useEffect(() => { frameRef.current = project.frameSize; }, [project.frameSize]);

  const redrawRef = useRef(() => {});
  const notifyReady = useCallback(() => { redrawRef.current(); }, []);
  // Begitu durasi asli sebuah file video terdeteksi, sinkronkan klipnya di
  // linimasa (dibatasi ke rentang yang masuk akal untuk slider durasi klip)
  // supaya klip video yang diimpor langsung punya panjang yang benar.
  const onVideoDuration = useCallback((clipId, durationMs) => {
    dispatchProject({ type: "UPDATE_CLIP", id: clipId, patch: { duration: clamp(durationMs, 300, 30000) } });
  }, [dispatchProject]);
  const mediaMapRef = useMediaElements(project.clips, notifyReady, onVideoDuration);

  const clipsRef = useRef(project.clips);
  useEffect(() => { clipsRef.current = project.clips; }, [project.clips]);

  const bgRef = useRef(project.background);
  useEffect(() => { bgRef.current = project.background; }, [project.background]);
  useEffect(() => {
    if (project.background.type === "image" && project.background.imageSrc) {
      const img = new Image();
      img.src = project.background.imageSrc;
      bgImgRef.current = img;
    }
  }, [project.background.type, project.background.imageSrc]);

  const selectedClip = project.selectedClipId === BG_SEL ? null : project.clips.find((c) => c.id === project.selectedClipId) || null;
  const selectedClipRef = useRef(selectedClip);
  useEffect(() => { selectedClipRef.current = selectedClip; }, [selectedClip]);

  const playheadRef = useRef(playback.playhead);
  const playingRef = useRef(playback.playing);
  useEffect(() => { playingRef.current = playback.playing; }, [playback.playing]);

  const timelineDuration = useMemo(() => computeTimelineDuration(project.clips), [project.clips]);
  const durationRef = useRef(timelineDuration);
  useEffect(() => { durationRef.current = timelineDuration; }, [timelineDuration]);

  const drawFrame = useCallback((timeMs) => {
    const ctx = ctxRef.current, offCtx = offCtxRef.current, offCanvas = offCanvasRef.current;
    const blurCanvas = blurCanvasRef.current, blurCtx = blurCtxRef.current;
    if (!ctx || !offCtx) return;
    const { w, h } = dimsRef.current;
    ctx.clearRect(0, 0, w, h);
    paintBackground(ctx, bgRef.current, w, h, bgImgRef.current);

    const selId = selectedClipRef.current?.id;
    let selBBox = null;

    // Digambar dari BAWAH ke ATAS daftar layer (array dibalik), supaya layer
    // yang berada paling atas di panel Layer selalu digambar TERAKHIR — jadi
    // tampil paling depan, persis seperti aturan "atas = paling depan".
    for (let i = clipsRef.current.length - 1; i >= 0; i--) {
      const clip = clipsRef.current[i];
      let bbox = null;
      try {
        if (clip.type === "text") {
          bbox = drawTextClip(ctx, offCtx, offCanvas, clip, timeMs, w, h, blurCanvas, blurCtx);
        } else if (clip.type === "image" || clip.type === "video") {
          const entry = mediaMapRef.current[clip.type][clip.id];
          bbox = drawMediaVisual(ctx, entry?.el, clip, timeMs, w, h, blurCanvas, blurCtx);
        }
      } catch (e) { /* aset belum siap */ }
      if (clip.id === selId) selBBox = bbox;
    }

    if (selBBox && !playingRef.current) {
      drawSelectionOverlay(ctx, selBBox);
      bboxRef.current = selBBox;
    } else {
      bboxRef.current = null;
    }
  }, [mediaMapRef]);

  useEffect(() => { redrawRef.current = () => { if (!playingRef.current) drawFrame(playheadRef.current); }; }, [drawFrame]);

  const resizeRef = useRef(() => {});
  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!offCanvasRef.current) offCanvasRef.current = document.createElement("canvas");
    if (!blurCanvasRef.current) {
      blurCanvasRef.current = document.createElement("canvas");
      blurCtxRef.current = blurCanvasRef.current.getContext("2d");
    }
    const resize = () => {
      const frame = frameRef.current;
      // While actually playing back, shrink the margin around the frame to
      // almost nothing so the canvas fills the preview area edge-to-edge —
      // it should feel like watching the real finished video, not editing
      // a small thumbnail. Outside of playback we keep more breathing room
      // so the move/rotate handles and canvas chrome stay comfortable.
      // Saat playing, wrap-nya sendiri sudah punya CSS padding 32px di tiap
      // sisi (lihat .is-playing) untuk memberi sedikit jarak napas terhadap
      // tepi layar penuh — samakan angkanya di sini supaya video benar-benar
      // pas mengisi area yang tersedia tanpa terpotong atau menyisakan
      // celah aneh.
      const pad = playback.previewOpen ? 64 : 40;
      const availW = Math.max(60, wrap.clientWidth - pad);
      const availH = Math.max(60, wrap.clientHeight - pad);
      const fitScale = Math.min(availW / frame.w, availH / frame.h);
      const z = clamp(zoomRef.current, 0.15, 4);
      const dispW = frame.w * fitScale * z;
      const dispH = frame.h * fitScale * z;

      canvas.width = frame.w; canvas.height = frame.h;
      canvas.style.width = `${dispW}px`; canvas.style.height = `${dispH}px`;
      const ctx = canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctxRef.current = ctx;

      const off = offCanvasRef.current;
      off.width = frame.w; off.height = frame.h;
      const offCtx = off.getContext("2d");
      offCtx.setTransform(1, 0, 0, 1, 0, 0);
      offCtxRef.current = offCtx;

      dimsRef.current = { w: frame.w, h: frame.h };
      drawFrame(playheadRef.current);
    };
    resizeRef.current = resize;
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [drawFrame, playback.previewOpen]);

  // Re-fit/re-render whenever the frame preset/custom size changes.
  useEffect(() => { resizeRef.current(); }, [project.frameSize.w, project.frameSize.h]);

  // Zoom canvas in/out with the mouse wheel while hovering the stage.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      setZoom((z) => Math.round(clamp(z * factor, 0.15, 4) * 100) / 100);
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => { resizeRef.current(); }, [zoom]);

  // Ref ke teks waktu (transport & preview) supaya bisa diperbarui LANGSUNG
  // saat memutar tanpa re-render React (lihat loop rAF di bawah).
  const timeTextRef = useRef(null);
  const fsTimeTextRef = useRef(null);
  const fmtTime = (ms) => `${(ms / 1000).toFixed(2)}dtk / ${(durationRef.current / 1000).toFixed(2)}dtk`;

  useEffect(() => {
    playheadRef.current = playback.playhead;
    // Saat sedang memutar, loop rAF-lah yang mengurus sinkronisasi & gambar
    // tiap frame. Menjalankan ulang blok ini tiap tick hanya menambah beban
    // (dan dulu ikut bikin patah-patah), jadi cukup update ref lalu keluar.
    if (playback.playing) return;
    syncMediaPlayback(project.clips, mediaMapRef, playback.playhead, false);
    drawFrame(playback.playhead);
  }, [playback.playhead, playback.playing, project.clips, project.selectedClipId, project.background, drawFrame, mediaMapRef]);

  useEffect(() => {
    if (!playback.playing) return;
    let raf, lastTs = null, lastSync = 0;
    const loop = (ts) => {
      if (lastTs == null) lastTs = ts;
      const dt = ts - lastTs; lastTs = ts;
      let next = playheadRef.current + dt;
      let stop = false;
      const duration = durationRef.current;
      if (next >= duration) {
        if (playback.loop) next = 0; else { next = duration; stop = true; }
      }
      playheadRef.current = next;
      drawFrame(next);
      if (ts - lastSync > 180) { lastSync = ts; syncMediaPlayback(clipsRef.current, mediaMapRef, next, true); }
      // Perbarui indikator playhead & teks waktu LANGSUNG lewat DOM (tanpa
      // dispatch → tanpa re-render React), supaya animasi kanvas mulus dan
      // tidak lagi patah-patah saat diputar.
      if (playClock) playClock.notify(next);
      if (timeTextRef.current) timeTextRef.current.textContent = fmtTime(next);
      if (fsTimeTextRef.current) fsTimeTextRef.current.textContent = fmtTime(next);
      if (stop) {
        dispatchPlayback({ type: "SET_PLAYING", value: false });
        dispatchPlayback({ type: "SET_PLAYHEAD", value: next });
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playback.playing, playback.loop, dispatchPlayback, drawFrame, mediaMapRef, playClock]);

  const onMouseDown = (e) => {
    if (playback.playing) return;
    const sel = selectedClipRef.current;
    const bbox = bboxRef.current;
    if (!sel || !bbox) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = dimsRef.current.w / rect.width, scaleY = dimsRef.current.h / rect.height;
    const mx = (e.clientX - rect.left) * scaleX, my = (e.clientY - rect.top) * scaleY;
    const rad = (bbox.rotation * Math.PI) / 180;
    const handleDist = bbox.halfH + 26;
    const hx = bbox.cx + Math.sin(rad) * handleDist;
    const hy = bbox.cy - Math.cos(rad) * handleDist;
    const distToHandle = Math.hypot(mx - hx, my - hy);

    let mode = null, init = {};
    if (distToHandle < 11) {
      mode = "rotate";
      init = { startAngle: (Math.atan2(mx - bbox.cx, -(my - bbox.cy)) * 180) / Math.PI, startOffRot: sel.offset.rotation, cx: bbox.cx, cy: bbox.cy };
    } else {
      const dx = mx - bbox.cx, dy = my - bbox.cy;
      const lx = dx * Math.cos(-rad) - dy * Math.sin(-rad);
      const ly = dx * Math.sin(-rad) + dy * Math.cos(-rad);
      if (Math.abs(lx) <= bbox.halfW && Math.abs(ly) <= bbox.halfH) {
        mode = "move";
        init = { startMx: mx, startMy: my, startOffX: sel.offset.x, startOffY: sel.offset.y };
      }
    }
    if (!mode) return;
    dragRef.current = { mode, clipId: sel.id, ...init };

    const onMove = (ev) => {
      const r = canvasRef.current.getBoundingClientRect();
      const sX = dimsRef.current.w / r.width, sY = dimsRef.current.h / r.height;
      const cx2 = (ev.clientX - r.left) * sX, cy2 = (ev.clientY - r.top) * sY;
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === "move") {
        const dx = cx2 - d.startMx, dy = cy2 - d.startMy;
        dispatchProject({ type: "SET_OFFSET", id: d.clipId, patch: { x: d.startOffX + dx, y: d.startOffY + dy } });
      } else if (d.mode === "rotate") {
        const angle = (Math.atan2(cx2 - d.cx, -(cy2 - d.cy)) * 180) / Math.PI;
        dispatchProject({ type: "SET_OFFSET", id: d.clipId, patch: { rotation: Math.round(d.startOffRot + (angle - d.startAngle)) } });
      }
    };
    const onUp = () => { dragRef.current = null; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const exportVideo = async () => {
    if (exporting) return;
    if (typeof canvasRef.current.captureStream !== "function" || typeof window.MediaRecorder === "undefined") {
      reportError("Browser ini tidak mendukung ekspor video (captureStream/MediaRecorder tidak tersedia). Coba pakai Chrome atau Edge versi terbaru.");
      return;
    }
    if (project.clips.length === 0) {
      reportError("Belum ada klip untuk diekspor. Tambahkan teks, gambar, video, atau audio terlebih dahulu.");
      return;
    }

    // Prime every media element with a play()+pause() *synchronously* inside
    // this click handler. Browsers only allow programmatic el.play() without
    // a fresh user gesture if the element was already "activated" by one —
    // without this, video/audio clips silently fail to play during the
    // export loop below (which runs from a rAF callback, well outside the
    // click's gesture window), so the exported file ends up missing those
    // layers entirely. This is the main reason exports came out incomplete.
    primeMediaElements(mediaMapRef);
    const allMediaEntries = [
      ...Object.values(mediaMapRef.current.video),
      ...Object.values(mediaMapRef.current.audio),
    ].filter(Boolean);
    allMediaEntries.forEach((entry) => {
      try { entry.el.currentTime = 0; } catch (e) {}
    });

    setExporting(true);
    setExportProgress(0);
    dispatchPlayback({ type: "SET_LOOP", value: false });
    dispatchPlayback({ type: "SET_PLAYHEAD", value: 0 });
    playheadRef.current = 0;
    drawFrame(0);

    // Give video/image elements a moment to actually be seekable/ready so
    // the first frames of the export aren't blank.
    const readyDeadline = Date.now() + 4000;
    while (Date.now() < readyDeadline) {
      const notReady = Object.values(mediaMapRef.current.video).some((entry) => entry && entry.el.readyState < 2);
      if (!notReady) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    await new Promise((r) => setTimeout(r, 80));

    const canvas = canvasRef.current;
    const hasMedia = allMediaEntries.length > 0;

    // Setup audio HANYA kalau ada klip video/audio. Sebelumnya track audio
    // (silent) selalu ditambahkan walau proyek cuma teks — di sebagian
    // browser track audio yang tak pernah mengeluarkan sample bisa membuat
    // MediaRecorder menahan/menggagalkan seluruh rekaman ("tidak ada data
    // terekam"). Untuk proyek teks-saja, rekam video-only saja.
    let audioCtx = null, audioDest = null;
    if (hasMedia) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") await audioCtx.resume();
        audioDest = audioCtx.createMediaStreamDestination();
        const seen = new Set();
        allMediaEntries.forEach((entry) => {
          if (seen.has(entry.el)) return;
          seen.add(entry.el);
          try {
            if (!entry.srcNode) entry.srcNode = audioCtx.createMediaElementSource(entry.el);
            entry.srcNode.connect(audioDest);
            entry.srcNode.connect(audioCtx.destination);
          } catch (e) { /* elemen mungkin belum siap */ }
        });
      } catch (e) { audioCtx = null; audioDest = null; }
    }

    // Untuk proyek TANPA media, pakai mode frame manual: captureStream(0) +
    // videoTrack.requestFrame() dipanggil sekali per frame yang digambar.
    // Ini cara paling andal merekam <canvas> — tiap frame dijamin tertangkap,
    // jadi tidak mungkin lagi "tidak ada data video yang terekam". Untuk
    // proyek dengan media (butuh audio real-time), pakai captureStream(fps).
    const videoTrack0 = canvas.captureStream(0).getVideoTracks()[0];
    const canManual = !hasMedia && videoTrack0 && typeof videoTrack0.requestFrame === "function";
    const videoStream = canManual ? new MediaStream([videoTrack0]) : canvas.captureStream(30);
    const videoTrack = canManual ? videoTrack0 : videoStream.getVideoTracks()[0];

    const tracks = [videoTrack];
    if (audioDest) tracks.push(...audioDest.stream.getAudioTracks());
    const combinedStream = new MediaStream(tracks);

    // Utamakan MP4 (H.264) supaya hasil ekspor langsung .mp4 — format paling
    // universal & langsung bisa diunggah ke mana saja. Yang dicek HANYA varian
    // dengan codec H.264 eksplisit (avc1/h264): di Chrome/Edge/Safari modern
    // (mis. di Mac) ini didukung penuh (encoder H.264 hardware). Sengaja TIDAK
    // memakai "video/mp4" polos sebagai sinyal dukungan — sebagian browser
    // (mis. Chromium tanpa codec berbayar) melaporkannya "true" padahal tak
    // punya encoder H.264, sehingga rekaman gagal/kosong. Kalau MP4 benar-benar
    // tak didukung, jatuh ke WebM (selalu bisa diputar) secara otomatis.
    const MP4_CANDIDATES = hasMedia ? [
      "video/mp4;codecs=avc1.640028,mp4a.40.2",
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4;codecs=h264,aac",
    ] : [
      "video/mp4;codecs=avc1.640028",
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4;codecs=avc1",
    ];
    const WEBM_CANDIDATES = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    const mimeType =
      MP4_CANDIDATES.find((m) => window.MediaRecorder.isTypeSupported(m)) ||
      WEBM_CANDIDATES.find((m) => window.MediaRecorder.isTypeSupported(m)) ||
      "video/webm";
    const ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
    const wantedMp4ButGotWebm = ext === "webm";

    const chunks = [];
    let recorder;
    try {
      recorder = new window.MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: 8000000 });
    } catch (e) {
      try { recorder = new window.MediaRecorder(combinedStream); }
      catch (e2) {
        reportError("Ekspor gagal: browser menolak MediaRecorder. Coba Chrome/Edge terbaru.");
        setExporting(false); setExportProgress(0);
        if (audioCtx) { try { await audioCtx.close(); } catch (x) {} }
        return;
      }
    }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    // timeslice → data dikeluarkan berkala (bukan hanya di akhir), jadi kalau
    // ada yang terputus pun potongan awal tetap tersimpan.
    recorder.start(250);

    const duration = durationRef.current;
    const FPS = 30;

    if (canManual) {
      // Render deterministik frame-demi-frame (proyek teks/gambar). Tiap frame
      // digambar lalu di-capture manual — tidak bergantung ke loop playback
      // React sama sekali.
      const frameMs = 1000 / FPS;
      for (let t = 0; t <= duration; t += frameMs) {
        drawFrame(t);
        try { videoTrack.requestFrame(); } catch (e) {}
        setExportProgress(Math.min(99, Math.round((t / duration) * 100)));
        await new Promise((r) => setTimeout(r, 0)); // beri napas ke recorder
      }
      drawFrame(duration);
      try { videoTrack.requestFrame(); } catch (e) {}
    } else {
      // Ada media → butuh audio real-time: putar dengan loop rAF real-time.
      playheadRef.current = 0;
      await new Promise((resolve) => {
        let last = performance.now();
        const stepLoop = () => {
          const now = performance.now(); const dt = now - last; last = now;
          let next = playheadRef.current + dt;
          if (next >= duration) next = duration;
          playheadRef.current = next;
          drawFrame(next);
          syncMediaPlayback(clipsRef.current, mediaMapRef, next, true);
          setExportProgress(Math.min(99, Math.round((next / duration) * 100)));
          if (next >= duration) { resolve(); return; }
          requestAnimationFrame(stepLoop);
        };
        requestAnimationFrame(stepLoop);
      });
      Object.values(mediaMapRef.current.video).forEach((e) => { try { e && e.el.pause(); } catch (x) {} });
      Object.values(mediaMapRef.current.audio).forEach((e) => { try { e && e.el.pause(); } catch (x) {} });
    }

    // Keluarkan sisa buffer sebelum berhenti supaya bagian akhir tak terbuang.
    try { recorder.requestData(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    if (audioCtx) { try { await audioCtx.close(); } catch (e) {} }
    setExportProgress(100);

    if (chunks.length === 0) {
      reportError("Ekspor gagal: tidak ada data video yang terekam. Coba lagi, atau kurangi durasi/ukuran frame.");
      setExporting(false);
      setExportProgress(0);
      return;
    }

    const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `motion-font-export.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);

    if (wantedMp4ButGotWebm) {
      reportError("Browser ini belum bisa merekam MP4 (H.264), jadi hasilnya .webm — tetap bisa diputar & diunggah. Untuk hasil .mp4 langsung, pakai Chrome/Edge terbaru (di HP/desktop Android/Windows/Mac).");
    }

    setExporting(false);
    setExportProgress(0);
  };

  // Tombol play di bawah frame: cuma memutar animasi inline di kanvas
  // utama (seperti sebelumnya), TIDAK membuka panel preview full-frame.
  const togglePlayback = useCallback(() => {
    if (exporting) return;
    if (!playback.playing) {
      primeMediaElements(mediaMapRef);
      dispatchPlayback({ type: "SET_PLAYING", value: true });
    } else {
      // Saat menjeda, commit posisi playhead terkini (yang selama play cuma
      // dilacak di ref) ke state supaya UI React kembali sinkron.
      dispatchPlayback({ type: "SET_PLAYING", value: false });
      dispatchPlayback({ type: "SET_PLAYHEAD", value: playheadRef.current });
    }
  }, [exporting, playback.playing, dispatchPlayback]);

  // Tombol "Preview" di topbar kanan atas: satu-satunya pemicu panel
  // preview full-frame (blur backdrop menutupi viewport).
  const togglePreviewPanel = useCallback(() => {
    if (exporting) return;
    if (!playback.previewOpen) {
      if (!playback.playing) primeMediaElements(mediaMapRef);
      dispatchPlayback({ type: "SET_PLAYING", value: true });
      dispatchPlayback({ type: "SET_PREVIEW_OPEN", value: true });
    } else {
      dispatchPlayback({ type: "SET_PLAYING", value: false });
      dispatchPlayback({ type: "SET_PLAYHEAD", value: playheadRef.current });
      dispatchPlayback({ type: "SET_PREVIEW_OPEN", value: false });
    }
  }, [exporting, playback.playing, playback.previewOpen, dispatchPlayback]);

  // Ratakan objek terpilih terhadap kanvas. Memakai bbox terakhir yang
  // digambar (halfW/halfH dalam piksel frame) untuk menghitung offset baru,
  // sehingga tepian objek benar-benar menempel ke tepi/tengah frame.
  const alignSelected = useCallback((axis, where) => {
    const sel = selectedClipRef.current;
    if (!sel) return;
    if (!bboxRef.current) drawFrame(playheadRef.current);
    const bbox = bboxRef.current;
    const { w, h } = dimsRef.current;
    if (!bbox || !w || !h) return;
    const margin = Math.round(Math.min(w, h) * 0.02);
    if (axis === "h") {
      const target = where === "start" ? margin + bbox.halfW : where === "end" ? w - margin - bbox.halfW : w / 2;
      dispatchProject({ type: "SET_OFFSET", id: sel.id, patch: { x: Math.round(sel.offset.x + (target - bbox.cx)) } });
    } else {
      const target = where === "start" ? margin + bbox.halfH : where === "end" ? h - margin - bbox.halfH : h / 2;
      dispatchProject({ type: "SET_OFFSET", id: sel.id, patch: { y: Math.round(sel.offset.y + (target - bbox.cy)) } });
    }
  }, [dispatchProject, drawFrame]);

  useImperativeHandle(ref, () => ({ exportVideo, togglePreview: togglePreviewPanel, alignSelected }), [exportVideo, togglePreviewPanel, alignSelected]);

  // Tekan Esc untuk keluar dari mode preview full-frame, seperti menutup
  // lightbox/modal pada umumnya.
  useEffect(() => {
    if (!playback.previewOpen) return;
    const onKey = (e) => { if (e.key === "Escape") togglePreviewPanel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playback.previewOpen, togglePreviewPanel]);

  // Spasi = putar/jeda, sama seperti kebanyakan software edit video —
  // dilewati kalau fokus sedang di input/textarea/select (mis. sedang
  // mengetik isi teks klip) supaya spasi tetap jadi karakter biasa di
  // situ, dan preventDefault supaya halaman tidak ikut ter-scroll seperti
  // perilaku bawaan tombol spasi di browser.
  useEffect(() => {
    const onSpaceKey = (e) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const tag = e.target?.tagName;
      const isEditable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable;
      if (isEditable) return;
      e.preventDefault();
      togglePlayback();
    };
    window.addEventListener("keydown", onSpaceKey);
    return () => window.removeEventListener("keydown", onSpaceKey);
  }, [togglePlayback]);

  return (
    <div className="mfs-center">
      <div className={`mfs-canvas-wrap ${playback.previewOpen ? "is-playing" : ""}`} ref={wrapRef}>
        <canvas
          ref={canvasRef}
          onMouseDown={onMouseDown}
          style={{
            borderRadius: playback.previewOpen ? 0 : 10,
            boxShadow: playback.previewOpen ? "none" : "0 0 0 1px var(--border), 0 30px 80px rgba(0,0,0,0.5)",
            cursor: playback.previewOpen ? "default" : "move",
          }}
        />
        {playback.previewOpen && (
          <>
            <button className="mfs-fullscreen-close" onClick={togglePreviewPanel} title="Tutup preview (Esc)"><X size={16} /></button>
            {/* Satu-satunya panel kontrol saat preview: pill mengambang di
                bawah kanvas. Bar transport biasa (di luar canvas-wrap)
                disembunyikan total selama preview supaya tidak ada lagi
                bar dobel. */}
            <div className="mfs-fullscreen-controls">
              <button className="mfs-icon-btn" onClick={() => dispatchPlayback({ type: "SET_PLAYHEAD", value: 0 })} title="Ulangi dari awal"><RotateCcw size={15} /></button>
              <button className="mfs-play-btn" onClick={togglePlayback} title={playback.playing ? "Jeda" : "Putar"}>
                {playback.playing ? <Pause size={14} /> : <Play size={14} style={{ marginLeft: 1 }} />}
              </button>
              <button className={`mfs-icon-btn ${playback.loop ? "active" : ""}`} onClick={() => dispatchPlayback({ type: "SET_LOOP", value: !playback.loop })} title="Ulang otomatis"><Repeat size={15} /></button>
              <span className="mfs-fullscreen-time" ref={fsTimeTextRef}>{(playback.playhead / 1000).toFixed(2)}dtk / {(timelineDuration / 1000).toFixed(2)}dtk</span>
            </div>
          </>
        )}
      </div>
      {!playback.previewOpen && (
        <div className="mfs-transport">
          <button className="mfs-icon-btn" disabled={exporting} onClick={() => dispatchPlayback({ type: "SET_PLAYHEAD", value: 0 })} title="Ulangi dari awal"><RotateCcw size={15} /></button>
          <button className="mfs-play-btn" disabled={exporting} onClick={togglePlayback}>
            {playback.playing ? <Pause size={14} /> : <Play size={14} style={{ marginLeft: 1 }} />}
          </button>
          <button className={`mfs-icon-btn ${playback.loop ? "active" : ""}`} disabled={exporting} onClick={() => dispatchPlayback({ type: "SET_LOOP", value: !playback.loop })} title="Ulang otomatis"><Repeat size={15} /></button>
          <span className="mfs-zoom-badge" title="Scroll mouse di kanvas untuk zoom">{Math.round(zoom * 100)}%</span>
          <button className="mfs-icon-btn" disabled={exporting} onClick={() => setZoom(1)} title="Reset zoom"><RotateCcw size={13} /></button>
          <div className="mfs-transport-time" ref={timeTextRef}>{(playback.playhead / 1000).toFixed(2)}dtk / {(timelineDuration / 1000).toFixed(2)}dtk</div>
        </div>
      )}
    </div>
  );
});

/* ============================================================
   RIGHT INSPECTOR
   ============================================================ */

// Konversi warna kecil (hex <-> rgb <-> hsv) — dipakai supaya picker warna
// bisa 100% custom-built (kotak saturation/value + slider hue, gaya
// standar Photoshop/Figma), tanpa pernah membuka dialog warna bawaan
// OS/browser yang tampilannya tidak konsisten dan terasa "berantakan".
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "#000000");
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
function rgbToHex(r, g, b) {
  const h = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h;
  if (d === 0) h = 0;
  else if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h: Math.round(h), s: Math.round(s * 100), v: Math.round(v * 100) };
}
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; v = clamp(v, 0, 100) / 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
function hexToHsv(hex) { const { r, g, b } = hexToRgb(hex); return rgbToHsv(r, g, b); }
function hsvToHex(h, s, v) { const { r, g, b } = hsvToRgb(h, s, v); return rgbToHex(r, g, b); }

// Picker warna 100% custom — TIDAK memakai <input type="color"> bawaan,
// jadi tidak pernah memunculkan dialog warna native OS/browser yang
// tampilannya besar dan tidak konsisten dengan gaya app. Klik pil swatch
// membuka popover kecil berisi kotak Saturation/Value (drag bebas dua
// sumbu) + slider Hue di bawahnya — persis pola picker warna standar
// Photoshop/Figma — plus input hex, semua dengan gaya minimalis-modern
// senada tema gelap aplikasi.
function ColorPickerField({ label, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [hexInput, setHexInput] = useState((value || "#000000").toUpperCase());
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  // Melacak hex terakhir yang KITA sendiri kirim lewat onChange — supaya
  // saat prop `value` berubah karena drag kita sendiri, hue/saturasi yang
  // sedang di-drag tidak "dihitung ulang" dari hex (yang bisa kehilangan
  // info hue pas warnanya abu-abu/hitam/putih, sebab hue jadi ambigu).
  const lastEmittedRef = useRef((value || "#000000").toUpperCase());
  const squareRef = useRef(null);
  const draggingRef = useRef(false);
  // Selama drag, pointermove bisa menembak jauh lebih sering daripada
  // layar bisa digambar ulang (puluhan-ratusan kali/detik pada mouse/
  // trackpad polling tinggi). Untuk warna SVG ini mahal (parse+serialize
  // XML tiap kali) dan tiap perubahan memicu reload gambar. Kita batasi
  // jadi maksimal satu commit per animation frame (~60/dtk) memakai rAF,
  // sambil tetap memastikan nilai TERAKHIR selalu ikut terkirim.
  const rafIdRef = useRef(null);
  const pendingHsvRef = useRef(null);
  useEffect(() => () => { if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current); }, []);

  useEffect(() => {
    const v = (value || "#000000").toUpperCase();
    if (v !== lastEmittedRef.current) {
      setHsv(hexToHsv(v));
      lastEmittedRef.current = v;
    }
    setHexInput(v);
  }, [value]);

  const commit = (nextHsv) => {
    setHsv(nextHsv);
    const hex = hsvToHex(nextHsv.h, nextHsv.s, nextHsv.v);
    lastEmittedRef.current = hex;
    setHexInput(hex);
    onChange(hex);
  };
  const commitHex = (raw) => {
    let v = raw.trim();
    if (v && !v.startsWith("#")) v = `#${v}`;
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) onChange(v.toUpperCase());
  };

  const updateFromPointer = (clientX, clientY, { immediate = false } = {}) => {
    const el = squareRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clamp((clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((clientY - rect.top) / rect.height, 0, 1);
    const nextHsv = { ...hsv, s: Math.round(x * 100), v: Math.round((1 - y) * 100) };
    if (immediate) {
      pendingHsvRef.current = null;
      if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
      commit(nextHsv);
      return;
    }
    pendingHsvRef.current = nextHsv;
    if (rafIdRef.current == null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (pendingHsvRef.current) commit(pendingHsvRef.current);
        pendingHsvRef.current = null;
      });
    }
  };
  const onSquarePointerDown = (e) => {
    e.preventDefault();
    draggingRef.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    updateFromPointer(e.clientX, e.clientY, { immediate: true });
  };
  const onSquarePointerMove = (e) => { if (draggingRef.current) updateFromPointer(e.clientX, e.clientY); };
  const endSquareDrag = (e) => {
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {}
    // Pastikan posisi FINAL saat jari/mouse dilepas benar-benar terkirim,
    // bukan tertinggal di dalam rAF yang sudah dibatalkan.
    if (pendingHsvRef.current) {
      if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
      commit(pendingHsvRef.current);
      pendingHsvRef.current = null;
    }
  };

  return (
    <div className="mfs-field">
      {label && <label>{label}</label>}
      <div className="mfs-color-picker-wrap">
        <button type="button" className="mfs-color-picker" onClick={() => setOpen((v) => !v)}>
          <span className="mfs-color-picker-swatch" style={{ background: value }} />
          <span className="mfs-color-picker-hex">{(value || "").toUpperCase()}</span>
        </button>
        {open && (
          <>
            <div className="mfs-menu-backdrop" onClick={() => setOpen(false)} />
            <div className="mfs-popover mfs-color-popover mfs-color-popover-hsv" onClick={(e) => e.stopPropagation()}>
              <div
                ref={squareRef}
                className="mfs-sv-square"
                style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${hsv.h},100%,50%)` }}
                onPointerDown={onSquarePointerDown}
                onPointerMove={onSquarePointerMove}
                onPointerUp={endSquareDrag}
                onPointerCancel={endSquareDrag}
              >
                <div
                  className="mfs-sv-thumb"
                  style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, background: value }}
                />
              </div>
              <input
                type="range"
                className="mfs-slider mfs-hue-slider"
                min={0} max={360}
                value={hsv.h}
                onChange={(e) => commit({ ...hsv, h: Number(e.target.value) })}
              />
              <div className="mfs-color-preview-row">
                <span className="mfs-color-picker-swatch large" style={{ background: value }} />
                <input
                  className="mfs-input mfs-color-hex-input"
                  value={hexInput}
                  spellCheck={false}
                  onChange={(e) => { setHexInput(e.target.value); commitHex(e.target.value); }}
                  onBlur={() => setHexInput((value || "#000000").toUpperCase())}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SliderField({ label, value, min, max, step, unit = "", onChange, format }) {
  const display = format ? format(value) : `${Math.round(value * 100) / 100}${unit}`;
  return (
    <div className="mfs-field">
      <label>{label} <span className="mfs-slider-val">{display}</span></label>
      <input
        type="range"
        className="mfs-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function BackgroundInspector({ background, dispatch }) {
  const fileRef = useRef(null);
  const patch = (p) => dispatch({ type: "SET_BACKGROUND", patch: p });
  const previewStyle =
    background.type === "gradient"
      ? { background: `linear-gradient(${background.gradAngle || 135}deg, ${background.gradFrom}, ${background.gradTo})` }
      : background.type === "image" && background.imageSrc
      ? { backgroundImage: `url(${background.imageSrc})` }
      : { background: background.color };

  return (
    <div className="mfs-right">
      <div className="mfs-section-label">Latar Belakang Panggung</div>
      <div className="mfs-bg-preview" style={previewStyle} />
      <div className="mfs-field">
        <label>Jenis</label>
        <div className="mfs-segmented">
          {[["solid", "Solid"], ["gradient", "Gradasi"], ["image", "Gambar"]].map(([m, label]) => (
            <button key={m} className={background.type === m ? "active" : ""} onClick={() => patch({ type: m })}>{label}</button>
          ))}
        </div>
      </div>

      {background.type === "solid" && (
        <ColorPickerField label="Warna" value={background.color} onChange={(v) => patch({ color: v })} />
      )}

      {background.type === "gradient" && (
        <>
          <ColorPickerField label="Warna 1" value={background.gradFrom} onChange={(v) => patch({ gradFrom: v })} />
          <ColorPickerField label="Warna 2" value={background.gradTo} onChange={(v) => patch({ gradTo: v })} />
          <SliderField
            label="Sudut"
            value={background.gradAngle ?? 135}
            min={0}
            max={360}
            step={1}
            unit="°"
            onChange={(v) => patch({ gradAngle: v })}
          />
        </>
      )}

      {background.type === "image" && (
        <div className="mfs-field">
          <div className="mfs-upload-zone" onClick={() => fileRef.current?.click()}>
            <Upload size={16} style={{ marginBottom: 6 }} />
            <div>Impor gambar latar</div>
            <div style={{ fontSize: 10.5, marginTop: 2, color: "var(--text-dim)" }}>otomatis mengisi penuh (cover)</div>
            <input ref={fileRef} type="file" hidden accept="image/*" onChange={async (e) => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; try { patch({ imageSrc: await readFileAsDataURL(f) }); } catch (err) { reportError(`Gagal mengimpor "${f.name}": ${err.message || err}`); } }} />
          </div>
        </div>
      )}
      <div style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.5, marginTop: 4 }}>Latar ini berlaku untuk seluruh panggung/frame, di belakang semua klip.</div>
    </div>
  );
}

// Pemilih & pengunggah font, kini hidup di PANEL KANAN (sebelumnya di panel
// kiri) menyatu dengan pengaturan teks lain. Font yang baru diunggah langsung
// diterapkan ke klip teks yang sedang dipilih.
function FontPicker({ fonts, clip, dispatch }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const handleFiles = async (files) => {
    setBusy(true);
    for (const file of Array.from(files)) {
      try {
        const family = `CustomFont-${uid("f")}`;
        const buf = await file.arrayBuffer();
        const face = new FontFace(family, buf);
        await face.load();
        document.fonts.add(face);
        const name = file.name.replace(/\.(otf|ttf|woff2?)$/i, "");
        dispatch({ type: "ADD_FONT", font: { family, name, buffer: buf } });
        dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { fontFamily: family } });
      } catch (e) { reportError(`Gagal memuat font "${file.name}": ${e.message || e}`); }
    }
    setBusy(false);
  };
  const applyFont = (family) => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { fontFamily: family } });
  const active = clip.fontFamily;
  return (
    <>
      <div className="mfs-section-label">Font</div>
      <div className="mfs-upload-zone" onClick={() => fileRef.current?.click()}>
        <Upload size={14} style={{ marginBottom: 4 }} />
        <div>{busy ? "Memuat…" : "Unggah .otf / .ttf / .woff2"}</div>
        <div style={{ fontSize: 10, marginTop: 2, color: "var(--text-dim)" }}>atau klik untuk memilih</div>
        <input ref={fileRef} type="file" multiple hidden accept=".otf,.ttf,.woff2,.woff" onChange={(e) => e.target.files.length && handleFiles(e.target.files)} />
      </div>
      <div className="mfs-font-item" style={{ fontFamily: "Inter" }} onClick={() => applyFont("Inter, sans-serif")}>
        <Type size={13} color={active === "Inter, sans-serif" ? "var(--accent)" : "var(--text-dim)"} /><span className="name">Inter (sistem)</span>
      </div>
      {fonts.map((f) => (
        <div key={f.family} className={`mfs-font-item ${active === f.family ? "selected" : ""}`} style={{ fontFamily: f.family }} onClick={() => applyFont(f.family)}>
          <Type size={13} color={active === f.family ? "var(--accent)" : "var(--text-dim)"} /><span className="name">{f.name}</span>
        </div>
      ))}
    </>
  );
}

// Kontrol animasi (preset) untuk panel kanan: easing + centang animasi
// masuk/keluar. "animasi" di sini = preset. Centang masuk saja → objek diam
// saat keluar; centang keluar saja → diam saat masuk; centang keduanya →
// animasi masuk & keluar. Nama preset ditampilkan; pemilihannya tetap di
// panel kiri (tab "Preset").
function AnimationControls({ clip, dispatch }) {
  const easing = clip.easing || "auto";
  const animIn = clip.animateIn !== false;
  const animOut = clip.animateOut !== false;
  const set = (patch) => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch });
  return (
    <>
      <div className="mfs-section-label">Animasi (Preset)</div>
      <div className="mfs-chip" style={{ marginBottom: 8 }}><Sparkles size={12} /> {getPreset(clip.presetId).name}</div>
      <label className="mfs-check-row">
        <input type="checkbox" checked={animIn} onChange={(e) => set({ animateIn: e.target.checked })} />
        <span>Animasi masuk</span>
      </label>
      <label className="mfs-check-row">
        <input type="checkbox" checked={animOut} onChange={(e) => set({ animateOut: e.target.checked })} />
        <span>Animasi keluar</span>
      </label>
      <div className="mfs-field" style={{ marginTop: 8 }}>
        <label>Easing (rasa gerak)</label>
        <select className="mfs-input mfs-select" value={easing} onChange={(e) => set({ easing: e.target.value })}>
          <option value="auto">Auto (bawaan preset)</option>
          <option value="linear">Linear</option>
          <option value="easeIn">Ease In (pelan di awal)</option>
          <option value="easeOut">Ease Out (pelan di akhir)</option>
          <option value="easeInOut">Ease In-Out (pelan di ujung)</option>
        </select>
      </div>
      <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>Pilih preset di panel kiri (tab "Preset"). Transisi antar-klip diseret ke sela-sela klip di linimasa.</div>
    </>
  );
}

const RightInspector = React.memo(function RightInspector({ project, dispatch }) {
  if (project.selectedClipId === BG_SEL) {
    return <BackgroundInspector background={project.background} dispatch={dispatch} />;
  }

  const clip = project.clips.find((c) => c.id === project.selectedClipId);
  if (!clip) return <div className="mfs-right"><div className="mfs-empty">Belum ada klip dipilih. Tambah layer di panel paling kiri.</div></div>;

  const transInName = getTransition(clip.transitionInId).name;
  const transOutName = getTransition(clip.transitionOutId).name;

  if (clip.type === "text") {
    return (
      <div className="mfs-right">
        <div className="mfs-field">
          <label>Isi teks</label>
          <textarea className="mfs-input" value={clip.text} onChange={(e) => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { text: e.target.value } })} />
        </div>
        <div className="mfs-divider" />
        <FontPicker fonts={project.fonts} clip={clip} dispatch={dispatch} />
        <div className="mfs-divider" />
        <div className="mfs-field">
          <label>Animasikan per</label>
          <div className="mfs-segmented">
            {[["char", "Huruf"], ["word", "Kata"], ["line", "Baris"], ["all", "Teks Penuh"]].map(([m, label]) => (
              <button key={m} className={clip.animateBy === m ? "active" : ""} onClick={() => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { animateBy: m } })}>{label}</button>
            ))}
          </div>
        </div>
        <div className="mfs-field">
          <SliderField label="Jeda antar elemen" value={clip.stagger} min={0} max={400} step={5} unit="ms"
            onChange={(v) => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { stagger: v } })} />
        </div>
        <div className="mfs-field">
          <SliderField label="Durasi klip" value={clip.duration / 1000} min={0.1} max={15} step={0.1}
            format={(v) => `${v.toFixed(1)}dtk`}
            onChange={(v) => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { duration: Math.max(150, Math.round(v * 1000)) } })} />
        </div>
        <div className="mfs-divider" />
        <div className="mfs-field">
          <SliderField label="Ukuran font" value={clip.fontSize} min={8} max={220} step={1} unit="px"
            onChange={(v) => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { fontSize: v } })} />
        </div>
        <ColorPickerField label="Warna" value={clip.color} onChange={(v) => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { color: v } })} />
        <div className="mfs-field">
          <SliderField label="Jarak huruf" value={clip.letterSpacing ?? 0} min={-10} max={60} step={0.5} unit="px"
            onChange={(v) => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { letterSpacing: v } })} />
        </div>
        <div className="mfs-field">
          <SliderField label="Jarak baris" value={clip.lineHeight ?? 1.25} min={0.8} max={2.6} step={0.05}
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(v) => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { lineHeight: v } })} />
        </div>
        <div className="mfs-field">
          <label>Perataan teks</label>
          <div className="mfs-align-inline">
            {[["left", AlignLeft, "Kiri"], ["center", AlignCenter, "Tengah"], ["right", AlignRight, "Kanan"]].map(([a, Icon, title]) => (
              <button key={a} className={`mfs-align-ibtn ${(clip.align || "center") === a ? "active" : ""}`} title={title} onClick={() => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { align: a } })}><Icon size={16} /></button>
            ))}
          </div>
        </div>
        <div className="mfs-divider" />
        <div className="mfs-section-label">Posisi</div>
        <div className="mfs-row4">
          <div className="mfs-field"><label>X</label><input type="number" className="mfs-input" value={Math.round(clip.offset.x)} onChange={(e) => dispatch({ type: "SET_OFFSET", id: clip.id, patch: { x: Number(e.target.value) || 0 } })} /></div>
          <div className="mfs-field"><label>Y</label><input type="number" className="mfs-input" value={Math.round(clip.offset.y)} onChange={(e) => dispatch({ type: "SET_OFFSET", id: clip.id, patch: { y: Number(e.target.value) || 0 } })} /></div>
          <div className="mfs-field"><label>Rotasi °</label><input type="number" className="mfs-input" value={Math.round(clip.offset.rotation)} onChange={(e) => dispatch({ type: "SET_OFFSET", id: clip.id, patch: { rotation: Number(e.target.value) || 0 } })} /></div>
          <div className="mfs-field"><label>Skala</label><input type="number" step="0.05" className="mfs-input" value={clip.offset.scale} onChange={(e) => dispatch({ type: "SET_OFFSET", id: clip.id, patch: { scale: Number(e.target.value) || 1 } })} /></div>
        </div>
        <div className="mfs-divider" />
        <AnimationControls clip={clip} dispatch={dispatch} />
      </div>
    );
  }

  const isAudio = clip.type === "audio";
  const isVideo = clip.type === "video";
  return (
    <div className="mfs-right">
      {!isAudio && (
        <div className="mfs-media-preview">
          {clip.type === "image" ? <img src={clip.src} alt="" /> : <video src={clip.src} muted />}
        </div>
      )}
      {clip.isSvg && (
        <div className="mfs-field">
          <ColorPickerField
            label="Warna SVG"
            value={clip.svgColor || "#FFFFFF"}
            onChange={(v) => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { svgColor: v, src: getRecoloredSvgDataUrl(clip.svgSource, v) } })}
          />
          {clip.svgColor && (
            <button
              className="mfs-btn mfs-btn-sm"
              style={{ marginTop: 6 }}
              onClick={() => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { svgColor: null, src: clip.svgOriginalSrc } })}
            >
              <RotateCcw size={12} /> Kembalikan warna asli
            </button>
          )}
        </div>
      )}
      <div className="mfs-field">
        <label>Nama</label>
        <input className="mfs-input" value={clip.name} onChange={(e) => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { name: e.target.value } })} />
      </div>
      <div className="mfs-row2">
        <div className="mfs-field">
          <SliderField label="Durasi klip" value={clip.duration / 1000} min={0.1} max={30} step={0.1}
            format={(v) => `${v.toFixed(1)}dtk`}
            onChange={(v) => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { duration: Math.max(150, Math.round(v * 1000)) } })} />
        </div>
        <div className="mfs-field">
          <SliderField label="Volume" value={clip.volume ?? 1} min={0} max={1} step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { volume: v } })} />
        </div>
      </div>
      {isVideo && (
        <div className="mfs-field">
          <button className="mfs-btn mfs-btn-sm" onClick={() => dispatch({ type: "UPDATE_CLIP", id: clip.id, patch: { muted: !clip.muted } })}>
            {clip.muted ? <VolumeX size={13} /> : <Volume2 size={13} />} {clip.muted ? "Suara dimatikan" : "Suara aktif"}
          </button>
        </div>
      )}
      {!isAudio && (
        <>
          <div className="mfs-divider" />
          <div className="mfs-section-label">Posisi</div>
          <div className="mfs-row4">
            <div className="mfs-field"><label>X</label><input type="number" className="mfs-input" value={Math.round(clip.offset.x)} onChange={(e) => dispatch({ type: "SET_OFFSET", id: clip.id, patch: { x: Number(e.target.value) || 0 } })} /></div>
            <div className="mfs-field"><label>Y</label><input type="number" className="mfs-input" value={Math.round(clip.offset.y)} onChange={(e) => dispatch({ type: "SET_OFFSET", id: clip.id, patch: { y: Number(e.target.value) || 0 } })} /></div>
            <div className="mfs-field"><label>Rotasi °</label><input type="number" className="mfs-input" value={Math.round(clip.offset.rotation)} onChange={(e) => dispatch({ type: "SET_OFFSET", id: clip.id, patch: { rotation: Number(e.target.value) || 0 } })} /></div>
            <div className="mfs-field"><label>Skala</label><input type="number" step="0.05" className="mfs-input" value={clip.offset.scale} onChange={(e) => dispatch({ type: "SET_OFFSET", id: clip.id, patch: { scale: Number(e.target.value) || 1 } })} /></div>
          </div>
        </>
      )}
      <div className="mfs-divider" />
      {isAudio ? (
        <div style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.5 }}>Seret transisi (fade dll.) ke sela-sela klip di linimasa untuk audio.</div>
      ) : (
        <AnimationControls clip={clip} dispatch={dispatch} />
      )}
    </div>
  );
});

/* ============================================================
   MULTI-TRACK TIMELINE (Teks / Video / Gambar / Audio)
   dengan seam drop-zone untuk transisi
   ============================================================ */

// Susun klip teks yang bertumpuk waktunya ke baris (row) vertikal di dalam
// track yang sama — maksimal 3 baris bertumpuk. Klip baru otomatis naik ke
// baris di atas klip sebelumnya jika waktunya beririsan; begitu tidak lagi
// beririsan (digeser ke sela waktu kosong), klip itu bebas kembali sejajar
// (row 0) di samping klip lain, persis seperti linimasa editor video pada
// umumnya.
function packLaneRows(clips, maxRows = 3) {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const rowEnds = [];
  return sorted.map((c) => {
    let row = rowEnds.findIndex((end) => c.start >= end);
    if (row === -1) {
      if (rowEnds.length < maxRows) {
        row = rowEnds.length;
        rowEnds.push(c.start + c.duration);
      } else {
        // Sudah 3 baris penuh dan masih beririsan: numpuk di baris yang
        // paling cepat kosong, daripada bikin baris ke-4.
        row = rowEnds.reduce((best, end, i) => (end < rowEnds[best] ? i : best), 0);
        rowEnds[row] = c.start + c.duration;
      }
    } else {
      rowEnds[row] = c.start + c.duration;
    }
    // Referensi objek klip ASLI dipertahankan (tidak di-spread jadi objek
    // baru) supaya <TimelineClipBlock> yang di-memo bisa melewati render
    // ulang untuk klip yang tidak berubah — kunci performa banyak layer.
    return { clip: c, row };
  });
}

function laneMarkers(clips) {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];
  const markers = [{ key: "start", x: sorted[0].start, left: null, right: sorted[0] }];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    markers.push({ key: `m${i}`, x: (a.start + a.duration + b.start) / 2, left: a, right: b });
  }
  const last = sorted[sorted.length - 1];
  markers.push({ key: "end", x: last.start + last.duration, left: last, right: null });
  return markers;
}

const ROW_H = 34;
const MAX_ROWS = 3;
const TRANS_STRIP_H = 12; // ruang khusus di bawah tiap lane, tempat bar transisi hidup — tidak pernah menimpa bar klip

// Satu bar klip di linimasa, di-memo. Sama seperti <LayerRow>: karena reducer
// mempertahankan referensi objek klip yang tak berubah dan semua callback di
// sini stabil (useCallback), mengedit satu klip hanya me-render ulang barnya
// sendiri — bukan puluhan bar lain — sehingga linimasa tetap ringan saat
// banyak layer.
const TimelineClipBlock = React.memo(function TimelineClipBlock({ clip, row, color, timelineDuration, selected, onClipMouseDown, onDropTransition, onDelete }) {
  const blockStyle = {
    left: `${(clip.start / timelineDuration) * 100}%`,
    width: `${(clip.duration / timelineDuration) * 100}%`,
    top: row * ROW_H + 3,
    height: ROW_H - 6,
    background: `linear-gradient(180deg, ${color}55, ${color}22)`,
    borderColor: `${color}99`,
  };
  return (
    <div
      className={`mfs-clip-block ${selected ? "selected" : ""}`}
      style={blockStyle}
      onMouseDown={(e) => onClipMouseDown(e, clip, "move")}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/transition-id");
        if (id) onDropTransition(clip.id, id);
      }}
    >
      <div className="mfs-clip-handle left" onMouseDown={(e) => onClipMouseDown(e, clip, "resize-left")} />
      <div className="mfs-clip-body">
        <span className="mfs-clip-name">{clip.type === "text" ? (clip.text.split("\n")[0] || clip.name) : clip.name}</span>
      </div>
      <div className="mfs-clip-handle right" onMouseDown={(e) => onClipMouseDown(e, clip, "resize-right")} />
      {selected && (
        <button className="mfs-clip-del" onClick={(e) => { e.stopPropagation(); onDelete(clip.id); }}><Trash2 size={10} /></button>
      )}
    </div>
  );
});

function ClipTimeline({ project, playback, dispatchProject, dispatchPlayback, playClock }) {
  const trackRef = useRef(null);
  const playheadElRef = useRef(null);
  const tlDurRef = useRef(1);
  const laneElRef = useRef({});
  const topGhostRef = useRef(null);
  const bottomGhostRef = useRef(null);
  const [dragOverKey, setDragOverKey] = useState(null);
  const [openMarkerKey, setOpenMarkerKey] = useState(null);
  const [addTrackMenuOpen, setAddTrackMenuOpen] = useState(false);
  const [draggingClip, setDraggingClip] = useState(null); // clip.id sedang di-drag (untuk menampilkan zona ghost)
  const [dragHover, setDragHover] = useState(null); // { kind: 'track'|'ghost-top'|'ghost-bottom', trackId? }
  const timelineDuration = useMemo(() => computeTimelineDuration(project.clips), [project.clips]);
  tlDurRef.current = timelineDuration;

  // Saat memutar, geser garis playhead LANGSUNG lewat DOM tiap frame (tanpa
  // re-render React) — inilah yang membuat linimasa & preview tidak lagi
  // patah-patah saat diputar.
  useEffect(() => {
    if (!playClock) return;
    const fn = (v) => { const el = playheadElRef.current; if (el) el.style.left = `${(v / (tlDurRef.current || 1)) * 100}%`; };
    playClock.subs.add(fn);
    return () => playClock.subs.delete(fn);
  }, [playClock]);

  const pxToTime = (px, width) => clamp((px / width) * timelineDuration, 0, timelineDuration);
  const scrub = (clientX) => {
    const rect = trackRef.current.getBoundingClientRect();
    dispatchPlayback({ type: "SET_PLAYHEAD", value: pxToTime(clientX - rect.left, rect.width) });
  };
  const onRulerDown = (e) => {
    scrub(e.clientX);
    const move = (ev) => scrub(ev.clientX);
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };

  // Cek posisi Y kursor terhadap tiap lane / zona ghost yang ada, untuk tahu
  // track mana yang sedang "disasar" saat sebuah klip diseret naik/turun.
  const hitTestTrack = (clientY, clipType) => {
    if (topGhostRef.current) {
      const r = topGhostRef.current.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return { kind: "ghost-top" };
    }
    if (bottomGhostRef.current) {
      const r = bottomGhostRef.current.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return { kind: "ghost-bottom" };
    }
    for (const track of project.tracks) {
      const el = laneElRef.current[track.id];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        return track.type === clipType ? { kind: "track", trackId: track.id } : { kind: "invalid" };
      }
    }
    return null;
  };

  const startClipDrag = (e, clip, mode) => {
    e.stopPropagation();
    dispatchProject({ type: "SELECT_CLIP", id: clip.id });
    const rect = trackRef.current.getBoundingClientRect();
    const startMx = e.clientX, startMy = e.clientY;
    const startStart = clip.start, startDuration = clip.duration;
    // Jangan langsung menampilkan zona ghost "+ track baru" saat klip baru
    // di-mousedown (klik). Zona ghost (dan segala kemungkinan bikin track
    // baru) baru "aktif" setelah kursor benar-benar bergeser melewati
    // ambang batas kecil ini — jadi klik 1 kali (tanpa menyeret) untuk
    // sekadar memilih klip tidak pernah mengundang aksi bikin track baru.
    const DRAG_THRESHOLD = 4;
    let hasStartedDrag = false;
    let lastHover = null, lastStart = startStart;
    const move = (ev) => {
      const dxMs = ((ev.clientX - startMx) / rect.width) * timelineDuration;
      if (mode === "move") {
        if (!hasStartedDrag) {
          const moved = Math.hypot(ev.clientX - startMx, ev.clientY - startMy);
          if (moved < DRAG_THRESHOLD) return; // masih dianggap klik biasa, belum drag
          hasStartedDrag = true;
          setDraggingClip(clip.id);
        }
        lastStart = Math.max(0, Math.round(startStart + dxMs));
        dispatchProject({ type: "UPDATE_CLIP", id: clip.id, patch: { start: lastStart } });
        // Hanya mulai mendeteksi pindah-track setelah kursor benar-benar
        // bergeser vertikal, supaya klik-geser horizontal biasa tidak
        // tiba-tiba "melompat" track karena gerakan mouse yang sedikit oleng.
        if (Math.abs(ev.clientY - startMy) > 6) {
          lastHover = hitTestTrack(ev.clientY, clip.type);
          setDragHover(lastHover);
        }
      } else if (mode === "resize-right") {
        dispatchProject({ type: "UPDATE_CLIP", id: clip.id, patch: { duration: Math.max(150, Math.round(startDuration + dxMs)) } });
      } else if (mode === "resize-left") {
        const newStart = Math.max(0, Math.round(startStart + dxMs));
        const newDuration = Math.max(150, Math.round(startDuration - (newStart - startStart)));
        dispatchProject({ type: "UPDATE_CLIP", id: clip.id, patch: { start: newStart, duration: newDuration } });
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (mode === "move" && hasStartedDrag) {
        if (lastHover?.kind === "track" && lastHover.trackId !== clip.trackId) {
          dispatchProject({ type: "MOVE_CLIP_TO_TRACK", clipId: clip.id, trackId: lastHover.trackId, start: lastStart });
        } else if (lastHover?.kind === "ghost-top") {
          dispatchProject({ type: "ADD_TRACK_WITH_CLIP", trackId: uid("track"), trackType: clip.type, clipId: clip.id, start: lastStart, atStart: true });
        } else if (lastHover?.kind === "ghost-bottom") {
          dispatchProject({ type: "ADD_TRACK_WITH_CLIP", trackId: uid("track"), trackType: clip.type, clipId: clip.id, start: lastStart, atStart: false });
        }
        setDraggingClip(null);
        setDragHover(null);
      }
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };

  const applyTransitionToMarker = (marker, transitionId) => {
    if (marker.left) dispatchProject({ type: "APPLY_TRANSITION_SIDE", id: marker.left.id, side: "out", transitionId });
    if (marker.right) dispatchProject({ type: "APPLY_TRANSITION_SIDE", id: marker.right.id, side: "in", transitionId });
  };

  // Callback stabil untuk <TimelineClipBlock> yang di-memo (identitas tetap
  // antar-render), supaya mengedit satu klip tidak me-render ulang SEMUA bar
  // klip di linimasa — penyebab utama lag saat banyak layer.
  const startClipDragRef = useRef(() => {});
  startClipDragRef.current = startClipDrag;
  const onClipMouseDown = useCallback((e, clip, mode) => startClipDragRef.current(e, clip, mode), []);
  const onClipDropTransition = useCallback((clipId, transitionId) => dispatchProject({ type: "APPLY_TRANSITION_BOTH", id: clipId, transitionId }), [dispatchProject]);
  const onDeleteClip = useCallback((id) => dispatchProject({ type: "DELETE_CLIP", id }), [dispatchProject]);

  const ticks = useMemo(() => {
    const step = timelineDuration > 6000 ? 1000 : timelineDuration > 3000 ? 500 : 250;
    const arr = [];
    for (let t = 0; t <= timelineDuration; t += step) arr.push(t);
    return arr;
  }, [timelineDuration]);

  // Tiap track dihitung terpisah (bukan lagi digabung per jenis secara
  // global) — jadi bisa ada lebih dari satu track "Teks" atau "Video" dst,
  // masing-masing dengan susunan barisnya sendiri.
  const trackData = useMemo(() => {
    return project.tracks.map((track) => {
      const raw = project.clips.filter((c) => c.trackId === track.id);
      const isText = track.type === "text";
      const packed = isText ? packLaneRows(raw, MAX_ROWS) : raw.map((c) => ({ clip: c, row: 0 }));
      const rowsUsed = packed.reduce((m, p) => Math.max(m, p.row + 1), 1);
      const laneHeight = rowsUsed * ROW_H + TRANS_STRIP_H;
      return { track, clips: packed, rowsUsed, laneHeight, markers: laneMarkers(raw) };
    });
  }, [project.tracks, project.clips]);

  const addTrack = (trackType) => {
    setAddTrackMenuOpen(false);
    dispatchProject({ type: "ADD_TRACK", id: uid("track"), trackType });
  };

  // Baris klip & marker transisi ini secara visual TIDAK bergantung pada
  // playhead sama sekali — hanya elemen ".mfs-playhead" kecil di bawah yang
  // perlu ikut bergerak tiap tick playback. Tapi karena playback.playhead
  // diteruskan sebagai prop ke komponen ini, tiap tick (±20x/detik saat
  // memutar) memicu re-render penuh, dan tanpa memoisasi ini seluruh markup
  // klip/track di atas (dengan banyak handler drag & popover) ikut dibangun
  // ulang tiap tick juga — itulah sumber utama "tersendat" saat play.
  // Dengan useMemo di sini, blok berat ini hanya dihitung ulang saat data
  // klip/track atau state drag-nya benar-benar berubah, bukan tiap tick.
  const laneRows = useMemo(() => trackData.map(({ track, clips, laneHeight, markers }) => {
    const meta = TRACK_TYPES.find((t) => t.type === track.type);
    const color = meta?.color || trackColor(track.type);
    return (
      <div
        className={`mfs-lane ${dragHover?.kind === "track" && dragHover.trackId === track.id ? "track-over" : ""}`}
        key={track.id}
        style={{ height: laneHeight }}
        ref={(el) => { if (el) laneElRef.current[track.id] = el; else delete laneElRef.current[track.id]; }}
      >
        {clips.map(({ clip: c, row }) => (
          <TimelineClipBlock
            key={c.id}
            clip={c}
            row={row}
            color={color}
            timelineDuration={timelineDuration}
            selected={c.id === project.selectedClipId}
            onClipMouseDown={onClipMouseDown}
            onDropTransition={onClipDropTransition}
            onDelete={onDeleteClip}
          />
        ))}
        {markers.map((m) => {
          const mk = `${track.id}-${m.key}`;
          const outId = m.left?.transitionOutId;
          const inId = m.right?.transitionInId;
          const activeId = (outId && outId !== "none") ? outId : (inId && inId !== "none") ? inId : null;
          const activeTrans = activeId ? getTransition(activeId) : null;
          return (
            <div
              key={mk}
              className={`mfs-transition-bar ${activeTrans ? "active" : ""} ${dragOverKey === mk ? "over" : ""}`}
              style={{ left: `${(m.x / timelineDuration) * 100}%` }}
              title={activeTrans ? `Transisi: ${activeTrans.name} — klik untuk ganti/hapus, atau seret bar ini keluar linimasa untuk menghapus` : "Seret transisi dari panel kiri ke sini untuk memasang, atau klik untuk memilih"}
              draggable={!!activeTrans}
              onDragStart={(e) => {
                if (!activeTrans) { e.preventDefault(); return; }
                // Bar transisi yang sudah aktif ini sendiri bisa
                // diseret — memindahkannya ke sela lain akan
                // menerapkan transisi yang sama di sana, dan kalau
                // dilepas KELUAR linimasa (bukan di atas target drop
                // yang valid) akan menghapusnya dari sini.
                e.dataTransfer.setData("text/transition-id", activeTrans.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={(e) => {
                if (activeTrans && e.dataTransfer.dropEffect === "none") {
                  applyTransitionToMarker(m, "none");
                }
              }}
              onDragOver={(e) => e.preventDefault()}
              onDragEnter={() => setDragOverKey(mk)}
              onDragLeave={() => setDragOverKey((k) => (k === mk ? null : k))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverKey(null);
                const id = e.dataTransfer.getData("text/transition-id");
                if (id) applyTransitionToMarker(m, id);
              }}
              onClick={(e) => {
                e.stopPropagation();
                setOpenMarkerKey((k) => (k === mk ? null : mk));
              }}
            >
              <Wand size={11} color="#ff8fc4" />
              {openMarkerKey === mk && (
                <>
                  <div className="mfs-menu-backdrop" onClick={(e) => { e.stopPropagation(); setOpenMarkerKey(null); }} />
                  <div className="mfs-popover mfs-transition-popover" onClick={(e) => e.stopPropagation()}>
                    <div className="mfs-section-label" style={{ margin: "2px 6px 6px" }}>Transisi di Sela Ini</div>
                    {activeTrans && (
                      <div
                        className="mfs-popover-item mfs-popover-danger"
                        onClick={() => { applyTransitionToMarker(m, "none"); setOpenMarkerKey(null); }}
                      >
                        <X size={13} /> Hapus Transisi
                      </div>
                    )}
                    {TRANSITION_LIB.map((t) => (
                      <div
                        key={t.id}
                        className={`mfs-popover-item ${activeId === t.id ? "selected" : ""}`}
                        onClick={() => { applyTransitionToMarker(m, t.id); setOpenMarkerKey(null); }}
                      >
                        <Wand size={13} /> {t.name}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    );
  }), [trackData, timelineDuration, project.selectedClipId, dragHover, dragOverKey, openMarkerKey]);

  return (
    <div className="mfs-timeline">
      <div className="mfs-timeline-head">
        <span className="mfs-timeline-title">Linimasa — seret klip ke atas/bawah untuk pindah track, seret transisi ke sela klip</span>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ position: "relative" }}>
            <button className="mfs-btn mfs-btn-sm" onClick={() => setAddTrackMenuOpen((v) => !v)}><Plus size={12} /> Tambah Track</button>
            {addTrackMenuOpen && (
              <>
                <div className="mfs-menu-backdrop" onClick={() => setAddTrackMenuOpen(false)} />
                <div className="mfs-popover" style={{ top: 30, right: 0 }}>
                  {TRACK_TYPES.map((t) => (
                    <div key={t.type} className="mfs-popover-item" onClick={() => addTrack(t.type)}>
                      <t.icon size={13} /> {t.label}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <button className="mfs-btn mfs-btn-sm" onClick={() => dispatchProject({ type: "ADD_CLIP" })}><Plus size={12} /> Tambah Klip Teks</button>
        </div>
      </div>
      <div className="mfs-tracks-outer">
        <div className="mfs-track-labels">
          <div className="mfs-ruler-spacer" />
          {/* Placeholder ini menyamai tinggi zona ghost di kolom linimasa
              sebelah kanan, supaya label track tetap sejajar dengan lane-nya
              masing-masing saat zona ghost sedang muncul karena ada klip
              yang diseret. */}
          <div className={`mfs-track-ghost ${draggingClip ? "showing" : ""}`} />
          {trackData.map(({ track, laneHeight, clips }) => {
            const meta = TRACK_TYPES.find((t) => t.type === track.type);
            const empty = clips.length === 0;
            return (
              <div key={track.id} className="mfs-track-label" style={{ height: laneHeight }}>
                <span className="dot" style={{ background: meta?.color }} />
                <span className="label-text">{meta?.label}</span>
                {empty && (
                  <button className="mfs-track-del" title="Hapus track kosong ini" onClick={() => dispatchProject({ type: "DELETE_TRACK", id: track.id })}>
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            );
          })}
          <div className={`mfs-track-ghost ${draggingClip ? "showing" : ""}`} />
        </div>
        <div className="mfs-tracks-scroll" ref={trackRef}>
          <div className="mfs-ruler" onMouseDown={onRulerDown}>
            {ticks.map((t) => <div key={t} className="mfs-ruler-tick" style={{ left: `${(t / timelineDuration) * 100}%` }}>{(t / 1000).toFixed(1)}dtk</div>)}
          </div>

          {/* Zona kosong di paling atas — seret klip ke sini untuk membuat
              track baru di atas track yang sudah ada. Hanya "muncul" (punya
              tinggi) selagi ada klip sedang diseret. */}
          <div
            ref={topGhostRef}
            className={`mfs-track-ghost ${draggingClip ? "showing" : ""} ${dragHover?.kind === "ghost-top" ? "over" : ""}`}
          >
            {draggingClip && <span className="mfs-track-ghost-label">+ track baru di sini</span>}
          </div>

          {laneRows}

          {/* Zona kosong di paling bawah — sama seperti di atas, tapi untuk
              membuat track baru di bagian bawah daftar. */}
          <div
            ref={bottomGhostRef}
            className={`mfs-track-ghost ${draggingClip ? "showing" : ""} ${dragHover?.kind === "ghost-bottom" ? "over" : ""}`}
          >
            {draggingClip && <span className="mfs-track-ghost-label">+ track baru di sini</span>}
          </div>

          <div className="mfs-playhead" ref={playheadElRef} style={{ left: `${(playback.playhead / timelineDuration) * 100}%` }}><div className="mfs-playhead-flag" /></div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   TOP BAR & APP
   ============================================================ */

function FrameSizeControl({ frameSize, dispatch }) {
  const [open, setOpen] = useState(false);
  const isCustom = frameSize.presetId === "custom";
  const current = FRAME_PRESETS.find((p) => p.id === frameSize.presetId) || DEFAULT_FRAME;
  const CurrentIcon = current.icon || Settings2;

  return (
    <div className="mfs-frame-ctrl">
      <button
        type="button"
        className={`mfs-btn mfs-btn-sm mfs-frame-trigger ${open ? "active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Pilih ukuran frame"
      >
        <CurrentIcon size={13} />
        <span className="mfs-frame-dims">{frameSize.w}×{frameSize.h}px</span>
      </button>
      {open && (
        <>
          <div className="mfs-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="mfs-popover mfs-frame-popover">
            <div className="mfs-section-label" style={{ margin: "2px 6px 8px" }}>Ukuran Frame</div>
            {FRAME_PRESETS.map((p) => {
              const Icon = p.icon || Settings2;
              const selected = frameSize.presetId === p.id;
              return (
                <div
                  key={p.id}
                  className={`mfs-popover-item mfs-frame-option ${selected ? "selected" : ""}`}
                  onClick={() => dispatch({ type: "SET_FRAME_PRESET", presetId: p.id, w: p.w, h: p.h })}
                >
                  <Icon size={15} color={selected ? "var(--accent)" : "var(--text-dim)"} />
                  <span className="name">{p.name}</span>
                  {p.id !== "custom" && <span className="mfs-frame-dims">{p.w}×{p.h}</span>}
                </div>
              );
            })}
            {isCustom && (
              <div className="mfs-frame-custom-row">
                <input
                  type="number" className="mfs-input mfs-frame-num" min="16" max="4096"
                  value={frameSize.w}
                  onChange={(e) => dispatch({ type: "SET_FRAME_CUSTOM", patch: { w: Math.max(16, Number(e.target.value) || 16) } })}
                />
                <span style={{ color: "var(--text-dim)", fontSize: 11 }}>×</span>
                <input
                  type="number" className="mfs-input mfs-frame-num" min="16" max="4096"
                  value={frameSize.h}
                  onChange={(e) => dispatch({ type: "SET_FRAME_CUSTOM", patch: { h: Math.max(16, Number(e.target.value) || 16) } })}
                />
                <span className="mfs-frame-dims">px</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Menu "Proyek": Proyek Baru, Ekspor & Impor proyek ke file .json. Memakai
// props `project`/`dispatch` yang sudah diterima TopBar (tidak menambah prop
// baru, jadi tidak perlu mengubah pembanding React.memo TopBar).
function ProjectMenu({ project, dispatch }) {
  const [open, setOpen] = useState(false);
  const fileRef = useRef(null);

  const onNew = () => {
    setOpen(false);
    const ok = window.confirm(
      "Mulai proyek baru? Proyek yang sekarang akan diganti. Ekspor dulu bila ingin menyimpannya."
    );
    if (!ok) return;
    clearMotionProject();
    dispatch({ type: "HYDRATE_PROJECT", project: makeInitialProject() });
  };

  const onExport = async () => {
    setOpen(false);
    try {
      const data = await serializeProjectForExport(project);
      const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `motion-project-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      reportError("Gagal mengekspor proyek: " + (e?.message || e));
    }
  };

  const onImportPick = () => { setOpen(false); fileRef.current?.click(); };

  const onImportFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const proj = deserializeImportedProject(JSON.parse(text));
      (proj.fonts || []).forEach((f) => {
        if (f && f.family && f.buffer && !mfsFontRegistered(f.family)) {
          try {
            const face = new FontFace(f.family, f.buffer);
            face.load().then((loaded) => document.fonts.add(loaded)).catch(() => {});
          } catch (err) {}
        }
      });
      dispatch({ type: "HYDRATE_PROJECT", project: proj });
    } catch (err) {
      reportError("Gagal mengimpor proyek: " + (err?.message || err));
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        className="mfs-preview-btn"
        onClick={() => setOpen((o) => !o)}
        title="Kelola proyek (baru / ekspor / impor)"
      >
        <FolderOpen size={13} /> Proyek
      </button>
      {open && (
        <>
          <div className="mfs-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="mfs-popover" style={{ width: 208, left: 0, right: "auto" }}>
            <div className="mfs-popover-item" onClick={onNew}>
              <FilePlus2 size={14} /> Proyek Baru
            </div>
            <div className="mfs-popover-item" onClick={onExport}>
              <Download size={14} /> Ekspor Proyek (.json)
            </div>
            <div className="mfs-popover-item" onClick={onImportPick}>
              <Upload size={14} /> Impor Proyek (.json)
            </div>
          </div>
        </>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={onImportFile}
      />
    </div>
  );
}

const TopBar = React.memo(function TopBar({ project, dispatch, canUndo, canRedo, playback, exportState, onPreview, onExport, onAlign, theme, onToggleTheme }) {
  const mediaCount = project.clips.filter((c) => c.type !== "text").length;
  const { exporting, progress } = exportState;
  // Perataan OBJEK terhadap kanvas (posisi klip di frame) — aktif hanya saat
  // ada klip (teks/gambar/video) yang dipilih, bukan latar.
  const canAlign = !!project.clips.find((c) => c.id === project.selectedClipId);
  const alignBtn = (axis, where, Icon, rot, title) => (
    <button className="mfs-icon-btn" disabled={!canAlign} onClick={() => onAlign && onAlign(axis, where)} title={title}>
      <Icon size={14} style={rot ? { transform: `rotate(${rot}deg)` } : undefined} />
    </button>
  );
  return (
    <div className="mfs-top">
      <div className="mfs-top-left">
        <div className="mfs-brand"><div className="mfs-brand-mark"><Wand2 size={12} color="#fff" /></div>Motion Font Studio</div>
        <ModeTabs />
        <FrameSizeControl frameSize={project.frameSize} dispatch={dispatch} />
        <ProjectMenu project={project} dispatch={dispatch} />
      </div>
      <div className="mfs-top-right">
        <div className="mfs-align-group" title="Ratakan objek terpilih ke kanvas">
          {alignBtn("h", "start", AlignLeft, 0, "Rata kiri kanvas")}
          {alignBtn("h", "center", AlignCenter, 0, "Rata tengah horizontal")}
          {alignBtn("h", "end", AlignRight, 0, "Rata kanan kanvas")}
          <span className="mfs-align-div" />
          {alignBtn("v", "start", AlignLeft, 90, "Rata atas kanvas")}
          {alignBtn("v", "center", AlignCenter, 90, "Rata tengah vertikal")}
          {alignBtn("v", "end", AlignRight, 90, "Rata bawah kanvas")}
        </div>
        <div className="mfs-top-sep" />
        <span className="mfs-top-info">{project.clips.length} klip ({mediaCount} media) · {project.fonts.length} font diunggah</span>
        <button
          className="mfs-icon-btn mfs-theme-toggle"
          onClick={onToggleTheme}
          title={theme === "light" ? "Ganti ke mode gelap" : "Ganti ke mode terang"}
        >
          {theme === "light" ? <MoonStar size={14} /> : <Sun size={14} />}
        </button>
        <div className="mfs-top-sep" />
        <button className="mfs-icon-btn" disabled={!canUndo} onClick={() => dispatch({ type: "UNDO" })} title="Undo (Ctrl+Z)"><Undo2 size={15} /></button>
        <button className="mfs-icon-btn" disabled={!canRedo} onClick={() => dispatch({ type: "REDO" })} title="Redo (Ctrl+Shift+Z)"><Redo2 size={15} /></button>
        <div className="mfs-top-sep" />
        <button className={`mfs-preview-btn ${playback.previewOpen ? "active" : ""}`} disabled={exporting} onClick={onPreview} title="Pratinjau hasil di kanvas">
          {playback.previewOpen ? <Pause size={13} /> : <Eye size={13} />} {playback.previewOpen ? "Jeda" : "Preview"}
        </button>
        <button className="mfs-export-btn" disabled={exporting} onClick={onExport} title="Ekspor jadi file video">
          {exporting ? <Loader2 size={13} className="mfs-spin" /> : <Clapperboard size={13} />} {exporting ? `Mengekspor ${progress}%` : "Ekspor Video"}
        </button>
      </div>
    </div>
  );
}, (prev, next) => (
  prev.project === next.project &&
  prev.dispatch === next.dispatch &&
  prev.canUndo === next.canUndo &&
  prev.canRedo === next.canRedo &&
  prev.exportState === next.exportState &&
  prev.onPreview === next.onPreview &&
  prev.onExport === next.onExport &&
  prev.theme === next.theme &&
  prev.onToggleTheme === next.onToggleTheme &&
  // Sengaja TIDAK membandingkan seluruh objek `playback` (yang berganti
  // referensi tiap tick playhead, ±20x/detik saat memutar) — TopBar cuma
  // butuh tahu status buka/tutupnya panel preview, bukan posisi playhead.
  // Tanpa perbandingan khusus ini, tiap tick akan tetap memicu re-render
  // TopBar meski tak ada yang berubah secara visual di sana.
  prev.playback.previewOpen === next.playback.previewOpen
));

function ToastStack() {
  const { toasts, dismiss } = useErrorToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="mfs-toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className="mfs-toast" onClick={() => dismiss(t.id)}>
          <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{t.msg}{t.count > 1 ? ` (×${t.count})` : ""}</span>
        </div>
      ))}
    </div>
  );
}

// Apakah sebuah font-family sudah terdaftar di document.fonts — supaya kita
// tidak mendaftarkan FontFace yang sama dua kali saat proyek dipulihkan.
function mfsFontRegistered(family) {
  try {
    for (const ff of document.fonts) { if (ff.family === family) return true; }
  } catch (e) {}
  return false;
}

export default function App() {
  const [history, dispatchProject] = useReducer(historyReducer, initialHistoryState);
  const [playback, dispatchPlayback] = useReducer(playbackReducer, initialPlayback);
  const [exportState, setExportState] = useState({ exporting: false, progress: 0 });
  const project = history.present;
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  const centerStageRef = useRef(null);

  // "Jam" playback bersama (objek stabil). Saat memutar, loop rAF di
  // CenterStage memberi tahu pelanggan (indikator playhead di linimasa)
  // LANGSUNG lewat DOM tiap frame — TANPA dispatch React tiap tick. Ini kunci
  // perbaikan "preview patah-patah": sebelumnya tiap ~50ms seluruh pohon
  // komponen di-render ulang (20x/detik) dan bersaing dengan penggambaran
  // kanvas, bikin frame tersendat di perangkat yang tak sekencang ini.
  const playClockRef = useRef(null);
  if (!playClockRef.current) {
    playClockRef.current = {
      subs: new Set(),
      notify(v) { this.subs.forEach((fn) => { try { fn(v); } catch (e) {} }); },
    };
  }
  const playClock = playClockRef.current;

  // Mode terang/gelap — disimpan supaya pilihan pengguna tetap dipakai di
  // kunjungan berikutnya. Dibungkus try/catch karena localStorage bisa saja
  // tidak tersedia tergantung lingkungan tempat app ini dijalankan.
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("mfs-theme") === "light" ? "light" : "dark"; } catch (e) { return "dark"; }
  });
  useEffect(() => {
    try { localStorage.setItem("mfs-theme", theme); } catch (e) {}
  }, [theme]);
  const toggleTheme = useCallback(() => setTheme((t) => (t === "light" ? "dark" : "light")), []);

  // --- Simpan & muat proyek otomatis (IndexedDB) --------------------------
  // Sejajar dengan sisi Font: proyek Motion otomatis tersimpan tiap kali
  // berubah, dan otomatis dipulihkan saat app dibuka lagi. Media menyembuhkan
  // diri lewat File cadangan; font didaftarkan ulang dari buffer-nya di sini.
  const mfsHydratedRef = useRef(false);
  const mfsSaveTimer = useRef(null);

  useEffect(() => {
    let cancelled = false;
    loadMotionProject()
      .then((saved) => {
        if (cancelled) return;
        if (saved) {
          (saved.fonts || []).forEach((f) => {
            if (f && f.family && f.buffer && !mfsFontRegistered(f.family)) {
              try {
                const face = new FontFace(f.family, f.buffer);
                face.load().then((loaded) => document.fonts.add(loaded)).catch(() => {});
              } catch (e) {}
            }
          });
          dispatchProject({ type: "HYDRATE_PROJECT", project: saved });
        }
        mfsHydratedRef.current = true;
      })
      .catch(() => { mfsHydratedRef.current = true; });
    return () => { cancelled = true; };
  }, []);

  // Simpan (debounce) tiap kali proyek berubah — tapi hanya setelah proses
  // pemulihan awal selesai, supaya tidak menimpa simpanan dengan state kosong.
  useEffect(() => {
    if (!mfsHydratedRef.current) return;
    if (mfsSaveTimer.current) clearTimeout(mfsSaveTimer.current);
    mfsSaveTimer.current = setTimeout(() => { saveMotionProject(project); }, 400);
  }, [project]);

  // Flush simpanan saat tab disembunyikan/ditutup agar reload cepat tak
  // kehilangan perubahan terakhir.
  useEffect(() => {
    const flush = () => { if (mfsHydratedRef.current) saveMotionProject(project); };
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, [project]);

  // Panel aktif di mode HP/tablet kecil (bottom sheet). null = kanvas penuh.
  const [mobilePane, setMobilePane] = useState(null);
  const toggleMobilePane = useCallback((p) => setMobilePane((cur) => (cur === p ? null : p)), []);

  // Pintasan keyboard global: Ctrl/Cmd+Z untuk undo, Ctrl/Cmd+Shift+Z (atau
  // Ctrl+Y) untuk redo — dilewati kalau fokus sedang di input/textarea,
  // supaya tidak menabrak undo bawaan browser saat mengetik teks.
  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = e.target?.tagName;
      const isEditable = tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable;
      if (isEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "z" && e.shiftKey) { e.preventDefault(); dispatchProject({ type: "REDO" }); }
      else if (e.key.toLowerCase() === "z") { e.preventDefault(); dispatchProject({ type: "UNDO" }); }
      else if (e.key.toLowerCase() === "y") { e.preventDefault(); dispatchProject({ type: "REDO" }); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <ErrorBoundary>
      <div className="mfs-root" data-theme={theme} data-mpane={mobilePane || "none"}>
        <GlobalStyle />
        <TopBar
          project={project}
          dispatch={dispatchProject}
          canUndo={canUndo}
          canRedo={canRedo}
          playback={playback}
          exportState={exportState}
          onPreview={() => centerStageRef.current?.togglePreview()}
          onExport={() => centerStageRef.current?.exportVideo()}
          onAlign={(axis, where) => centerStageRef.current?.alignSelected(axis, where)}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        <LayersPanel project={project} dispatch={dispatchProject} />
        <LeftPanel project={project} dispatch={dispatchProject} />
        <CenterStage
          ref={centerStageRef}
          project={project}
          playback={playback}
          dispatchProject={dispatchProject}
          dispatchPlayback={dispatchPlayback}
          exportState={exportState}
          setExportState={setExportState}
          playClock={playClock}
        />
        <RightInspector project={project} dispatch={dispatchProject} />
        <ClipTimeline project={project} playback={playback} dispatchProject={dispatchProject} dispatchPlayback={dispatchPlayback} playClock={playClock} />
        {mobilePane && <div className="mfs-mobile-backdrop" onClick={() => setMobilePane(null)} />}
        <nav className="mfs-mobile-nav">
          <button className={mobilePane === "layers" ? "active" : ""} onClick={() => toggleMobilePane("layers")}><LayoutGrid size={18} /><span>Layer</span></button>
          <button className={mobilePane === "left" ? "active" : ""} onClick={() => toggleMobilePane("left")}><Sparkles size={18} /><span>Kreasi</span></button>
          <button className={mobilePane === "right" ? "active" : ""} onClick={() => toggleMobilePane("right")}><Settings2 size={18} /><span>Atur</span></button>
        </nav>
        <ToastStack />
      </div>
    </ErrorBoundary>
  );
}
