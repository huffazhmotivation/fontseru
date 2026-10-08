/* Pengingat sholat: popup 5 menit sebelum waktu sholat + dialog pengaturan (wilayah, metode, jadwal hari ini).
   Dipasang SEKALI di luar <App/> (lihat main.tsx) supaya berlaku di mode Font, Design, maupun Motion.
   Tampilan memakai token & gaya FontSeru (kelas .fm-prayer-*, lihat app.css). */
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { usePrayer, setPrayer } from "./store";
import { CITY_LIST, DEFAULT_PLACE } from "./places";
import { effectiveMethod, methodLabel, placeLabel, redetect, scheduleFor, showPopup, startPrayerReminder, fmtTime } from "./scheduler";
import { METHODS, PRAYERS, type DayTimes, type MethodId } from "./meta";

/** Ikon bulan sabit + bintang kecil (garis tunggal, mengikuti warna teks). */
export function PrayerIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19.5 14.2A8 8 0 0 1 9.8 4.5a8 8 0 1 0 9.7 9.7z" />
      <path d="M17.5 3.5v3.2M15.9 5.1h3.2" />
    </svg>
  );
}

export const openPrayerSettings = () => setPrayer({ settingsOpen: true });

function Popup() {
  const p = usePrayer((s) => s.popup);
  useEffect(() => {
    if (!p) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPrayer({ popup: null });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);
  if (!p) return null;
  const close = () => setPrayer({ popup: null });
  return (
    <div className="fm-prayer-backdrop" onPointerDown={close}>
      <div className="fm-prayer-dialog" role="alertdialog" aria-live="polite" aria-label="Pengingat waktu sholat" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className="fm-prayer-close" aria-label="Tutup pengingat" onClick={close}>
          <X size={16} />
        </button>
        <div className="fm-prayer-head">
          <span className="fm-prayer-icon">
            <PrayerIcon size={26} />
          </span>
          <div className="fm-prayer-headtext">
            <h2>
              {p.minutes} menit lagi menjelang waktu sholat {p.name} tiba untuk wilayah {p.place}
            </h2>
            <span className="fm-prayer-time">
              {p.name} · {fmtTime(new Date(p.at))}
            </span>
          </div>
        </div>
        <p className="fm-prayer-msg">
          Di tengah banyaknya hal yang sedang kamu usahakan, semoga hatimu tetap punya ruang untuk mengingat Allah. Waktu sholat akan segera tiba. Mari segera bersiap untuk melaksanakan sholat bagi yang menunaikannya. Barakallahu fiikum.
        </p>
      </div>
    </div>
  );
}

function Settings() {
  const open = usePrayer((s) => s.settingsOpen);
  const enabled = usePrayer((s) => s.enabled);
  const place = usePrayer((s) => s.place);
  const method = usePrayer((s) => s.method);
  const detecting = usePrayer((s) => s.detecting);
  const [days, setDays] = useState<DayTimes[] | null>(null);
  const cur = place ?? DEFAULT_PLACE;

  useEffect(() => {
    if (!open) return;
    let live = true;
    void scheduleFor(cur, method).then((d) => live && setDays(d));
    return () => {
      live = false;
    };
  }, [open, cur.lat, cur.lon, cur.hi, method]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPrayer({ settingsOpen: false });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const today = days?.[1];
  const nextKey = useMemo(() => {
    if (!days) return "";
    const now = Date.now();
    for (const d of days) for (const pr of PRAYERS) if (d[pr.key].getTime() > now) return `${d.day}|${pr.key}`;
    return "";
  }, [days]);

  if (!open) return null;
  const close = () => setPrayer({ settingsOpen: false });
  const eff = effectiveMethod(cur, method);
  const srcLabel = { gps: "terdeteksi otomatis (GPS)", ip: "terdeteksi otomatis (jaringan)", manual: "dipilih manual", default: "bawaan — lokasi tidak terdeteksi" }[cur.source];
  const idx = CITY_LIST.findIndex((c) => c.city === cur.city && c.cc === cur.cc);

  return (
    <div className="fm-prayer-backdrop fm-prayer-backdrop-soft" onPointerDown={close}>
      <div className="fm-prayer-dialog fm-prayer-settings" role="dialog" aria-label="Pengingat sholat" onPointerDown={(e) => e.stopPropagation()}>
        <header className="fm-prayer-sethead">
          <h2>
            <span className="fm-prayer-seticon">
              <PrayerIcon size={17} />
            </span>
            Pengingat sholat
          </h2>
          <button type="button" className="fm-prayer-close fm-prayer-close-inline" aria-label="Tutup" onClick={close}>
            <X size={16} />
          </button>
        </header>

        <div className="fm-prayer-row">
          <div className="fm-prayer-rowtext">
            <strong>Ingatkan 5 menit sebelum waktu sholat</strong>
            <span>Popup muncul selama aplikasi terbuka, di semua mode.</span>
          </div>
          <button type="button" role="switch" aria-checked={enabled} aria-label="Pengingat sholat" className={`fm-prayer-switch ${enabled ? "on" : ""}`} onClick={() => setPrayer({ enabled: !enabled })}>
            <span />
          </button>
        </div>

        <div className="fm-prayer-section">
          <span className="fm-prayer-label">Wilayah</span>
          <div className="fm-prayer-place">
            {placeLabel(cur)} <em>· {srcLabel}</em>
          </div>
          <div className="fm-prayer-pick">
            <select
              aria-label="Pilih kota"
              className="fm-prayer-select"
              value={cur.source === "manual" && idx >= 0 ? String(idx) : ""}
              onChange={(e) => {
                const c = CITY_LIST[+e.target.value];
                if (c) setPrayer({ place: { ...c, source: "manual" }, detectedAt: Date.now() });
              }}
            >
              <option value="" disabled>
                Pilih kota manual…
              </option>
              {CITY_LIST.map((c, i) => (
                <option key={c.city + c.cc} value={i}>
                  {c.city}
                  {c.cc !== "ID" ? ` (${c.country})` : ""}
                </option>
              ))}
            </select>
            <button type="button" className="fm-prayer-btn" disabled={detecting} onClick={() => void redetect(true)}>
              {detecting ? "Mendeteksi…" : "Deteksi otomatis"}
            </button>
          </div>
        </div>

        <div className="fm-prayer-section">
          <span className="fm-prayer-label">Metode perhitungan</span>
          <select aria-label="Metode perhitungan" className="fm-prayer-select" value={method} onChange={(e) => setPrayer({ method: e.target.value as "auto" | MethodId })}>
            <option value="auto">Otomatis ({methodLabel(effectiveMethod(cur, "auto"))})</option>
            {METHODS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {eff === "kemenag" && <span className="fm-prayer-hint">Standar Kemenag RI (Subuh −20°, Isya −18°, ihtiyath); dicocokkan dengan jadwal resmi Kemenag, selisih ≤ 1 menit.</span>}
        </div>

        <div className="fm-prayer-section">
          <span className="fm-prayer-label">Jadwal hari ini</span>
          <div className="fm-prayer-times">
            {today &&
              (
                [
                  ["Subuh", today.subuh, "subuh"],
                  ["Terbit", today.terbit, ""],
                  ["Dzuhur", today.dzuhur, "dzuhur"],
                  ["Ashar", today.ashar, "ashar"],
                  ["Maghrib", today.maghrib, "maghrib"],
                  ["Isya", today.isya, "isya"],
                ] as const
              ).map(([n, t, k]) => (
                <div key={n} className={`fm-prayer-time-cell ${k && nextKey === `${today.day}|${k}` ? "next" : ""}`}>
                  <span>{n}</span>
                  <strong>{fmtTime(t)}</strong>
                </div>
              ))}
          </div>
        </div>

        <footer className="fm-prayer-foot">
          <span>Waktu mengikuti jam perangkat.</span>
          <button type="button" className="fm-prayer-btn" onClick={() => showPopup("Dzuhur", Date.now() + 5 * 60_000, 5)}>
            Tes popup
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Pasang sekali di root aplikasi: menjalankan penjadwal + menampilkan popup & pengaturan di semua mode. */
export function PrayerReminder() {
  useEffect(() => startPrayerReminder(), []);
  // Mode Design memuat DesignSeru dalam iframe; menu "Pengingat sholat…" di sana meminta pengaturan FontSeru dibuka.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data && (e.data as { type?: string }).type === "fontseru:prayer-settings") openPrayerSettings();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  return (
    <>
      <Popup />
      <Settings />
    </>
  );
}
