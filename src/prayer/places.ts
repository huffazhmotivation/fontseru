/* Daftar kota (dipakai untuk pilihan manual & "menempelkan" lokasi terdeteksi ke kota terdekat).
   `hi` = kota yang jadwal resmi Kemenag RI-nya memakai koreksi dataran tinggi (Maghrib/Terbit memakai kerendahan ufuk tambahan):
   hasil kalibrasi terhadap jadwal resmi Kemenag (bimasislam) — Bandung, Kota Bogor, Cimahi, Sukabumi, Salatiga, Wonosobo, Batu, Bukittinggi. */
export interface Place {
  lat: number;
  lon: number;
  city: string;
  country: string;
  /** kode negara ISO-3166 alpha-2 (ID, MY, SA, …) */
  cc: string;
  /** dataran tinggi (koreksi Kemenag) */
  hi?: boolean;
  source: 'gps' | 'ip' | 'manual' | 'default';
}

export const DEFAULT_PLACE: Place = { lat: -6.2088, lon: 106.8456, city: 'Jakarta', country: 'Indonesia', cc: 'ID', source: 'default' };

type C = [string, number, number, string, boolean?];
/** [nama, lat, lon, kode negara, dataran tinggi?] */
const CITIES: C[] = [
  ['Jakarta', -6.2088, 106.8456, 'ID'],
  ['Bandung', -6.9175, 107.6191, 'ID', true],
  ['Bekasi', -6.2383, 106.9756, 'ID'],
  ['Depok', -6.4025, 106.7942, 'ID'],
  ['Tangerang', -6.1783, 106.63, 'ID'],
  ['Bogor', -6.595, 106.8166, 'ID', true],
  ['Cimahi', -6.8841, 107.5413, 'ID', true],
  ['Sukabumi', -6.9277, 106.93, 'ID', true],
  ['Cirebon', -6.7063, 108.557, 'ID'],
  ['Semarang', -6.9667, 110.4167, 'ID'],
  ['Salatiga', -7.3305, 110.5084, 'ID', true],
  ['Wonosobo', -7.3632, 109.9004, 'ID', true],
  ['Magelang', -7.4797, 110.2177, 'ID'],
  ['Yogyakarta', -7.7956, 110.3695, 'ID'],
  ['Surakarta (Solo)', -7.5666, 110.8167, 'ID'],
  ['Surabaya', -7.2575, 112.7521, 'ID'],
  ['Malang', -7.9797, 112.6304, 'ID'],
  ['Batu', -7.8672, 112.5239, 'ID', true],
  ['Kediri', -7.8167, 112.0167, 'ID'],
  ['Denpasar', -8.65, 115.2167, 'ID'],
  ['Mataram', -8.5833, 116.1167, 'ID'],
  ['Kupang', -10.1772, 123.607, 'ID'],
  ['Medan', 3.5952, 98.6722, 'ID'],
  ['Banda Aceh', 5.5483, 95.3238, 'ID'],
  ['Padang', -0.9471, 100.4172, 'ID'],
  ['Bukittinggi', -0.3055, 100.3692, 'ID', true],
  ['Pekanbaru', 0.5071, 101.4478, 'ID'],
  ['Batam', 1.0456, 104.0305, 'ID'],
  ['Jambi', -1.6101, 103.6131, 'ID'],
  ['Palembang', -2.9761, 104.7754, 'ID'],
  ['Bengkulu', -3.8004, 102.2655, 'ID'],
  ['Bandar Lampung', -5.45, 105.2667, 'ID'],
  ['Pangkalpinang', -2.1291, 106.1133, 'ID'],
  ['Pontianak', -0.0263, 109.3425, 'ID'],
  ['Palangka Raya', -2.21, 113.9213, 'ID'],
  ['Banjarmasin', -3.3194, 114.5908, 'ID'],
  ['Balikpapan', -1.2654, 116.8312, 'ID'],
  ['Samarinda', -0.5022, 117.1536, 'ID'],
  ['Tarakan', 3.3, 117.6333, 'ID'],
  ['Makassar', -5.1477, 119.4327, 'ID'],
  ['Palu', -0.9, 119.8707, 'ID'],
  ['Kendari', -3.9985, 122.5129, 'ID'],
  ['Manado', 1.4748, 124.8421, 'ID'],
  ['Gorontalo', 0.5435, 123.0568, 'ID'],
  ['Ambon', -3.6954, 128.1814, 'ID'],
  ['Ternate', 0.7893, 127.3774, 'ID'],
  ['Jayapura', -2.5337, 140.7181, 'ID'],
  ['Sorong', -0.8762, 131.2558, 'ID'],
  ['Kuala Lumpur', 3.139, 101.6869, 'MY'],
  ['Singapura', 1.3521, 103.8198, 'SG'],
  ['Bandar Seri Begawan', 4.9031, 114.9398, 'BN'],
  ['Makkah', 21.4225, 39.8262, 'SA'],
  ['Madinah', 24.4672, 39.6024, 'SA'],
];

const COUNTRY: Record<string, string> = { ID: 'Indonesia', MY: 'Malaysia', SG: 'Singapura', BN: 'Brunei', SA: 'Arab Saudi' };

export const CITY_LIST: Place[] = CITIES.map(([city, lat, lon, cc, hi]) => ({ city, lat, lon, cc, country: COUNTRY[cc] ?? cc, hi, source: 'manual' as const }));

/** jarak (km) antara dua koordinat */
export function distKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371,
    r = Math.PI / 180;
  const dLat = (bLat - aLat) * r,
    dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** kota di daftar yang paling dekat dengan koordinat, bila dalam `maxKm` */
export function nearestCity(lat: number, lon: number, maxKm = 12): Place | null {
  let best: Place | null = null,
    bd = maxKm;
  for (const c of CITY_LIST) {
    const d = distKm(lat, lon, c.lat, c.lon);
    if (d <= bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}
