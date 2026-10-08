/* ==========================================================================
   Penyimpanan proyek Mode Motion (IndexedDB)

   Menyimpan SATU proyek kerja Motion Font Studio dan memulihkannya otomatis
   saat app dibuka lagi — sejajar dengan cara sisi Font menyimpan glyph-nya.

   Kenapa IndexedDB (bukan localStorage): proyek Motion bisa memuat File
   media (gambar/video/audio) dan ArrayBuffer font. IndexedDB menyimpannya
   apa adanya lewat "structured clone", jadi File/Blob/ArrayBuffer tetap utuh
   setelah reload. (localStorage hanya menyimpan string dan akan cepat penuh.)

   Catatan pemulihan media: klip media menyimpan blob: URL untuk digambar dan
   File aslinya sebagai cadangan. blob: URL mati setelah reload, jadi saat
   proyek dipulihkan MotionStudio membuat blob: URL baru dari File tersimpan
   (reviveMediaObjectUrls) — jalur data URL hanya tersisa sebagai cadangan. Font didaftarkan ulang dari
   buffer-nya di MotionStudio saat proyek dimuat.
   ========================================================================== */

const DB_NAME = "mfs-motion";
const STORE = "project";
const KEY = "current";
const DB_VERSION = 1;

// Koneksi IndexedDB di-cache: simpan otomatis bisa terjadi berkali-kali per
// menit, jadi membuka/menutup database tiap kali hanya menambah latensi.
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB tidak tersedia"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Lepas cache bila koneksi ditutup browser / ada upgrade dari tab lain.
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { try { db.close(); } catch (e) {} dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error("Gagal membuka database"));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

/**
 * Simpan proyek Motion (objek history.present). Dibungkus try/catch di
 * pemanggil; di sini pun kegagalan tidak dilempar ke UI — cukup dilewati
 * supaya proses simpan otomatis tak pernah mengganggu pengeditan.
 */
export async function saveMotionProject(project) {
  if (!project) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(project, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    dbPromise = null; // koneksi mungkin basi — buka ulang lain kali
    /* abaikan kegagalan penyimpanan */
  }
}

/**
 * Muat proyek Motion tersimpan, atau null bila belum ada / gagal.
 */
export async function loadMotionProject() {
  try {
    const db = await openDb();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    return result || null;
  } catch (e) {
    return null;
  }
}

/* ==========================================================================
   EKSPOR / IMPOR proyek ke file .json portabel

   File auto-save di atas hanya hidup di satu browser. Untuk mem-backup atau
   memindah proyek ke komputer lain, proyek diekspor jadi SATU file .json yang
   mandiri: media (gambar/video/audio) dan buffer font diubah jadi base64/data
   URL di dalam file, jadi tidak ada ketergantungan ke file luar.
   ========================================================================== */

function abToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64ToAb(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("Gagal membaca file"));
    r.readAsDataURL(blob);
  });
}

// Ubah sumber media apa pun (data: / blob: / File cadangan) jadi data URL yang
// bisa ditanam ke file ekspor.
async function srcToDataUrl(src, file) {
  if (typeof src === "string" && src.startsWith("data:")) return src;
  if (file) {
    try { return await blobToDataUrl(file); } catch (e) {}
  }
  if (typeof src === "string" && src.startsWith("blob:")) {
    try {
      const resp = await fetch(src);
      const blob = await resp.blob();
      return await blobToDataUrl(blob);
    } catch (e) {}
  }
  return src; // biarkan apa adanya (mis. URL biasa)
}

async function embedAsset(a) {
  const x = { ...a };
  delete x.file;
  x.src = await srcToDataUrl(a.src, a.file);
  return x;
}

/**
 * Bangun objek JSON-safe yang mandiri dari proyek Motion untuk diunduh.
 */
