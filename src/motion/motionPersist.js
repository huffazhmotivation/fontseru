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

/**
 * Hapus proyek tersimpan (dipakai bila nanti ada tombol "Proyek Baru").
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
