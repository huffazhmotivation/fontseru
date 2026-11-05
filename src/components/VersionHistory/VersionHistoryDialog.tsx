import { useCallback, useEffect, useState } from "react";
import { History, Trash2, X, RotateCcw, Save } from "lucide-react";
import { deleteVersion, listVersions, restoreVersion, saveVersion, type VersionMeta } from "@/glyph/versionHistory";

/** Dialog "Riwayat Versi": simpan snapshot bernama, lihat daftar, pulihkan, hapus. */
export function VersionHistoryDialog({ onClose, onNotify }: { onClose: () => void; onNotify: (msg: string, ok?: boolean) => void }) {
  const [items, setItems] = useState<VersionMeta[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setItems(await listVersions()); } catch { setItems([]); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setBusy(true);
    const meta = await saveVersion(name || "Versi", false);
    setBusy(false);
    if (meta) { setName(""); onNotify("Versi disimpan"); await refresh(); } else onNotify("Gagal menyimpan versi", false);
  };
  const restore = async (id: string) => {
    setBusy(true);
    const ok = await restoreVersion(id);
    setBusy(false);
    setConfirmId(null);
    if (ok) { onNotify("Versi dipulihkan (versi sebelumnya tersimpan otomatis)"); onClose(); } else onNotify("Versi tidak ditemukan", false);
  };

  return (
    <div className="fm-export-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}>
      <section className="fm-export-dialog fm-cloud-dialog" role="dialog" aria-modal="true" aria-labelledby="versions-title">
        <header>
          <div>
            <span className="fm-panel-eyebrow">Proyek</span>
            <h2 id="versions-title" className="fm-cloud-title"><History size={17} /> Riwayat Versi</h2>
          </div>
          <button type="button" className="fm-iconbtn" onClick={onClose} aria-label="Tutup riwayat versi"><X size={17} /></button>
        </header>
        <div className="fm-cloud-body">
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              className="fm-input"
              style={{ flex: 1 }}
              value={name}
              placeholder="Nama versi (mis. Sebelum ubah serif)"
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !busy) void save(); }}
              aria-label="Nama versi"
            />
            <button type="button" className="fm-secondary-btn" onClick={() => void save()} disabled={busy}>
              <Save size={14} /> Simpan versi
            </button>
          </div>
          {items === null ? (
            <p className="fm-cloud-status">Memuat…</p>
          ) : items.length === 0 ? (
            <div className="fm-cloud-empty">
              <History size={22} />
              <p>Belum ada versi tersimpan.</p>
              <span>Versi otomatis dibuat tiap beberapa menit saat Anda mengedit.</span>
            </div>
          ) : (
            <ul className="fm-cloud-list" role="list">
              {items.map((v) => (
                <li key={v.id} className="fm-cloud-item">
                  <div className="fm-cloud-item-main" style={{ cursor: "default" }}>
                    <span className="fm-cloud-item-info">
                      <span className="fm-cloud-item-name">{v.name}{v.auto ? " · otomatis" : ""}</span>
                      <span className="fm-cloud-item-meta">{new Date(v.createdAt).toLocaleString()} · {v.glyphCount} glyph digambar</span>
                    </span>
                  </div>
                  {confirmId === v.id ? (
                    <button type="button" className="fm-secondary-btn" onClick={() => void restore(v.id)} disabled={busy}>Ya, pulihkan</button>
                  ) : (
                    <button type="button" className="fm-iconbtn" aria-label={`Pulihkan ${v.name}`} title="Pulihkan versi ini" onClick={() => setConfirmId(v.id)} disabled={busy}>
                      <RotateCcw size={14} />
                    </button>
                  )}
                  <button type="button" className="fm-cloud-item-delete" aria-label={`Hapus ${v.name}`} onClick={() => { void deleteVersion(v.id).then(refresh); }} disabled={busy}>
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="fm-export-actions">
          <button type="button" className="fm-secondary-btn" onClick={onClose}>Tutup</button>
        </footer>
      </section>
    </div>
  );
}