export async function serializeProjectForExport(project) {
  const clips = await Promise.all((project.clips || []).map(async (c) => {
    const clip = { ...c };
    delete clip.file;
    if (c.type === "image" || c.type === "video" || c.type === "audio") {
      clip.src = await srcToDataUrl(c.src, c.file);
    }
    return clip;
  }));

  const lib = project.library || { images: [], videos: [], audios: [] };
  const library = {
    images: await Promise.all((lib.images || []).map(embedAsset)),
    videos: await Promise.all((lib.videos || []).map(embedAsset)),
    audios: await Promise.all((lib.audios || []).map(embedAsset)),
  };

  const fonts = (project.fonts || []).map((f) => ({
    family: f.family,
    name: f.name,
    bufferB64: f.buffer ? abToB64(f.buffer) : null,
  }));

  const background = { ...(project.background || {}) };
  if (background.imageSrc) background.imageSrc = await srcToDataUrl(background.imageSrc, null);

  return {
    __fontseruMotion: true,
    version: 1,
    exportedAt: new Date().toISOString(),
    project: { ...project, clips, library, fonts, background },
  };
}

/**
 * Rekonstruksi proyek dari objek JSON hasil impor. Buffer font dikembalikan
 * jadi ArrayBuffer (pendaftaran FontFace dilakukan di pemanggil); media sudah
 * berupa data URL sehingga langsung bisa dirender. Melempar error bila format
 * tidak dikenali.
 */
export function deserializeImportedProject(data) {
  const root = data && data.project ? data.project : data;
  if (!root || !Array.isArray(root.clips)) {
    throw new Error("Format file proyek tidak dikenali.");
  }
  const fonts = (root.fonts || []).map((f) => ({
    family: f.family,
    name: f.name,
    buffer: f.bufferB64 ? b64ToAb(f.bufferB64) : (f.buffer || null),
  }));
  // Media di file ekspor berupa data URL base64. Data URL besar (video!)
  // lambat didekode & boros memori kalau dipakai langsung sebagai src, jadi
  // ubah jadi File + blob: URL. File-nya juga ikut tersimpan di IndexedDB,
  // jadi setelah reload src bisa dibuat ulang dari situ. SVG sengaja tidak
  // diubah (pewarnaan ulang SVG bekerja dengan data URL).
  const blobCache = new Map();
  const toBlobMedia = (item) => {
    if (!item || item.isSvg || typeof item.src !== "string" || !item.src.startsWith("data:")) return item;
    let hit = blobCache.get(item.src);
    if (!hit) {
      const file = dataUrlToFile(item.src, item.name);
      if (!file) return item;
      let url = null;
      try { url = URL.createObjectURL(file); } catch (e) { return item; }
      hit = { file, url };
      blobCache.set(item.src, hit);
    }
    return { ...item, src: hit.url, file: hit.file };
  };
  const clips = root.clips.map((c) => (c && (c.type === "image" || c.type === "video" || c.type === "audio") ? toBlobMedia(c) : c));
  const lib = root.library;
  const library = lib ? {
    ...lib,
    images: (lib.images || []).map(toBlobMedia),
    videos: (lib.videos || []).map(toBlobMedia),
    audios: (lib.audios || []).map(toBlobMedia),
  } : lib;
  // Normalisasi: project yang dibuat sebelum fitur transition slots
  // mungkin belum punya array transitions — inisialisasi sebagai [].
  return { ...root, clips, library, fonts, transitions: Array.isArray(root.transitions) ? root.transitions : [] };
}

// data:[mime][;base64],payload → File (atau Blob). null bila gagal.
function dataUrlToFile(dataUrl, name) {
  try {
    if (typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    const meta = dataUrl.slice(5, comma);
    const isB64 = /;base64/i.test(meta);
    const mime = meta.split(";")[0] || "application/octet-stream";
    const payload = dataUrl.slice(comma + 1);
    const bytes = isB64 ? new Uint8Array(b64ToAb(payload)) : new TextEncoder().encode(decodeURIComponent(payload));
    if (typeof File === "function") {
      try { return new File([bytes], name || "media", { type: mime }); } catch (e) {}
    }
    return new Blob([bytes], { type: mime });
  } catch (e) {
    return null;
  }
}

/**
 * Hapus proyek tersimpan (dipakai oleh tombol "Proyek Baru").
 */
export async function clearMotionProject() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    /* abaikan */
  }
}
