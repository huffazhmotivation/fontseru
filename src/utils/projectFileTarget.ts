/**
 * Where "Save" writes the project.
 *
 * Before, Save always produced a NEW .fs download, so the file you opened
 * never changed and copies piled up ("Font (1).fs", "Font (2).fs"…). Now the
 * project remembers its file and Save (⌘S / Shift+S) overwrites it in place:
 *
 *  • Desktop app (Electron): the real path of the opened / saved .fs file,
 *    written by the main process (see desktop/main.cjs + preload.cjs). It is
 *    remembered across restarts, because the autosaved project that comes
 *    back on launch is the same one.
 *  • Chrome / Edge on the web: a File System Access handle from the open or
 *    save picker (kept for this tab only — handles can't be persisted
 *    without extra permission prompts).
 *  • Everything else (Safari, iPad): no file access, so Save keeps
 *    downloading a copy as before.
 *
 * The target is dropped whenever a different project replaces the current
 * one (New, opening another file, opening from Cloud, importing a font), so
 * Save can never overwrite an unrelated file.
 */

interface DesktopBridge {
  pathForFile(file: File): string;
  saveProject(path: string, text: string): Promise<string>;
  saveProjectAs(suggestedName: string, text: string, currentPath?: string): Promise<string | null>;
}

interface WritableLike {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
  abort?: () => Promise<void>;
}
interface FileHandleLike {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritableLike>;
  queryPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
}
type PickerTypes = Array<{ description?: string; accept: Record<string, string[]> }>;
type FsWindow = Window & {
  fontseruDesktop?: DesktopBridge;
  showSaveFilePicker?: (o?: { suggestedName?: string; types?: PickerTypes }) => Promise<FileHandleLike>;
  showOpenFilePicker?: (o?: { multiple?: boolean; types?: PickerTypes; excludeAcceptAllOption?: boolean }) => Promise<FileHandleLike[]>;
};

export type ProjectTarget =
  | { kind: "desktop"; path: string; name: string }
  | { kind: "handle"; handle: FileHandleLike; name: string };

const STORAGE_KEY = "fontseru.projectFileTarget";
const FS_TYPES: PickerTypes = [{ description: "FontSeru Project", accept: { "application/octet-stream": [".fs"] } }];
const OPEN_TYPES: PickerTypes = [
  { description: "FontSeru Project / Font", accept: { "application/octet-stream": [".fs", ".ttf", ".otf"] } },
];

const w = (): FsWindow | null => (typeof window === "undefined" ? null : (window as FsWindow));
const desktop = (): DesktopBridge | null => w()?.fontseruDesktop ?? null;

let target: ProjectTarget | null = loadStored();
const listeners = new Set<() => void>();

function loadStored(): ProjectTarget | null {
  if (!desktop()) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { path?: unknown; name?: unknown };
    if (typeof v.path === "string" && /\.fs$/i.test(v.path)) {
      return { kind: "desktop", path: v.path, name: typeof v.name === "string" ? v.name : baseName(v.path) };
    }
  } catch { /* storage unavailable */ }
  return null;
}

