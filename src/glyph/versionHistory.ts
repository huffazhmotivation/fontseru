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
const PARTS = "parts";
const MAX_AUTO = 15;
const MAX_MANUAL = 40;
const CHUNK = 25;

export interface VersionMeta {
  id: string;
  name: string;
  createdAt: number;
  auto: boolean;
  fontName: string;
  glyphCount: number;
}

/** Everything except the glyphs (which live one-per-record in PARTS). */
interface VersionRecord extends VersionMeta {
  data: Record<string, unknown>;
  /** style → chars in original order, to rebuild the glyph maps. */
  glyphIndex: Record<string, string[]>;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PARTS)) db.createObjectStore(PARTS);
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function run<T>(stores: string | string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDB().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req ? (req.result as T) : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/** Gives the browser a chance to paint/handle input between chunks. */
function breathe(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 250 });
    else setTimeout(resolve, 16);
  });
}

const partKey = (id: string, style: string, ch: string) => `${id}\u0000${style}\u0000${ch}`;
const partRange = (id: string) => IDBKeyRange.bound(`${id}\u0000`, `${id}\u0001`, false, true);

function captureData() {
  const s = useAppStore.getState();
  // Drawing Mode scratch sketch must never be stored (same rule as autosave).
  const family = familyWithoutDrawGlyph(s.glyphsByStyle as never) as typeof s.glyphsByStyle;
  let glyphCount = 0;
  for (const g of Object.values(family.regular ?? {})) if (g.outline?.objects?.length) glyphCount++;
  return {
    fontName: s.fontName,
    glyphCount,
    family: family as unknown as Record<string, Record<string, unknown>>,
    data: {
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
    } as Record<string, unknown>,
  };
}

export async function listVersions(): Promise<VersionMeta[]> {
  const all = ((await run<VersionRecord[]>(STORE, "readonly", (t) => t.objectStore(STORE).getAll())) ?? []) as VersionRecord[];
  return all
    .map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt, auto: r.auto, fontName: r.fontName, glyphCount: r.glyphCount }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteVersion(id: string): Promise<void> {
  await run([STORE, PARTS], "readwrite", (t) => {
    t.objectStore(STORE).delete(id);
    t.objectStore(PARTS).delete(partRange(id));
  });
}

async function prune(): Promise<void> {
  const metas = await listVersions();
  const drop = [...metas.filter((m) => m.auto).slice(MAX_AUTO), ...metas.filter((m) => !m.auto).slice(MAX_MANUAL)];
  for (const m of drop) await deleteVersion(m.id);
}

let saving: Promise<unknown> = Promise.resolve();

/**
 * Saves a snapshot. The state is captured synchronously (glyph objects are
 * immutable, so holding references is a consistent snapshot) and written in
 * small chunks with a breather between them — copying a whole large font
 * into IndexedDB in one go froze the UI for 100+ ms. The metadata record is
 * written LAST, so a snapshot interrupted midway never appears in the list.
 */
export function saveVersion(name: string, auto = false): Promise<VersionMeta | null> {
  const job = saving.then(() => doSave(name, auto)).catch(() => null);
  saving = job;
  return job;
}

async function doSave(name: string, auto: boolean): Promise<VersionMeta | null> {
  const { data, fontName, glyphCount, family } = captureData();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    const glyphIndex: Record<string, string[]> = {};
    const entries: Array<[string, string, unknown]> = [];
    for (const [style, map] of Object.entries(family)) {
      glyphIndex[style] = Object.keys(map);
      for (const [ch, glyph] of Object.entries(map)) entries.push([style, ch, glyph]);
    }
    for (let i = 0; i < entries.length; i += CHUNK) {
      const slice = entries.slice(i, i + CHUNK);
      await run(PARTS, "readwrite", (t) => { for (const [style, ch, glyph] of slice) t.objectStore(PARTS).put(glyph, partKey(id, style, ch)); });
      await breathe();
    }
    const meta: VersionMeta = { id, name: name.trim() || (auto ? "Otomatis" : "Versi"), createdAt: Date.now(), auto, fontName, glyphCount };
    await run(STORE, "readwrite", (t) => { t.objectStore(STORE).put({ ...meta, data, glyphIndex } as VersionRecord); });
    await prune();
    return meta;
  } catch (err) {
    console.warn("[FontSeru] Gagal menyimpan versi:", err);
    await run(PARTS, "readwrite", (t) => { t.objectStore(PARTS).delete(partRange(id)); }).catch(() => undefined);
    return null;
  }
}

export async function renameVersion(id: string, name: string): Promise<void> {
  const rec = (await run<VersionRecord>(STORE, "readonly", (t) => t.objectStore(STORE).get(id))) as VersionRecord | undefined;
  if (!rec) return;
  await run(STORE, "readwrite", (t) => { t.objectStore(STORE).put({ ...rec, name: name.trim() || rec.name }); });
}

/** Pulihkan satu versi. Versi saat ini disimpan dulu (otomatis) supaya pemulihan bisa dibatalkan. */
export async function restoreVersion(id: string): Promise<boolean> {
  const rec = (await run<VersionRecord>(STORE, "readonly", (t) => t.objectStore(STORE).get(id))) as VersionRecord | undefined;
  if (!rec) return false;
  const [keys, values] = (await openDB().then((db) => new Promise<[IDBValidKey[], unknown[]]>((resolve, reject) => {
    const t = db.transaction(PARTS, "readonly");
    const store = t.objectStore(PARTS);
    const kr = store.getAllKeys(partRange(id));
    const vr = store.getAll(partRange(id));
    t.oncomplete = () => resolve([kr.result, vr.result]);
    t.onerror = () => reject(t.error);
  })));
  const byStyle: Record<string, Record<string, unknown>> = {};
  for (const style of Object.keys(rec.glyphIndex)) byStyle[style] = {};
  keys.forEach((k, i) => {
    const [, style, ...rest] = String(k).split("\u0000");
    (byStyle[style] ??= {})[rest.join("\u0000")] = values[i];
  });
  const glyphsByStyle: Record<string, Record<string, unknown>> = {};
  for (const [style, chars] of Object.entries(rec.glyphIndex)) {
    const ordered: Record<string, unknown> = {};
    for (const ch of chars) if (byStyle[style]?.[ch]) ordered[ch] = byStyle[style][ch];
    glyphsByStyle[style] = ordered;
  }
  if (!Object.keys(glyphsByStyle.regular ?? {}).length) return false; // snapshot incomplete — don't wipe the project
  // Never replace the project unless the current one was safely backed up first.
  if (!(await saveVersion("Sebelum pemulihan", true))) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useAppStore.getState().hydrate({ ...rec.data, glyphs: glyphsByStyle.regular, glyphsByStyle } as any);
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
