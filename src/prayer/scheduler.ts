/* Pengingat sholat: 5 menit sebelum waktu Subuh/Dzuhur/Ashar/Maghrib/Isya muncul popup selama aplikasi terbuka.
   Pemeriksaan tiap 20 dtk dengan jam dinding (tahan tidur/hibernasi laptop) — murni perbandingan waktu, tanpa beban. */
import { usePrayer, setPrayer } from './store';
import { DEFAULT_PLACE, type Place } from './places';
import { detectPlace, geoPermission, isDesktopApp } from './location';
import { dayKey, fmtTime, methodForCountry, METHODS, PRAYERS, type DayTimes, type MethodId } from './meta';

const LEAD = 5 * 60_000;
const WEB_REFRESH = 6 * 3600_000;
const DESKTOP_REFRESH = 7 * 24 * 3600_000;

type Eng = typeof import('./engine');
let eng: Eng | null = null;
const loadEngine = async () => (eng ??= await import('./engine'));

export const effectiveMethod = (place: Place, m: 'auto' | MethodId): MethodId => (m === 'auto' ? methodForCountry(place.cc) : m);
export const methodLabel = (id: MethodId) => METHODS.find((x) => x.id === id)?.label ?? id;
export const placeLabel = (p: Place | null) => {
  const q = p ?? DEFAULT_PLACE;
  return q.country ? `${q.city}, ${q.country}` : q.city;
};

/** deteksi (diam-diam) dan simpan; `announce` = beri tahu lewat toast */
export async function redetect(_announce = false): Promise<void> {
  if (usePrayer.getState().detecting) return;
  setPrayer({ detecting: true });
  try {
    const useGps = !isDesktopApp() && (await geoPermission()) !== 'denied';
    const p = await detectPlace(useGps);
    setPrayer({ place: p, detectedAt: Date.now() });
  } finally {
    setPrayer({ detecting: false });
  }
}

/** jadwal 3 hari (kemarin, hari ini, besok) untuk pemeriksaan & tampilan */
export async function scheduleFor(place: Place, method: 'auto' | MethodId, base = new Date()): Promise<DayTimes[]> {
  const e = await loadEngine();
  const m = effectiveMethod(place, method);
  return [-1, 0, 1].map((o) => e.computeDay(place.lat, place.lon, new Date(base.getFullYear(), base.getMonth(), base.getDate() + o, 12), m, { hi: place.hi, cc: place.cc }));
}

let cache: { key: string; days: DayTimes[] } | null = null;
async function daysNow(): Promise<DayTimes[]> {
  const s = usePrayer.getState();
  const place = s.place ?? DEFAULT_PLACE;
  const key = `${dayKey(new Date())}|${place.lat}|${place.lon}|${place.hi ? 1 : 0}|${s.method}`;
  if (cache?.key === key) return cache.days;
  const days = await scheduleFor(place, s.method);
  cache = { key, days };
  return days;
}

/** tampilkan popup (dipakai juga untuk tombol "Tes") */
export function showPopup(name: string, at: number, minutes: number) {
  setPrayer({ popup: { name, at, minutes, place: placeLabel(usePrayer.getState().place) } });
}

async function tick() {
  const s = usePrayer.getState();
  if (!s.enabled) return;
  const now = Date.now();
  const days = await daysNow();
  for (const d of days)
    for (const pr of PRAYERS) {
      const at = d[pr.key].getTime();
      const left = at - now;
      if (left <= 0 || left > LEAD) continue;
      const id = `${d.day}|${pr.key}`;
      if (usePrayer.getState().shown[id]) continue;
      // catat yang sudah diingatkan (hanya 4 hari terakhir disimpan)
      const shown: Record<string, number> = {};
      for (const [k, v] of Object.entries(usePrayer.getState().shown)) if (now - v < 4 * 86400_000) shown[k] = v;
      shown[id] = now;
      setPrayer({ shown });
      showPopup(pr.name, at, Math.max(1, Math.ceil(left / 60_000)));
      return;
    }
  // tutup popup yang waktunya sudah tiba
  const p = usePrayer.getState().popup;
  if (p && now >= p.at) setPrayer({ popup: null });
}

export function startPrayerReminder(): () => void {
  let stopped = false;
  const boot = async () => {
    const s = usePrayer.getState();
    const age = Date.now() - s.detectedAt;
    if (!s.place) await redetect(true); // pertama kali: ambil wilayah pengguna
    // lokasi bawaan (Jakarta) berarti deteksi sebelumnya gagal (mis. offline): coba lagi segera setelah ada koneksi
    else if (s.place.source === 'default' && age > 10 * 60_000) await redetect(false);
    else if (s.place.source !== 'manual' && age > (isDesktopApp() ? DESKTOP_REFRESH : WEB_REFRESH)) await redetect(false);
    if (!stopped) void tick();
  };
  const t0 = window.setTimeout(boot, 2500); // setelah antarmuka siap
  const iv = window.setInterval(() => void tick(), 20_000);
  const onVis = () => document.visibilityState === 'visible' && void tick();
  document.addEventListener('visibilitychange', onVis);
  return () => {
    stopped = true;
    clearTimeout(t0);
    clearInterval(iv);
    document.removeEventListener('visibilitychange', onVis);
  };
}

export { fmtTime };