function setTarget(t: ProjectTarget | null) {
  target = t;
  try {
    if (t?.kind === "desktop") localStorage.setItem(STORAGE_KEY, JSON.stringify({ path: t.path, name: t.name }));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage unavailable */ }
  listeners.forEach((l) => l());
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export function getProjectTarget(): ProjectTarget | null {
  return target;
}

export function subscribeProjectTarget(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A different project replaced the current one — Save must not reuse the old file. */
export function clearProjectTarget(): void {
  if (target) setTarget(null);
}

/** Desktop app or a browser with the File System Access API. */
export function canWriteFiles(): boolean {
  const win = w();
  return !!desktop() || (!!win && typeof win.showSaveFilePicker === "function" && globalThis.isSecureContext);
}

/** Use the browser's open picker (keeps a writable handle) when it exists. */
export function canPickWithHandle(): boolean {
  const win = w();
  return !desktop() && !!win && typeof win.showOpenFilePicker === "function" && globalThis.isSecureContext;
}

/**
 * Open picker that also returns a handle Save can write back to (Chrome/Edge).
 * Resolves null when cancelled.
 */
export async function pickFileWithHandle(): Promise<{ file: File; handle: FileHandleLike } | null> {
  const win = w();
  if (!win?.showOpenFilePicker) return null;
  try {
    const [handle] = await win.showOpenFilePicker({ multiple: false, types: OPEN_TYPES });
    if (!handle) return null;
    return { file: await handle.getFile(), handle };
  } catch (error) {
    if (error && typeof error === "object" && (error as { name?: string }).name === "AbortError") return null;
    throw error;
  }
}

/** Remember the .fs file that was just opened (anything else clears the target). */
export function rememberOpenedFile(file: File, handle?: FileHandleLike | null): void {
  if (!/\.fs$/i.test(file.name)) { clearProjectTarget(); return; }
  const bridge = desktop();
  if (bridge) {
    const p = bridge.pathForFile(file);
    setTarget(p && /\.fs$/i.test(p) ? { kind: "desktop", path: p, name: baseName(p) } : null);
    return;
  }
  setTarget(handle ? { kind: "handle", handle, name: handle.name || file.name } : null);
}

export type SaveOutcome =
  | { kind: "overwritten"; name: string }
  | { kind: "saved-as"; name: string }
  | { kind: "downloaded" }
  | { kind: "cancelled" };

async function writeHandle(handle: FileHandleLike, text: string) {
  if (handle.queryPermission && (await handle.queryPermission({ mode: "readwrite" })) !== "granted") {
    if (!handle.requestPermission || (await handle.requestPermission({ mode: "readwrite" })) !== "granted") {
      throw new DOMException("Izin menulis berkas ditolak.", "NotAllowedError");
    }
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(new Blob([text], { type: "application/octet-stream" }));
    await writable.close();
  } catch (error) {
    if (writable.abort) { try { await writable.abort(); } catch { /* keep original error */ } }
    throw error;
  }
}

/** Save As: always asks where (system dialog / browser picker); download as last resort. */
export async function saveProjectAs(
  text: string,
  suggestedName: string,
  download: () => void,
): Promise<SaveOutcome> {
  const bridge = desktop();
  if (bridge) {
    const current = target?.kind === "desktop" ? target.path : "";
    const p = await bridge.saveProjectAs(suggestedName, text, current);
    if (!p) return { kind: "cancelled" };
    setTarget({ kind: "desktop", path: p, name: baseName(p) });
    return { kind: "saved-as", name: baseName(p) };
  }
  const win = w();
  if (win?.showSaveFilePicker && globalThis.isSecureContext) {
    try {
      const handle = await win.showSaveFilePicker({ suggestedName: `${suggestedName.replace(/\.fs$/i, "")}.fs`, types: FS_TYPES });
      await writeHandle(handle, text);
      setTarget({ kind: "handle", handle, name: handle.name });
      return { kind: "saved-as", name: handle.name };
    } catch (error) {
      const name = error && typeof error === "object" ? (error as { name?: string }).name : "";
      if (name === "AbortError") return { kind: "cancelled" };
      // Picker needs a fresh user gesture; if it was lost, fall back to a download.
      if (name !== "SecurityError") throw error;
    }
  }
  download();
  return { kind: "downloaded" };
}

/** Save: overwrite the project's file when there is one, otherwise behave like Save As. */
export async function saveProject(
  text: string,
  suggestedName: string,
  download: () => void,
): Promise<SaveOutcome> {
  const t = target;
  if (t?.kind === "desktop") {
    const bridge = desktop();
    if (bridge) {
      try {
        await bridge.saveProject(t.path, text);
        return { kind: "overwritten", name: t.name };
      } catch (error) {
        // Folder moved / disk gone: ask for a new place instead of failing.
        console.warn("[FontSeru] Overwrite failed, asking where to save.", error);
        return saveProjectAs(text, suggestedName, download);
      }
    }
  } else if (t?.kind === "handle") {
    await writeHandle(t.handle, text);
    return { kind: "overwritten", name: t.name };
  }
  if (canWriteFiles()) return saveProjectAs(text, suggestedName, download);
  download();
  return { kind: "downloaded" };
}
