import { familyWithoutDrawGlyph } from "./drawMode";
import type { CustomFamily, FontStyle, GlyphFamily, GlyphMap } from "@/types/glyph";
import type { KerningPairs, KerningManualFlags, KerningOverridesByStyle, KerningOverrideManualByStyle, WordSpacingOverridesByStyle } from "@/types/kerning";
import type { ExportInfoDraft, FontInfo, FontMetrics } from "@/types/font";
import type { FeatureBuilderConfig } from "@/types/opentypeFeatures";

/**
 * Minimal IndexedDB persistence (no external deps), restoring the working
 * project after a full browser reload. Kerning data was added additively in
 * Phase 6 — `loadProject` on an older saved snapshot (no kerning fields)
 * just gets `undefined` for them, which the store's `hydrate` already
 * treats as "keep the current default".
 *
 * STORAGE LAYOUT. The project used to be ONE record holding every glyph, so
 * each autosave structured-cloned the entire font (hundreds of ms of frozen
 * UI on a large project) even when a single stroke had changed. It's now
 * split: the "current" record holds everything except the glyphs (plus a
 * `split` marker and the glyph index), and every glyph is its own record.
 * A save writes only the glyphs whose object changed since the last save,
 * all inside one transaction with the metadata, so the stored project is
 * never half-updated. Snapshots saved in the old single-record layout are
 * still read as-is, and get converted on their next save.
 */
const DB_NAME = "fontseru";
const STORE = "project";
const KEY = "current";
const VERSION = 1;

interface ProjectSnapshot {
  /** Regular glyphs kept for backward compatibility with older snapshots. */
  glyphs: GlyphMap;
  glyphsByStyle?: GlyphFamily;
  fontStyle?: FontStyle;
  /** Custom Glyph tabs beyond Regular/Bold/Italic (see types/glyph.ts). Optional so older saved snapshots without this field still load fine. */
  customFamilies?: CustomFamily[];
  fontName: string;
  fontInfo?: FontInfo;
  metrics?: FontMetrics;
  kerningPairs?: KerningPairs;
  kerningManual?: KerningManualFlags;
  kerningOverridesByStyle?: KerningOverridesByStyle;
  kerningOverrideManualByStyle?: KerningOverrideManualByStyle;
  /** Sparse per-style word spacing layer. Optional so older saved snapshots
   * without this field still load fine. */
  wordSpacingOverridesByStyle?: WordSpacingOverridesByStyle;
  /** OpenType Feature Builder config (ligatures/alternates/swashes). Optional
   * so older saved snapshots without this field still load fine. */
  featureConfig?: FeatureBuilderConfig;
  /** Raw Export-dialog form saved via "Save Info". Optional so older saved
   * snapshots without this field still load fine. */
  exportInfo?: ExportInfoDraft;
}

/** Marker on the metadata record of the split layout. */
const SPLIT_VERSION = 2;
const GLYPH_PREFIX = "g\u0000";
const GLYPH_RANGE = IDBKeyRange.bound(GLYPH_PREFIX, "g\u0001", false, true);
const glyphKey = (style: string, char: string) => `${GLYPH_PREFIX}${style}\u0000${char}`;

