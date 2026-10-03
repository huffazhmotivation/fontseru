// Undo yang sadar Pen tool.
//
// Masalah asal: Pen membuka SATU transaksi riwayat (`begin('Pen')`) sejak titik
// pertama dan baru menutupnya (`end()`) saat path selesai. `undo()` bawaan
// menutup transaksi itu lalu membatalkannya — jadi Ctrl+Z di tengah menggambar
// membuang SELURUH path yang sedang dibuat, bukan cuma titik terakhir.
//
// Perbaikan: selama Pen sedang menggambar path (tool 'pen' + penDrawingId),
// undo hanya mencabut SATU titik terakhir (dengan handle titik sebelumnya
// dikembalikan persis seperti sebelum titik itu dibuat). Bila titik yang dicabut
// adalah titik pertama, path kosong itu dibatalkan seluruhnya. Di luar kondisi
// itu `undo` bawaan berjalan seperti biasa.
//
// Dipasang sekali dari main.tsx dengan membungkus aksi `undo` di store, sehingga
// SEMUA pemicu undo ikut sadar-Pen: Ctrl/Cmd+Z, tombol Urungkan di top bar, menu,
// palet perintah, dan ketuk 2 jari di layar sentuh.
import { getS, useStore } from '../store/store';
import { removeNodes } from '../model/doc';

type Snapshot = unknown[];

interface PenStore {
  tool: string;
  penDrawingId: string | null;
  pending: unknown;
  doc: { nodes: Record<string, { points?: Snapshot } | undefined> };
  undo: () => void;
  cancel: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  live: (fn: (d: { nodes: Record<string, any> }) => void) => void;
  set: (patch: Record<string, unknown>) => void;
  setOverlay: (patch: Record<string, unknown>) => void;
}

const st = () => getS() as unknown as PenStore;

// Titik-titik path yang sedang digambar SEBELUM tiap klik Pen menambah titik.
// Satu entri per titik yang dibuat pada sesi menggambar ini.
let trackedId: string | null = null;
let before: Snapshot[] = [];
let lastPoints: Snapshot | null = null;

function resetTracking() {
  trackedId = null;
  before = [];
  lastPoints = null;
}

function onStoreChange() {
  const s = st();
  const id = s.penDrawingId;
  if (!id) {
    if (trackedId !== null) resetTracking();
    return;
  }
  const points = s.doc.nodes[id]?.points;
  if (!Array.isArray(points)) return;
  if (id !== trackedId) {
    // Path baru (points masih kosong) atau melanjutkan path terbuka: titik awal
    // sesi ini jadi dasar; hanya titik yang DITAMBAH setelahnya yang bisa dicabut.
    trackedId = id;
    before = [];
    lastPoints = points;
    return;
  }
  if (lastPoints && points.length > lastPoints.length) before.push(lastPoints);
  lastPoints = points;
}

/** Mencabut titik Pen terakhir. Mengembalikan true bila undo sudah ditangani di sini. */
export function undoLastPenPoint(): boolean {
  const s = st();
  const id = s.penDrawingId;
  if (s.tool !== 'pen' || !id || trackedId !== id || before.length === 0) return false;
  const node = s.doc.nodes[id];
  if (!node) return false;

  const prev = before.pop() as Snapshot;
  if (prev.length === 0) {
    // Titik pertama dicabut → tidak ada yang tersisa, batalkan path kosongnya.
    if (s.pending) s.cancel();
    else s.live((d) => removeNodes(d as never, [id]));
    s.set({ penDrawingId: null, editPathId: null, selAnchors: [], selection: [] });
    s.setOverlay({ penCursor: null });
    resetTracking();
    return true;
  }

  s.live((d) => {
    const n = d.nodes[id];
    if (n) d.nodes[id] = { ...n, points: prev };
  });
  s.set({ selAnchors: [prev.length - 1] });
  return true;
}

let installed = false;

export function installPenUndo() {
  if (installed) return;
  installed = true;
  const store = useStore as unknown as {
    subscribe: (fn: () => void) => () => void;
    setState: (patch: Record<string, unknown>) => void;
  };
  store.subscribe(onStoreChange);
  const original = st().undo;
  store.setState({
    undo: () => {
      if (!undoLastPenPoint()) original();
    },
  });
}
