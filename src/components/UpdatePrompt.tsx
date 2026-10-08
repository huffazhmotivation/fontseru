import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { isDesktopApp } from "@/lib/desktop";

/*
 * Alur pembaruan aplikasi (browser biasa MAUPUN PWA "Add to Home Screen").
 *
 * DETEKSI — dua sumber, salah satu cukup:
 *  1. Service worker baru sudah terpasang & menunggu (registration.waiting).
 *  2. /version.json di server berisi ID build yang berbeda dari build yang
 *     sedang berjalan (__APP_BUILD_ID__, lihat vite.config.ts). Ini jaring
 *     pengaman untuk perangkat yang service worker-nya lambat/macet cek
 *     update (umum di PWA iOS), jadi pengguna lama tetap tahu ada versi baru.
 *  Dicek saat dibuka, tiap CHECK_INTERVAL_MS, dan tiap kali tab/app kembali
 *  terlihat atau fokus.
 *
 * DIBUKA ULANG = OTOMATIS DIPERBARUI — kalau pembaruan ketahuan dalam
 *  BOOT_WINDOW_MS pertama sejak halaman dimuat (app baru dibuka, belum ada
 *  pekerjaan yang sedang diedit), langsung diterapkan tanpa bertanya.
 *  Di luar jendela itu, muncul popup di tengah layar.
 *
 * ANTI MACET "MUAT ULANG TERUS" —
 *  - Tiap percobaan dicatat di sessionStorage (GUARD_KEY). Percobaan ke-2
 *    dalam GUARD_WINDOW_MS langsung memakai jalur "bersih total" (hapus
 *    service worker + cache lalu muat dari jaringan). Setelah itu TIDAK ada
 *    lagi muat ulang otomatis; popup tampil dan pengguna yang memutuskan.
 *  - Menunggu service worker baru aktif dibatasi waktu; kalau lewat, pindah
 *    ke jalur bersih total, bukan menunggu selamanya.
 *  - Reload hanya dipicu sekali per percobaan (flag reloadingRef).
 */

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const BOOT_WINDOW_MS = 15 * 1000;
const SNOOZE_MS = 15 * 60 * 1000;
const GUARD_KEY = "fs-update-guard";
const GUARD_WINDOW_MS = 3 * 60 * 1000;
const BUST_PARAM = "_fsu";
const IS_DEV = __APP_BUILD_ID__ === "dev";

// Menjawab "ping" dari service worker (public/sw-migrate.js). Tab yang
// menjawab = kode baru ini, jadi SW tidak memuat ulang tab ini secara paksa;
// popup di bawah yang mengurus pembaruannya. Dipasang di tingkat modul
// (bukan di dalam komponen) supaya sudah siap sejak halaman mulai jalan.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "FS_BUILD_PING") event.ports?.[0]?.postMessage({ build: __APP_BUILD_ID__ });
  });
  // addEventListener (beda dengan onmessage) tidak otomatis membuka antrean pesan.
  navigator.serviceWorker.startMessages?.();
}

type Phase = "idle" | "available" | "updating" | "failed";
type Guard = { at: number; tries: number };

function readGuard(): Guard | null {
  try {
    const g = JSON.parse(sessionStorage.getItem(GUARD_KEY) || "null") as Guard | null;
    return g && Date.now() - g.at < GUARD_WINDOW_MS ? g : null;
  } catch {
    return null;
  }
}
function writeGuard(g: Guard | null) {
  try {
    if (g) sessionStorage.setItem(GUARD_KEY, JSON.stringify(g));
    else sessionStorage.removeItem(GUARD_KEY);
  } catch {
    /* mode privat / storage diblokir — penjaga cukup di memori */
  }
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, sleep(ms).then(() => undefined)]);
}

async function fetchServerBuild(): Promise<string | null> {
  if (IS_DEV) return null;
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.build === "string" ? data.build : null;
  } catch {
    return null; // offline, atau hosting mengembalikan index.html
  }
}

// Menunggu service worker yang sedang terpasang selesai (jadi "waiting").
function waitForInstalled(reg: ServiceWorkerRegistration, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const sw = reg.installing;
    if (!sw) return resolve();
    const done = () => { sw.removeEventListener("statechange", onState); resolve(); };
    const onState = () => { if (sw.state !== "installing") done(); };
    sw.addEventListener("statechange", onState);
    window.setTimeout(done, ms);
  });
}

