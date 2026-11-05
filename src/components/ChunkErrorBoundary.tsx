import { Component, type ReactNode } from "react";

/**
 * Menangkap kegagalan memuat chunk lazy (offline saat pertama membuka fitur,
 * atau build lama di cache setelah deploy menghapus file ber-hash lama).
 * Tanpa ini, satu import() yang gagal meng-unmount seluruh root React dan
 * editor font ikut hilang jadi layar putih. Dengan ini hanya bagian yang
 * gagal yang diganti pesan kecil + tombol muat ulang; editor tetap utuh.
 */
export class ChunkErrorBoundary extends Component<{ children: ReactNode; label?: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("[FontSeru] Gagal memuat modul:", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          position: "fixed",
          left: "50%",
          bottom: 24,
          transform: "translateX(-50%)",
          zIndex: 10000,
          display: "flex",
          gap: 12,
          alignItems: "center",
          padding: "10px 14px",
          borderRadius: 10,
          background: "#1c1c1f",
          color: "#f2f2f2",
          font: "13px/1.4 Inter, system-ui, sans-serif",
          boxShadow: "0 6px 24px rgba(0,0,0,.35)",
          maxWidth: "calc(100vw - 32px)",
        }}
      >
        <span>Gagal memuat {this.props.label ?? "fitur ini"}. Periksa koneksi lalu muat ulang.</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ padding: "6px 10px", borderRadius: 8, border: 0, cursor: "pointer", fontWeight: 600 }}
        >
          Muat ulang
        </button>
      </div>
    );
  }
}
