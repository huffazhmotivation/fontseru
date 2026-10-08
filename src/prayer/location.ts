/* Deteksi wilayah pengguna untuk jadwal sholat.
   Web: GPS peramban (izin lokasi) → bila ditolak/gagal: lokasi dari alamat IP → bila gagal: Jakarta.
   Aplikasi desktop (Electron): GPS peramban tidak tersedia tanpa kunci layanan Google, jadi langsung memakai lokasi dari IP → Jakarta.
   Nama kota diambil dari koordinat (reverse geocoding) lalu "ditempelkan" ke kota terdekat di daftar bila ≤ 12 km agar jadwal resmi kota itu dipakai. */
import { DEFAULT_PLACE, nearestCity, type Place } from './places';

import { isDesktopApp as isDesktopAppFlag } from '@/lib/desktop';

export const isDesktopApp = () => isDesktopAppFlag;

async function getJson(url: string, ms = 6000): Promise<Record<string, unknown> | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** koordinat → tempat bernama */
export async function placeFromCoords(lat: number, lon: number, source: Place['source']): Promise<Place> {
  const near = nearestCity(lat, lon);
  if (near) return { ...near, lat, lon, source };
  const j = await getJson(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=id`);
  const city = str(j?.city) || str(j?.locality) || str(j?.principalSubdivision) || 'Lokasi Anda';
  return { lat, lon, city, country: str(j?.countryName), cc: str(j?.countryCode).toUpperCase(), source };
}

function gps(): Promise<GeolocationPosition | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((res) => navigator.geolocation.getCurrentPosition((p) => res(p), () => res(null), { timeout: 12000, maximumAge: 3600_000, enableHighAccuracy: false }));
}

/** status izin lokasi peramban ('denied' = jangan meminta lagi) */
export async function geoPermission(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    return p ? p.state : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function ipPlace(): Promise<Place | null> {
  const a = await getJson('https://ipwho.is/');
  if (a && a.success !== false && typeof a.latitude === 'number' && typeof a.longitude === 'number') {
    const p = await placeFromCoords(a.latitude, a.longitude, 'ip');
    // nama kota dari penyedia IP lebih tepat daripada "Lokasi Anda"
    if (p.city === 'Lokasi Anda' && str(a.city)) return { ...p, city: str(a.city), country: str(a.country), cc: str(a.country_code).toUpperCase() };
    return p;
  }
  const b = await getJson('https://ipapi.co/json/');
  if (b && typeof b.latitude === 'number' && typeof b.longitude === 'number') {
    const p = await placeFromCoords(b.latitude, b.longitude, 'ip');
    if (p.city === 'Lokasi Anda' && str(b.city)) return { ...p, city: str(b.city), country: str(b.country_name), cc: str(b.country_code).toUpperCase() };
    return p;
  }
  return null;
}

/** deteksi lengkap; `useGps=false` melewati GPS (desktop / izin ditolak). Tidak pernah melempar: gagal total → Jakarta. */
export async function detectPlace(useGps: boolean): Promise<Place> {
  if (useGps) {
    const pos = await gps();
    if (pos) return placeFromCoords(pos.coords.latitude, pos.coords.longitude, 'gps');
  }
  return (await ipPlace()) ?? { ...DEFAULT_PLACE };
}