export function UpdatePrompt() {
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const reloadingRef = useRef(false);
  const applyingRef = useRef(false);
  const snoozeUntilRef = useRef(0);
  const controllerChangedRef = useRef(false);
  const setPhaseBoth = (p: Phase) => { phaseRef.current = p; setPhase(p); };

  const reloadOnce = useCallback((bust: boolean) => {
    if (reloadingRef.current) return;
    reloadingRef.current = true;
    if (bust) {
      // Parameter unik memaksa index.html diambil ulang dari server, bukan
      // dari cache HTTP browser/CDN. Dihapus lagi dari URL setelah dimuat.
      const url = new URL(window.location.href);
      url.searchParams.set(BUST_PARAM, Date.now().toString(36));
      window.location.replace(url.toString());
    } else {
      window.location.reload();
    }
  }, []);

  // Jalur bersih total: lepas semua service worker + hapus semua cache lalu
  // muat dari jaringan. Selalu berhasil mengambil versi terbaru.
  const hardRefresh = useCallback(async () => {
    applyingRef.current = true;
    // Setiap langkah dibatasi waktu: unregister()/caches.delete() kadang
    // menggantung (mis. saat service worker lama masih memproses sesuatu),
    // dan itulah yang membuat popup berputar tanpa akhir. Apa pun yang
    // terjadi, ujungnya tetap muat ulang dari jaringan.
    try {
      const regs = (await withTimeout(navigator.serviceWorker?.getRegistrations?.() ?? Promise.resolve([]), 2500)) || [];
      await withTimeout(Promise.all(regs.map((r) => r.unregister().catch(() => false))), 2500);
    } catch { /* abaikan */ }
    try {
      if ("caches" in window) {
        const keys = (await withTimeout(caches.keys(), 2500)) || [];
        await withTimeout(Promise.all(keys.map((k) => caches.delete(k))), 3000);
      }
    } catch { /* abaikan */ }
    reloadOnce(true);
  }, [reloadOnce]);

  const applyUpdate = useCallback(async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    setPhaseBoth("updating");
    // Pengaman terakhir: kalau 9 dtk kemudian halaman belum berpindah,
    // paksa muat ulang dari jaringan (jangan pernah berputar selamanya).
    window.setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.set(BUST_PARAM, Date.now().toString(36));
      window.location.replace(url.toString());
    }, 9000);
    const prev = readGuard();
    const tries = (prev?.tries || 0) + 1;
    writeGuard({ at: Date.now(), tries });

    // Service worker baru sudah aktif (diterapkan dari tab lain) → cukup muat ulang.
    if (controllerChangedRef.current && tries === 1) { reloadOnce(true); return; }
    // Percobaan sebelumnya belum berhasil → langsung jalur bersih total.
    if (tries >= 2) { await hardRefresh(); return; }

    // Jalur cepat: service worker baru sudah menunggu → aktifkan & muat ulang
    // (biasanya < 1 dtk). Tanpa itu, atau bila tidak bereaksi dalam 2,5 dtk,
    // langsung jalur bersih total — tidak ada lagi menunggu 6–15 dtk.
    try {
      const reg = registrationRef.current || (await withTimeout(navigator.serviceWorker?.getRegistration?.() ?? Promise.resolve(undefined), 1500)) || null;
      const waiting = reg?.waiting;
      if (waiting && navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener("controllerchange", () => reloadOnce(false), { once: true });
        waiting.postMessage({ type: "SKIP_WAITING" });
        await sleep(2500);
        if (reloadingRef.current) return;
      }
    } catch { /* jatuh ke jalur bersih total */ }
    if (!reloadingRef.current) await hardRefresh();
  }, [hardRefresh, reloadOnce]);

  const {
    needRefresh: [needRefresh],
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      registrationRef.current = registration ?? null;
      registration?.update().catch(() => {});
    },
    onRegisterError(error) {
      // Aplikasi desktop memakai skema app:// yang memang tidak mendukung service worker — bukan error.
      if (isDesktopApp) return;
      console.error("Service worker registration failed:", error);
    },
  });

  const check = useCallback(async () => {
    if (IS_DEV || applyingRef.current || reloadingRef.current) return;
    const reg = registrationRef.current;
    reg?.update().catch(() => {});
    const serverBuild = await fetchServerBuild();
    const outdated = !!serverBuild && serverBuild !== __APP_BUILD_ID__;
    const swWaiting = !!reg?.waiting;
    const available = outdated || swWaiting || controllerChangedRef.current;

    if (!available) {
      if (serverBuild === __APP_BUILD_ID__) writeGuard(null); // sudah versi terbaru
      if (phaseRef.current === "available" || phaseRef.current === "failed") setPhaseBoth("idle");
      return;
    }
    const guard = readGuard();
    const booting = performance.now() < BOOT_WINDOW_MS;
    // Baru dibuka & belum pernah mencoba 2× → perbarui otomatis.
    if (booting && (!guard || guard.tries < 2)) { void applyUpdate(); return; }
    if (Date.now() < snoozeUntilRef.current) return;
    if (guard && guard.tries >= 2) { if (phaseRef.current !== "updating") setPhaseBoth("failed"); return; }
    if (phaseRef.current === "idle") setPhaseBoth("available");
  }, [applyUpdate]);

  // Service worker menandai ada versi baru yang menunggu.
  useEffect(() => { if (needRefresh) void check(); }, [needRefresh, check]);

  useEffect(() => {
    // Bersihkan parameter pemaksa-refresh dari URL setelah berhasil dimuat.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has(BUST_PARAM)) {
        url.searchParams.delete(BUST_PARAM);
        window.history.replaceState(window.history.state, "", url.toString());
      }
    } catch { /* abaikan */ }

    void check();
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    // Tab lain sudah mengaktifkan service worker baru — halaman ini masih
    // kode lama, jadi minta dimuat ulang (kecuali kita sendiri yang memicu).
    // PENTING: pada kunjungan pertama (atau setelah jalur bersih total)
    // halaman belum dikontrol service worker mana pun, lalu SW yang baru
    // terpasang mengambil alih (clientsClaim) dan memicu controllerchange
    // juga. Itu BUKAN pembaruan — kalau dianggap pembaruan, halaman akan
    // muat ulang terus. Jadi hanya dihitung bila sebelumnya sudah ada SW.
    let hadController = !!navigator.serviceWorker?.controller;
    const onControllerChange = () => {
      if (!hadController) { hadController = true; return; }
      if (applyingRef.current || reloadingRef.current) return;
      controllerChangedRef.current = true;
      void check();
    };
    const interval = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onVisible);
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onVisible);
      navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
    };
  }, [check]);

  if (phase === "idle") return null;

  const updating = phase === "updating";
  const failed = phase === "failed";

  return (
    <div className="fm-update-backdrop" role="presentation">
      <div
        className="fm-update-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fm-update-title"
        aria-describedby="fm-update-desc"
      >
        <div className="fm-update-icon" aria-hidden="true">
          {updating ? <Loader2 size={22} className="fm-update-spin" /> : <Sparkles size={22} />}
        </div>
        <h2 id="fm-update-title">
          {updating ? "Memperbarui FontSeru…" : failed ? "Pembaruan belum terpasang" : "Versi baru tersedia"}
        </h2>
        <p id="fm-update-desc">
          {updating
            ? "Sebentar, versi terbaru sedang dimuat. Halaman akan terbuka ulang otomatis."
            : failed
              ? "Pembaruan otomatis belum berhasil. Tekan tombol di bawah untuk membersihkan cache dan memuat versi terbaru."
              : "Ada pembaruan FontSeru. Muat ulang sekarang untuk memakai fitur dan perbaikan terbaru."}
        </p>
        {updating && (
          <div className="fm-update-actions">
            <button type="button" className="fm-update-later" onClick={() => { void hardRefresh(); }} data-testid="update-force-btn">
              Tidak bergerak? Muat ulang paksa
            </button>
          </div>
        )}
        {!updating && (
          <div className="fm-update-actions">
            <button
              type="button"
              className="fm-action-btn accent"
              onClick={() => {
                if (!failed) { void applyUpdate(); return; }
                setPhaseBoth("updating");
                void hardRefresh();
              }}
              data-testid="update-sw-btn"
            >
              <RefreshCw size={14} strokeWidth={2.25} aria-hidden="true" />
              Muat ulang sekarang
            </button>
            <button
              type="button"
              className="fm-update-later"
              onClick={() => { snoozeUntilRef.current = Date.now() + SNOOZE_MS; setPhaseBoth("idle"); }}
            >
              Nanti saja
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
