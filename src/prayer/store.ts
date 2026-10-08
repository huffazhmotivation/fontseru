import { create } from 'zustand';
import { DEFAULT_PLACE, type Place } from './places';
import type { MethodId } from './meta';

const KEY = 'fontseru:prayer';

export interface PopupInfo {
  name: string;
  /** waktu masuk (epoch ms) */
  at: number;
  minutes: number;
  place: string;
}

interface PrayerState {
  enabled: boolean;
  place: Place | null;
  method: 'auto' | MethodId;
  /** kapan lokasi terakhir dideteksi (epoch ms) */
  detectedAt: number;
  /** "tanggal|sholat" yang sudah diingatkan (agar tidak muncul dua kali walau aplikasi dimuat ulang) */
  shown: Record<string, number>;
  settingsOpen: boolean;
  popup: PopupInfo | null;
  detecting: boolean;
}

export const usePrayer = create<PrayerState>(() => ({
  enabled: true,
  place: null,
  method: 'auto',
  detectedAt: 0,
  shown: {},
  settingsOpen: false,
  popup: null,
  detecting: false,
}));

try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const s = JSON.parse(raw) as Partial<PrayerState>;
    usePrayer.setState({
      enabled: s.enabled !== false,
      place: s.place && typeof s.place.lat === 'number' && typeof s.place.lon === 'number' ? { ...DEFAULT_PLACE, ...s.place } : null,
      method: s.method ?? 'auto',
      detectedAt: s.detectedAt ?? 0,
      shown: s.shown ?? {},
    });
  }
} catch {
  /* abaikan */
}

let t = 0;
usePrayer.subscribe((s, p) => {
  if (s.enabled === p.enabled && s.place === p.place && s.method === p.method && s.detectedAt === p.detectedAt && s.shown === p.shown) return;
  clearTimeout(t);
  t = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ enabled: s.enabled, place: s.place, method: s.method, detectedAt: s.detectedAt, shown: s.shown }));
    } catch {
      /* abaikan */
    }
  }, 300);
});

export const setPrayer = (p: Partial<PrayerState>) => usePrayer.setState(p);
