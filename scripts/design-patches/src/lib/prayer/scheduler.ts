/* PATCH FontSeru: penjadwal sholat dijalankan oleh FontSeru (src/prayer), bukan oleh mesin DesignSeru di dalam iframe. */
export function startPrayerReminder(): () => void {
  return () => {};
}
