/*
 * Di-import oleh service worker hasil build (lihat workbox.importScripts di
 * vite.config.ts).
 *
 * MASALAH yang diperbaiki: di versi lama FontSeru, tombol "Perbarui
 * sekarang" pada toast pojok kanan mengirim SKIP_WAITING dan service worker
 * baru memang aktif — tapi halaman lama hanya reload kalau pembaruan itu
 * terdeteksi SELAMA halaman terbuka. Kalau versi baru sudah terunduh
 * sebelum app dibuka (kasus paling umum), halaman tidak pernah reload,
 * jadi tombol terasa "tidak bereaksi". Kode lama di perangkat pengguna
 * tidak bisa diubah, tapi service worker baru ini bisa.
 *
 * SOLUSI: saat service worker ini aktif, setiap tab di-"ping". Tab dengan
 * kode baru (UpdatePrompt.tsx) menjawab dan mengurus pembaruannya sendiri
 * (popup di tengah). Tab yang TIDAK menjawab = kode lama → dimuat ulang
 * dari sini ke versi terbaru. Aktivasi hanya terjadi setelah pengguna
 * menekan tombol perbarui, atau saat tidak ada tab lama yang terbuka, jadi
 * tidak ada tab yang dimuat ulang tanpa diminta.
 */
const FS_PING_TIMEOUT_MS = 1200;

function fsPing(client) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => finish(true);
      client.postMessage({ type: "FS_BUILD_PING" }, [ch.port2]);
    } catch (e) {
      finish(false);
    }
    setTimeout(() => finish(false), FS_PING_TIMEOUT_MS);
  });
}

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!clients.length) return;
    await self.clients.claim(); // navigate() hanya boleh untuk tab yang dikontrol SW ini
    await Promise.all(clients.map(async (client) => {
      const isNewCode = await fsPing(client);
      if (isNewCode) return;
      try { await client.navigate(client.url); } catch (e) { /* tab sudah tertutup */ }
    }));
  })());
});
