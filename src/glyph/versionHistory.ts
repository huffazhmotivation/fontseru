import { useAppStore } from "./store";
import { familyWithoutDrawGlyph } from "./drawMode";

/**
 * Riwayat versi: snapshot proyek yang tahan reload (undo hanya di memori dan
 * hilang saat halaman dimuat ulang). Disimpan di database IndexedDB TERPISAH
 * ("fontseru-versions") supaya penyimpanan proyek utama tidak tersentuh sama
 * sekali — kalau bagian ini gagal, editor dan autosave tetap normal.
 *
 * Dua jenis: manual (dibuat pengguna, maks 40) dan otomatis (tiap beberapa
 * menit bila ada perubahan, dan sebelum tiap pemulihan; maks 15, yang paling
 * lama dibuang).
 */
const DB_NAME = "fontseru-versions";
const STORE = "snapshots";
const MAX_AUTO = 15;
const MAX_MANUAL = 40;

export interface VersionMeta {
  id: string;
  name: string;
  createdAt: number;
  auto: boolean;
  fontName: string;
  glyphCount: number;
}

interface VersionRecord extends VersionMeta {
  data: Record<string, unknown>;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDB().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? (req.result as T) : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function captureData(): { data: Record<string, unknown>; fontName: string; glyphCount: number } {
  const s = useAppStore.getState();
  // Drawing Mode scratch sketch must never be stored (same rule as autosave).
  const family = familyWithoutDrawGlyph(s.glyphsByStyle as never) as typeof s.glyphsByStyle;
  let glyphCount = 0;
  for (const g of Object.values(family.regular ?? {})) if (g.outline?.objects?.length) glyphCount++;
  return {
    fontName: s.fontName,
    glyphCount,
    data: {
      glyphs: family.regular,
      glyphsByStyle: family,
      fontStyle: s.fontStyle,
      customFamilies: s.customFamilies,
      fontName: s.fontName,
      fontInfo: s.fontInfo,
      exportInfo: s.exportInfo,
      metrics: s.metrics,
      kerningPairs: s.kerningPairs,
      kerningManual: s.kerningManual,
      kerningOverridesByStyle: s.kerningOverridesByStyle,
      kerningOverrideManualByStyle: s.kerningOverrideManualByStyle,
      wordSpacingOverridesByStyle: s.wordSpacingOverridesByStyle,
      featureConfig: s.featureConfig,
      activeChar: s.drawStash ? s.drawStash.activeChar : s.activeChar,
    },
  };
}

export async function listVersions(): Promise<VersionMeta[]> {
  const all = ((await tx<VersionRecord[]>("readonly", (s) => s.getAll())) ?? []) as VersionRecord[];
  return all
    .map(({ data: _d, ...meta }) => { void _d; return meta as VersionMeta; })
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function prune(): Promise<void> {
  const metas = await listVersions();
  const drop = [
    ...metas.filter((m) => m.auto).slice(MAX_AUTO),
    ...metas.filter((m) => !m.auto).slice(MAX_MANUAL),
  ];
  if (!drop.length) return;
  await tx("readwrite", (s) => { drop.forEach((m) => s.delete(m.id)); });
}

export async function saveVersion(name: string, auto = false): Promise<VersionMeta | null> {
  try {
    const { data, fontName, glyphCount } = captureData();
    const meta: VersionMeta = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim() || (auto ? "Otomatis" : "Versi"),
      createdAt: Date.now(),
      auto,
      fontName,
      glyphCount,
    };
    await tx("readwrite", (s) => { s.put({ ...meta, data } as VersionRecord); });
    await prune();
    return meta;
  } catch (err) {
    console.warn("[FontSeru] Gagal menyimpan versi:", err);
    return null;
  }
}

export async function deleteVersion(id: string): Promise<void> {
  await tx("readwrite", (s) => { s.delete(id); });
}

export async function renameVersion(id: string, name: string): Promise<void> {
  const rec = (await tx<VersionRecord>("readonly", (s) => s.get(id))) as VersionRecord | undefined;
  if (!rec) return;
  await tx("readwrite", (s) => { s.put({ ...rec, name: name.trim() || rec.name }); });
}

/** Pulihkan satu versi. Versi saat ini disimpan dulu (otomatis) supaya pemulihan bisa dibatalkan. */
export async function restoreVersion(id: string): Promise<boolean> {
  const rec = (await tx<VersionRecord>("readonly", (s) => s.get(id))) as VersionRecord | undefined;
  if (!rec) return false;
  await saveVersion("Sebelum pemulihan", true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useAppStore.getState().hydrate(rec.data as any);
  return true;
}

let lastAutoMarker: unknown = null;

/** Dipanggil berkala: simpan snapshot otomatis hanya bila proyek berubah sejak snapshot terakhir. */
export function maybeAutoSnapshot(): void {
  const s = useAppStore.getState();
  if (s.past.length === 0) return; // belum ada suntingan sesi ini
  const marker = s.past[s.past.length - 1];
  if (marker === lastAutoMarker) return;
  lastAutoMarker = marker;
  void saveVersion("Otomatis", true);
}
