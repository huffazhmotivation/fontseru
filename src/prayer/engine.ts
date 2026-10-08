/* Hitung waktu sholat. Memakai pustaka `adhan` (MIT, algoritma astronomi Jean Meeus) — dimuat lazy.
 *
 * Indonesia = standar Kemenag RI: Subuh −20°, Isya −18°, Ashar mazhab Syafi'i (bayangan 1×), Maghrib saat matahari −1°,
 * + ihtiyath (pengaman) Subuh/Ashar/Maghrib/Isya +2 menit, Dzuhur +3 menit, dibulatkan KE ATAS ke menit penuh.
 * Parameter ini dikalibrasi terhadap jadwal RESMI Kemenag (bimasislam, via api.myquran.com) untuk 20 kota × 123 hari (Jan/Apr/Jul/Okt 2026):
 * 93–96 % menit-nya identik persis, 100 % selisih ≤ 1 menit (selisih 1 menit = beda koordinat titik kota). */
import { Coordinates, CalculationMethod, PrayerTimes, Madhab, Rounding, type CalculationParameters } from 'adhan';

import { type MethodId, type DayTimes, dayKey } from './meta';
export * from './meta';

export function paramsFor(id: MethodId, opts: { hi?: boolean; cc?: string } = {}): CalculationParameters {
  let p: CalculationParameters;
  switch (id) {
    case 'kemenag':
      p = CalculationMethod.Other();
      p.fajrAngle = 20;
      p.ishaAngle = 18;
      p.madhab = Madhab.Shafi;
      p.rounding = Rounding.Up;
      // ihtiyath Kemenag; Maghrib saat matahari 1° di bawah ufuk (kota dataran tinggi tertentu: 2°, sesuai jadwal resmi)
      p.maghribAngle = opts.hi ? 2 : 1;
      p.adjustments = { ...p.adjustments, fajr: 2, sunrise: opts.hi ? -8 : -4, dhuhr: 3, asr: 2, maghrib: 2, isha: 2 };
      return p;
    case 'singapore':
      p = CalculationMethod.Singapore();
      break;
    case 'isna':
      p = CalculationMethod.NorthAmerica();
      break;
    case 'egypt':
      p = CalculationMethod.Egyptian();
      break;
    case 'karachi':
      p = CalculationMethod.Karachi();
      break;
    case 'ummalqura':
      p = CalculationMethod.UmmAlQura();
      break;
    case 'dubai':
      p = CalculationMethod.Dubai();
      break;
    case 'qatar':
      p = CalculationMethod.Qatar();
      break;
    case 'kuwait':
      p = CalculationMethod.Kuwait();
      break;
    case 'turkey':
      p = CalculationMethod.Turkey();
      break;
    case 'tehran':
      p = CalculationMethod.Tehran();
      break;
    default:
      p = CalculationMethod.MuslimWorldLeague();
  }
  // Ashar mazhab Hanafi (bayangan 2×) di Asia Selatan; lainnya Syafi'i/standar
  if (['PK', 'IN', 'BD', 'AF'].includes((opts.cc ?? '').toUpperCase())) p.madhab = Madhab.Hanafi;
  return p;
}

/** waktu sholat untuk hari lokal `date` di koordinat tertentu */
export function computeDay(lat: number, lon: number, date: Date, method: MethodId, opts: { hi?: boolean; cc?: string } = {}): DayTimes {
  const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0);
  const t = new PrayerTimes(new Coordinates(lat, lon), noon, paramsFor(method, opts));
  return { day: dayKey(date), subuh: t.fajr, terbit: t.sunrise, dzuhur: t.dhuhr, ashar: t.asr, maghrib: t.maghrib, isya: t.isha };
}