type SplitMeta = Omit<ProjectSnapshot, "glyphs" | "glyphsByStyle"> & {
  split: number;
  /** style → the chars stored as glyph records, in original order. */
  glyphIndex: Record<string, string[]>;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading/deleting the DB, or the browser closing the
      // connection: drop the cached handle so the next call reopens.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

/** Glyph objects as of the last successful save/load, per style — the
 * baseline a save is diffed against. null = unknown (nothing loaded or
 * saved yet this session), which forces a full rewrite. */
let lastSaved: Map<string, Map<string, unknown>> | null = null;

function rememberSaved(byStyle: Record<string, GlyphMap>): void {
  const next = new Map<string, Map<string, unknown>>();
  for (const [style, map] of Object.entries(byStyle)) next.set(style, new Map(Object.entries(map)));
  lastSaved = next;
}

export async function loadProject(): Promise<ProjectSnapshot | null> {
  let legacyLoaded = false;
  try {
    const db = await openDB();
    const loaded = await new Promise<ProjectSnapshot | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const metaReq = store.get(KEY);
      let keys: IDBValidKey[] = [];
      let values: unknown[] = [];
      const keysReq = store.getAllKeys(GLYPH_RANGE);
      const valuesReq = store.getAll(GLYPH_RANGE);
      keysReq.onsuccess = () => (keys = keysReq.result);
      valuesReq.onsuccess = () => (values = valuesReq.result);
      tx.oncomplete = () => {
        const meta = metaReq.result as (ProjectSnapshot & Partial<SplitMeta>) | undefined;
        if (!meta) return resolve(null);
        if (!meta.split) {
          // Legacy single-record layout: there are no glyph records yet, so
          // the diff baseline must stay unknown (null) — the next save then
          // writes every glyph instead of skipping "unchanged" ones that
          // were never stored in the new layout.
          lastSaved = null;
          legacyLoaded = true;
          return resolve(meta as ProjectSnapshot);
        }
        const byStyle: Record<string, GlyphMap> = {};
        for (const style of Object.keys(meta.glyphIndex ?? {})) byStyle[style] = {};
        keys.forEach((key, i) => {
          const [, style, ...charParts] = String(key).split("\u0000");
          const glyph = values[i] as GlyphMap[string];
          (byStyle[style] ??= {})[charParts.join("\u0000")] = glyph;
        });
        // Restore each style's original glyph order from the stored index.
        for (const [style, chars] of Object.entries(meta.glyphIndex ?? {})) {
          const ordered: GlyphMap = {};
          for (const ch of chars) if (byStyle[style][ch]) ordered[ch] = byStyle[style][ch];
          for (const ch of Object.keys(byStyle[style])) if (!(ch in ordered)) ordered[ch] = byStyle[style][ch];
          byStyle[style] = ordered;
        }
        const { split: _split, glyphIndex: _index, ...rest } = meta as SplitMeta;
        void _split; void _index;
        resolve({ ...rest, glyphs: byStyle.regular ?? {}, glyphsByStyle: byStyle as unknown as GlyphFamily });
      };
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB read failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB read aborted"));
    });
    if (loaded && !legacyLoaded) rememberSaved((loaded.glyphsByStyle ?? { regular: loaded.glyphs }) as Record<string, GlyphMap>);
    return loaded;
  } catch (err) {
    // Storage that simply doesn't exist (private mode, no IndexedDB) means
    // "nothing saved". A read that FAILED must not look like an empty
    // project: the caller would then autosave defaults over the real one.
    if (typeof indexedDB === "undefined") return null;
    throw err;
  }
}

let saveChain: Promise<void> = Promise.resolve();

/** Saves are serialized so `lastSaved` always matches what's on disk. */
export function saveProject(snapshot: ProjectSnapshot): Promise<void> {
  saveChain = saveChain.then(() => writeProject(snapshot));
  return saveChain;
}

async function writeProject(snapshot: ProjectSnapshot): Promise<void> {
  try {
    const db = await openDB();
    // The Drawing Mode scratch sketch must never reach disk.
    const byStyle = familyWithoutDrawGlyph((snapshot.glyphsByStyle ?? { regular: snapshot.glyphs }) as unknown as Record<string, GlyphMap>);
    const { glyphs: _g, glyphsByStyle: _gs, ...rest } = snapshot;
    void _g; void _gs;
    const glyphIndex: Record<string, string[]> = {};
    for (const [style, map] of Object.entries(byStyle)) glyphIndex[style] = Object.keys(map);
    const meta: SplitMeta = { ...rest, split: SPLIT_VERSION, glyphIndex };

    const baseline = lastSaved;
    const ok = await new Promise<boolean>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      // Unknown baseline (first save this session, or the stored project
      // is in the old layout): clear every glyph record and rewrite all.
      if (!baseline) store.delete(GLYPH_RANGE);
      for (const [style, map] of Object.entries(byStyle)) {
        const before = baseline?.get(style);
        for (const [ch, glyph] of Object.entries(map)) {
          if (before && before.get(ch) === glyph) continue; // unchanged
          store.put(glyph, glyphKey(style, ch));
        }
      }
      if (baseline) {
        for (const [style, before] of baseline) {
          const now = byStyle[style];
          for (const ch of before.keys()) if (!now || !(ch in now)) store.delete(glyphKey(style, ch));
        }
      }
      store.put(meta, KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
    if (ok) rememberSaved(byStyle);
  } catch {
    /* storage unavailable — editing still works in-session */
  }
}
