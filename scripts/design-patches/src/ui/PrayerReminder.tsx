/* PATCH FontSeru: pengingat sholat ada di FontSeru sendiri (src/prayer, aktif di semua mode dengan gaya FontSeru).
   Di dalam iframe Mode Design, DesignSeru TIDAK menjalankan popup/penjadwal sendiri (supaya tidak dobel);
   menu "Pengingat sholat…" hanya meminta FontSeru membuka dialog pengaturannya. */
export function PrayerIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19.5 14.2A8 8 0 0 1 9.8 4.5a8 8 0 1 0 9.7 9.7z" />
      <path d="M17.5 3.5v3.2M15.9 5.1h3.2" />
    </svg>
  );
}

export const openPrayerSettings = () => {
  try {
    window.parent.postMessage({ type: 'fontseru:prayer-settings' }, window.location.origin);
  } catch {
    /* tidak di dalam FontSeru */
  }
};

export function PrayerReminder() {
  return null;
}
