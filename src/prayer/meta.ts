/* Bagian ringan modul sholat (tanpa pustaka astronomi `adhan`): tipe, daftar metode, nama sholat, format waktu. */
export type MethodId = 'kemenag' | 'singapore' | 'mwl' | 'isna' | 'egypt' | 'karachi' | 'ummalqura' | 'dubai' | 'qatar' | 'kuwait' | 'turkey' | 'tehran';

export const METHODS: { id: MethodId; label: string }[] = [
  { id: 'kemenag', label: 'Kemenag RI (Indonesia)' },
  { id: 'singapore', label: 'MUIS Singapura / JAKIM Malaysia / Brunei' },
  { id: 'mwl', label: 'Muslim World League' },
  { id: 'isna', label: 'ISNA (Amerika Utara)' },
  { id: 'egypt', label: 'Otoritas Survei Mesir' },
  { id: 'karachi', label: 'Univ. Ilmu Islam Karachi' },
  { id: 'ummalqura', label: 'Umm al-Qura (Arab Saudi)' },
  { id: 'dubai', label: 'Dubai (UEA)' },
  { id: 'qatar', label: 'Qatar' },
  { id: 'kuwait', label: 'Kuwait' },
  { id: 'turkey', label: 'Diyanet (Turki)' },
  { id: 'tehran', label: 'Teheran (Iran)' },
];

/** metode resmi/umum menurut negara; negara lain memakai Muslim World League */
export function methodForCountry(cc: string | undefined): MethodId {
  switch ((cc ?? '').toUpperCase()) {
    case 'ID':
      return 'kemenag';
    case 'MY':
    case 'SG':
    case 'BN':
      return 'singapore';
    case 'SA':
      return 'ummalqura';
    case 'AE':
      return 'dubai';
    case 'QA':
      return 'qatar';
    case 'KW':
      return 'kuwait';
    case 'EG':
      return 'egypt';
    case 'PK':
    case 'IN':
    case 'BD':
    case 'AF':
      return 'karachi';
    case 'TR':
      return 'turkey';
    case 'IR':
      return 'tehran';
    case 'US':
    case 'CA':
      return 'isna';
    default:
      return 'mwl';
  }
}

export type PrayerKey = 'subuh' | 'dzuhur' | 'ashar' | 'maghrib' | 'isya';
export const PRAYERS: { key: PrayerKey; name: string }[] = [
  { key: 'subuh', name: 'Subuh' },
  { key: 'dzuhur', name: 'Dzuhur' },
  { key: 'ashar', name: 'Ashar' },
  { key: 'maghrib', name: 'Maghrib' },
  { key: 'isya', name: 'Isya' },
];

export interface DayTimes {
  /** "YYYY-MM-DD" hari lokal perangkat */
  day: string;
  subuh: Date;
  terbit: Date;
  dzuhur: Date;
  ashar: Date;
  maghrib: Date;
  isya: Date;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const fmtTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
