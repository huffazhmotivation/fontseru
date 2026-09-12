/* ==========================================================================
   Penyimpanan proyek Mode Motion (IndexedDB)

   Menyimpan SATU proyek kerja Motion Font Studio dan memulihkannya otomatis
   saat app dibuka lagi — sejajar dengan cara sisi Font menyimpan glyph-nya.

   Kenapa IndexedDB (bukan localStorage): proyek Motion bisa memuat File
   media (gambar/video/audio) dan ArrayBuffer font. IndexedDB menyimpannya
   apa adanya lewat "structured clone", jadi File/Blob/ArrayBuffer tetap utuh
   setelah reload. (localStorage hanya menyimpan string dan akan cepat penuh.)

   Catatan pemulihan media: klip media menyimpan blob: URL untuk digambar dan
   File aslinya sebagai cadangan. blob: URL mati setelah reload, tapi pemuat
   media di MotionStudio otomatis jatuh-balik membaca ulang File cadangan itu
   jadi data URL — jadi media tetap muncul. Font didaftarkan ulang dari
   buffer-nya di MotionStudio saat proyek dimuat.
   ========================================================================== */

const DB_NAME = "mfs-motion";
const STORE = "project";
const KEY = "current";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB tidak tersedia"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Gagal membuka database"));
  });
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
    db.close();
  } catch (e) {
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
    db.close();
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
  return { ...root, fonts };
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
    });
    db.close();
  } catch (e) {
    /* abaikan */
  }
}
