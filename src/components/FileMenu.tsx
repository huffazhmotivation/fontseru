import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Cloud, CloudDownload, CloudUpload, Download, FilePlus2, FileText, FolderOpen, Loader2, Lock, Save, SaveAll, ScrollText, Trash2, X, CheckCircle2, AlertTriangle, XCircle, Info, ShieldCheck } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { useAuth } from "@/auth/AuthProvider";
import { useExportUsage } from "@/hooks/useExportUsage";
import type { FontInfo } from "@/types/font";
import { FONT_STYLES, fontStyleLabel, hasOutline, type CustomFamily, type FontStyle, type Glyph, type GlyphFamily } from "@/types/glyph";
import {
  createFontSeruProject,
  downloadProject,
  downloadBlob,
  parseFontSeruProject,
  safeFontFileBaseName,
  safeProjectBaseName,
} from "@/utils/projectIO";
import {
  CLOUD_STORAGE_QUOTA_BYTES,
  deleteCloudProject,
  getCloudStorageUsage,
  listCloudProjects,
  loadCloudProject,
  saveCloudProject,
  type CloudProjectSummary,
} from "@/utils/cloudProjects";
// `generateFontFiles` (wraps opentype.js) and `generateLicensePdf` (wraps
// jspdf) are dynamically imported at the point of use below instead of
// statically here, because they're both only needed once the user actually
// clicks Export — most sessions never touch them, so there's no reason to
// make everyone pay for opentype.js + jspdf on every app load. The type-only
// import has no runtime cost, so it stays static.
import type { ExportFontFormat } from "@/utils/fontIO";
import { effectiveKerningPairs, effectiveWordSpacing } from "@/types/kerning";
import { createZipBlob } from "@/utils/zip";
import { Toast, type ToastKind, type ToastMessage } from "@/components/Toast";
import { InfoTip } from "@/components/InfoTip";
import { runFontQA, type QAIssue, type QASeverity } from "@/utils/fontQA";

// --- Export Information System -------------------------------------------
// Purely additive: this data drives the OpenType name-table fields already
// accepted by `FontInfo` (unchanged) and two plain-text manifests bundled
// into the export ZIP. The TTF/OTF generator itself (`generateFontFiles`,
// `exportOTF`, `trueTypeWriter`) is never touched.

const QA_SEVERITY_ORDER: Record<QASeverity, number> = { error: 0, warning: 1, info: 2, pass: 3 };
const QA_SEVERITY_ICON: Record<QASeverity, ReactNode> = {
  error: <XCircle size={15} />,
  warning: <AlertTriangle size={15} />,
  info: <Info size={15} />,
  pass: <CheckCircle2 size={15} />,
};

const LICENSE_TYPE_OPTIONS = ["Personal", "Commercial", "Corporate", "Extended"] as const;
type LicenseType = (typeof LICENSE_TYPE_OPTIONS)[number] | "";

type ExportTab = "fontinfo" | "license" | "qa";

interface FontInfoFormState {
  fontName: string;
  familyName: string;
  style: string;
  designerName: string;
  designerURL: string;
  foundry: string;
  copyright: string;
  version: string;
  website: string;
  trademark: string;
}

interface LicenseInfoFormState {
  licenseType: LicenseType;
  licenseOwner: string;
  permission: string;
  restriction: string;
  note: string;
}

function emptyFontInfoForm(): FontInfoFormState {
  return {
    fontName: "",
    familyName: "",
    style: "Regular",
    designerName: "",
    designerURL: "",
    foundry: "",
    copyright: "",
    version: "1.000",
    website: "",
    trademark: "",
  };
}

function emptyLicenseInfoForm(): LicenseInfoFormState {
  return {
    licenseType: "",
    licenseOwner: "",
    permission: "",
    restriction: "",
    note: "",
  };
}


interface WritableFontFile {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?: () => Promise<void>;
}

interface FontFileHandle {
  createWritable(): Promise<WritableFontFile>;
}

interface SaveFontFilePickerOptions {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
  excludeAcceptAllOption?: boolean;
}

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options?: SaveFontFilePickerOptions) => Promise<FontFileHandle>;
};

type SaveFontResult = "saved" | "downloaded" | "cancelled";
type SaveExportExtension = "ttf" | "otf" | "zip";

function isAbortError(error: unknown): boolean {
  return !!error
    && typeof error === "object"
    && "name" in error
    && (error as { name?: unknown }).name === "AbortError";
}

async function saveFontBlob(blob: Blob, filename: string, extension: SaveExportExtension): Promise<SaveFontResult> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (typeof picker !== "function" || !globalThis.isSecureContext) {
    downloadBlob(blob, filename);
    return "downloaded";
  }

  try {
    const mimeType = extension === "ttf"
      ? "font/ttf"
      : extension === "otf"
        ? "font/otf"
        : "application/zip";
    const description = extension === "ttf"
      ? "TrueType Font"
      : extension === "otf"
        ? "OpenType Font"
        : "Font ZIP Archive";
    const handle = await picker({
      suggestedName: filename,
      types: [{
        description,
        accept: { [mimeType]: [`.${extension}`] },
      }],
    });
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      if (typeof writable.abort === "function") {
        try { await writable.abort(); } catch { /* preserve original write error */ }
      }
      throw error;
    }
    return "saved";
  } catch (error) {
    if (isAbortError(error)) return "cancelled";
    // showSaveFilePicker requires a still-active user gesture. The export
    // flow does real async work (quota check on the server, font
    // generation, zip packaging) between the click and this call, which
    // routinely burns through that transient activation window — Chrome
    // then throws a SecurityError here even though nothing about the
    // export itself failed. Don't treat that as an export failure: just
    // fall back to a normal browser download.
    if (error instanceof DOMException && error.name === "SecurityError") {
      downloadBlob(blob, filename);
      return "downloaded";
    }
    throw error;
  }
}

function snapshotFromStore() {
  const s = useAppStore.getState();
  return createFontSeruProject({
    fontName: s.fontName,
    fontInfo: s.fontInfo,
    metrics: s.metrics,
    glyphs: s.glyphsByStyle.regular,
    glyphsByStyle: s.glyphsByStyle,
    fontStyle: s.fontStyle,
    customFamilies: s.customFamilies,
    kerningPairs: s.kerningPairs,
    kerningManual: s.kerningManual,
    kerningOverridesByStyle: s.kerningOverridesByStyle,
    kerningOverrideManualByStyle: s.kerningOverrideManualByStyle,
    wordSpacingOverridesByStyle: s.wordSpacingOverridesByStyle,
    featureConfig: s.featureConfig,
    activeChar: s.activeChar,
    gridSize: s.gridSize,
    showGrid: s.showGrid,
    showGuides: s.showGuides,
    snapEnabled: s.snapEnabled,
    ghost: s.ghost,
    brush: s.brush,
  });
}

function hydrateProject(project: ReturnType<typeof parseFontSeruProject>, filename: string) {
  const s = useAppStore.getState();
  s.hydrate({
    glyphs: project.font.glyphs,
    glyphsByStyle: project.font.glyphsByStyle,
    fontStyle: project.editor.fontStyle,
    customFamilies: project.font.customFamilies,
    fontName: project.font.name,
    fontInfo: project.font.info,
    projectFileName: filename,
    metrics: project.font.metrics,
    kerningPairs: project.font.kerningPairs,
    kerningManual: project.font.kerningManual,
    kerningOverridesByStyle: project.font.kerningOverridesByStyle,
    kerningOverrideManualByStyle: project.font.kerningOverrideManualByStyle,
    wordSpacingOverridesByStyle: project.font.wordSpacingOverridesByStyle,
    featureConfig: project.font.featureConfig,
    activeChar: project.editor.activeChar,
    gridSize: project.editor.gridSize,
    showGrid: project.editor.showGrid,
    showGuides: project.editor.showGuides,
    snapEnabled: project.editor.snapEnabled,
    ghost: project.editor.ghost,
    brush: project.editor.brush,
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function userFileError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    message.startsWith("Choose a ") ||
    message.startsWith("Not a FontSeru") ||
    message.startsWith("Unsupported FontSeru") ||
    message.startsWith("Incomplete FontSeru") ||
    message.includes("no Unicode-mapped glyphs")
  ) return message;
  return "Unable to open this file. Please make sure it is a valid FontSeru project, TTF, or OTF font.";
}

type FamilyStyleSelection = Record<FontStyle, boolean>;

/** Every exportable Glyph tab, in the same Regular → Bold → Italic → custom
 * order shown everywhere else (Glyph panel tabs, Family panel, Test Lab).
 * Centralized here so the export list stays in sync with however many
 * custom families currently exist, without touching the TTF/OTF generator
 * itself. */
function exportableStyleList(customFamilies: ReadonlyArray<CustomFamily>): Array<{ id: FontStyle; label: string }> {
  return [...FONT_STYLES, ...customFamilies.map((f) => ({ id: f.id, label: f.name }))];
}

function hasExportableVectorGlyph(glyph: Glyph): boolean {
  if (!hasOutline(glyph)) return false;
  return glyph.outline.objects.some((object) =>
    object.contours.some((contour) => contour.nodes.length >= 2),
  );
}

function detectExportableStyles(family: GlyphFamily, customFamilies: ReadonlyArray<CustomFamily>): FamilyStyleSelection {
  const result: FamilyStyleSelection = {};
  for (const { id } of exportableStyleList(customFamilies)) {
    result[id] = Object.values(family[id] ?? {}).some(hasExportableVectorGlyph);
  }
  return result;
}

function selectedExportStyles(
  selected: FamilyStyleSelection,
  available: FamilyStyleSelection,
  customFamilies: ReadonlyArray<CustomFamily>,
): FontStyle[] {
  return exportableStyleList(customFamilies)
    .map(({ id }) => id)
    .filter((style) => selected[style] && available[style]);
}

export function FileMenu({ onExportButtonReady }: { onExportButtonReady?: (open: () => void) => void }) {
  const [open, setOpen] = useState(false);
  // The dropdown is rendered with `position: fixed` at this JS-computed
  // viewport position instead of `position: absolute` relative to the
  // trigger button (see the matching CSS comment on `.fm-filemenu`). This
  // is what lets it open correctly regardless of the topbar's own
  // horizontal scroll position/state on tablet and phone widths, where
  // the topbar is a horizontally-scrolling single row (see `.fm-topbar`
  // in app.css) that would otherwise clip an absolutely-positioned child
  // taller than the bar itself.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Real progress for the Export button: one step per selected style's font
  // generation, plus one final step for zipping the result — not a fake
  // timer, so it always reflects how much of `runExport` has actually run.
  // Mirrors the Cloud Save flow's `{ percent, label }` progress shape so the
  // export dialog can reuse the exact same progress-bar treatment.
  const [exportProgress, setExportProgress] = useState(0);
  const [exportProgressLabel, setExportProgressLabel] = useState("Menyiapkan…");
  // Set once `runExport` finishes successfully; drives the same style of
  // confirmation dialog as `cloudSaveSuccess` below instead of an easy-to-
  // miss toast, since a font export is a heavier action worth confirming.
  const [exportSuccess, setExportSuccess] = useState<{ zipName: string; styleCount: number } | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastId = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuWrapRef = useRef<HTMLDivElement>(null);

  // The File dropdown previously only closed when an action inside it was
  // clicked — tapping anywhere else (the canvas, another toolbar button,
  // etc) left it open on top of the UI. Escape is handled with a plain
  // window listener (safe — it's a keyboard event, unrelated to the click
  // that opens the menu). "Click outside" is handled below via a rendered
  // backdrop (see `.fm-filemenu-backdrop` in the JSX), not a manually
  // attached document pointerdown/click listener — that approach was tried
  // first but could race with the very click that opens the menu on some
  // browsers (the manual listener can end up seeing part of the *same*
  // opening click and immediately closing it again, which made the menu
  // look like it "wouldn't open"). A backdrop element only exists in the
  // DOM once `open` is already true, so it can never see the click that
  // set `open` to true in the first place.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Closes the menu on any scroll (including the topbar's own horizontal
  // scroll — scroll events don't bubble, so this has to be attached with
  // `capture: true` on window to see them) or resize, rather than trying
  // to continuously reposition it. The menu is short-lived and this keeps
  // it from ever being left floating over the wrong spot.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const openMenu = useCallback(() => {
    const rect = menuWrapRef.current?.getBoundingClientRect();
    const menuWidth = 210;
    const left = rect
      ? Math.max(10, Math.min(rect.left, window.innerWidth - menuWidth - 10))
      : 14;
    const top = rect ? rect.bottom + 8 : 60;
    setMenuPos({ top, left });
    setOpen(true);
  }, []);

  const projectFileName = useAppStore((s) => s.projectFileName);
  const setProjectFileName = useAppStore((s) => s.setProjectFileName);
  const newProject = useAppStore((s) => s.newProject);
  const glyphsByStyle = useAppStore((s) => s.glyphsByStyle);
  const customFamilies = useAppStore((s) => s.customFamilies);
  const qaFontStyle = useAppStore((s) => s.fontStyle);
  const qaMetrics = useAppStore((s) => s.metrics);
  const qaFontInfo = useAppStore((s) => s.fontInfo);
  const setFontInfo = useAppStore((s) => s.setFontInfo);
  const setFontName = useAppStore((s) => s.setFontName);
  const qaKerningPairs = useAppStore((s) => s.kerningPairs);
  const qaKerningOverridesByStyle = useAppStore((s) => s.kerningOverridesByStyle);
  const qaFeatureConfig = useAppStore((s) => s.featureConfig);
  const styleAvailability = detectExportableStyles(glyphsByStyle, customFamilies);
  const openProModal = useAppStore((s) => s.openProModal);
  const { isPro, isConfigured, user } = useAuth();

  // --- Cloud save/open ----------------------------------------------------
  // Lets a project saved from one device be opened on another, on top of
  // the existing local-only IndexedDB autosave and manual .fs download.
  // Cloud Save is a PRO feature (same tier gate as Family export): the menu
  // items stay visible to any signed-in FREE user (dimmed, with a lock
  // icon) so they know it exists, but tapping opens the ProUpsellModal
  // instead of the dialog. The real enforcement is server-side in
  // supabase/sql/projects_table.sql (RLS checks profiles.plan = 'pro'), so
  // this client-side lock can't be bypassed by forcing the UI state.
  const cloudVisible = isConfigured && Boolean(user);
  const cloudLocked = cloudVisible && !isPro;
  const [cloudDialog, setCloudDialog] = useState<"open" | "save" | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudProjects, setCloudProjects] = useState<CloudProjectSummary[] | null>(null);
  const [cloudActionId, setCloudActionId] = useState<string | null>(null);
  const [cloudSaveName, setCloudSaveName] = useState("");
  const [cloudSaving, setCloudSaving] = useState(false);
  const [cloudUsageBytes, setCloudUsageBytes] = useState<number | null>(null);
  // Progress shown while a save is in flight, and the abort handle that lets
  // the user actually cancel a stuck save instead of being stuck watching a
  // spinner with no way out. `cloudSaveSuccess` drives a confirmation dialog
  // that stays up until the user closes it (see confirmSaveToCloud below),
  // rather than an auto-dismissing toast that can vanish before it's read.
  const [cloudSaveProgress, setCloudSaveProgress] = useState<{ percent: number; label: string } | null>(null);
  const [cloudSaveSuccess, setCloudSaveSuccess] = useState<string | null>(null);
  const cloudSaveAbortRef = useRef<AbortController | null>(null);
  // Same idea as the save-progress state above, but for opening a project
  // from Cloud: `cloudActionId` already tracks which item is busy (shared
  // with delete), and this carries the percent/label for that item while
  // it's specifically an "open" in progress rather than a delete.
  const [cloudOpenProgress, setCloudOpenProgress] = useState<{ percent: number; label: string } | null>(null);
  const cloudOpenAbortRef = useRef<AbortController | null>(null);

  const refreshCloudProjects = useCallback(async () => {
    setCloudBusy(true);
    setCloudError(null);
    try {
      const [list, usage] = await Promise.all([listCloudProjects(), getCloudStorageUsage()]);
      setCloudProjects(list);
      setCloudUsageBytes(usage);
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : "Unable to load cloud projects.");
    } finally {
      setCloudBusy(false);
    }
  }, []);

  const openCloudDialog = useCallback(() => {
    if (cloudLocked) {
      setOpen(false);
      openProModal("cloud");
      return;
    }
    setOpen(false);
    setCloudDialog("open");
    void refreshCloudProjects();
  }, [cloudLocked, openProModal, refreshCloudProjects]);

  const openSaveToCloudDialog = useCallback(() => {
    if (cloudLocked) {
      setOpen(false);
      openProModal("cloud");
      return;
    }
    setOpen(false);
    setCloudSaveName(safeProjectBaseName(useAppStore.getState().fontName || projectFileName));
    setCloudError(null);
    setCloudDialog("save");
    void refreshCloudProjects();
  }, [cloudLocked, openProModal, projectFileName, refreshCloudProjects]);

  const confirmSaveToCloud = useCallback(async () => {
    const name = safeProjectBaseName(cloudSaveName);
    if (!name) return;
    const controller = new AbortController();
    cloudSaveAbortRef.current = controller;
    setCloudSaving(true);
    setCloudError(null);
    setCloudSaveProgress({ percent: 0, label: "Menyiapkan…" });
    try {
      await saveCloudProject(name, snapshotFromStore(), {
        signal: controller.signal,
        onProgress: (progress) => setCloudSaveProgress(progress),
      });
      setCloudDialog(null);
      // A dedicated, manually-dismissed confirmation instead of the
      // ephemeral Toast: cloud save is easy to miss/misread if it's gone
      // in ~3s, so this one stays up until the user closes it.
      setCloudSaveSuccess(name);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        // User cancelled on purpose — nothing to report.
      } else {
        console.error("[FontSeru] Cloud save failed.", error);
        setCloudError(error instanceof Error ? error.message : "Unable to save to Cloud.");
        void refreshCloudProjects(); // usage may have changed even on a failed/partial attempt
      }
    } finally {
      setCloudSaving(false);
      setCloudSaveProgress(null);
      cloudSaveAbortRef.current = null;
    }
  }, [cloudSaveName, refreshCloudProjects]);

  const cancelCloudSave = useCallback(() => {
    cloudSaveAbortRef.current?.abort();
  }, []);

  const openFromCloud = useCallback(async (summary: CloudProjectSummary) => {
    const controller = new AbortController();
    cloudOpenAbortRef.current = controller;
    setCloudActionId(summary.id);
    setCloudError(null);
    setCloudOpenProgress({ percent: 0, label: "Menyiapkan…" });
    try {
      const { name, project } = await loadCloudProject(summary.id, {
        signal: controller.signal,
        onProgress: (progress) => setCloudOpenProgress(progress),
      });
      hydrateProject(project, `${name}.fs`);
      useAppStore.getState().setFontName(name);
      setCloudDialog(null);
      showToast(`Opened "${name}" from Cloud`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        // User cancelled on purpose — nothing to report.
      } else {
        console.error("[FontSeru] Cloud open failed.", error);
        setCloudError(error instanceof Error ? error.message : "Unable to open this cloud project.");
      }
    } finally {
      setCloudActionId(null);
      setCloudOpenProgress(null);
      cloudOpenAbortRef.current = null;
    }
  }, []);

  const cancelCloudOpen = useCallback(() => {
    cloudOpenAbortRef.current?.abort();
  }, []);

  const deleteFromCloud = useCallback(async (summary: CloudProjectSummary) => {
    if (!window.confirm(`Delete "${summary.name}" from Cloud? This cannot be undone.`)) return;
    setCloudActionId(summary.id);
    setCloudError(null);
    try {
      await deleteCloudProject(summary.id);
      setCloudProjects((current) => current?.filter((item) => item.id !== summary.id) ?? current);
    } catch (error) {
      console.error("[FontSeru] Cloud delete failed.", error);
      setCloudError(error instanceof Error ? error.message : "Unable to delete this cloud project.");
    } finally {
      setCloudActionId(null);
    }
  }, []);

  const cloudSaveNameTaken = cloudDialog === "save"
    && cloudProjects?.some((item) => item.name.toLowerCase() === safeProjectBaseName(cloudSaveName).toLowerCase())
    === true;
  const { usage: exportUsage, refresh: refreshExportUsage, consumeExport } = useExportUsage();

  // Multi-select: each format button toggles independently. Picking more
  // than one (e.g. TTF + OTF, or all four) exports every selected binary
  // into the same export ZIP — there's no separate "both" mode anymore.
  const [formats, setFormats] = useState<ExportFontFormat[]>(["ttf"]);
  const toggleFormat = useCallback((value: ExportFontFormat) => {
    setFormats((current) => {
      if (current.includes(value)) {
        // Keep at least one format selected.
        if (current.length === 1) return current;
        return current.filter((item) => item !== value);
      }
      return [...current, value];
    });
  }, []);
  const [exportTab, setExportTab] = useState<ExportTab>("fontinfo");
  const [fontInfoForm, setFontInfoForm] = useState<FontInfoFormState>(emptyFontInfoForm);
  const [licenseInfoForm, setLicenseInfoForm] = useState<LicenseInfoFormState>(emptyLicenseInfoForm);
  const [nameTablePreviewOpen, setNameTablePreviewOpen] = useState(false);
  // `normalizeFontMetadata`/`previewNameTableRecords` live in fontIO.ts,
  // which pulls in opentype.js at module scope — loaded lazily here (only
  // once the Export dialog is actually open) so opening the app never pays
  // for opentype.js, same reasoning as the existing dynamic `generateFontFiles`
  // import in runExport below.
  const [nameTableTools, setNameTableTools] = useState<Pick<
    typeof import("@/utils/fontIO"),
    "normalizeFontMetadata" | "previewNameTableRecords"
  > | null>(null);
  const [selectedStyles, setSelectedStyles] = useState<FamilyStyleSelection>({
    regular: true,
  });

  // "Combine as one family": when 2+ styles are exported, group them all
  // under ONE typographic family (nameID 16) with distinct subfamilies
  // (nameID 17) plus per-face OS/2 disambiguation, so a set like
  // "Regular Clean / Regular Rough / Italic Clean / Italic Rough" installs
  // and shows up as a single family on Mac (Font Book) and Windows instead
  // of four separate families. Defaults ON — that's what a designer building
  // a family almost always wants; can be turned off to keep every style as
  // its own independent family.
  const [combineFamily, setCombineFamily] = useState(true);

  // Per-style manual overrides for the exported nameID 1/16 (Family Name)
  // and nameID 2/17 (Style/Subfamily Name) — used in Family exports (2+
  // styles at once) and for custom families, where the auto-generated
  // label often isn't what the designer actually wants baked into the
  // font (e.g. a custom family that's really its own distinct typeface,
  // not a Bold/Italic variant of the main one). Blank = fall back to the
  // existing automatic behavior for that field, so nothing changes for
  // anyone who doesn't touch these.
  const [styleNameOverrides, setStyleNameOverrides] = useState<
    Record<string, { familyName: string; styleName: string }>
  >({});
  const setStyleNameOverride = useCallback(
    (id: FontStyle, field: "familyName" | "styleName", value: string) => {
      setStyleNameOverrides((current) => ({
        ...current,
        [id]: { familyName: current[id]?.familyName ?? "", styleName: current[id]?.styleName ?? "", [field]: value },
      }));
    },
    [],
  );

  const setFontInfoField = useCallback(<K extends keyof FontInfoFormState>(field: K, value: FontInfoFormState[K]) => {
    setFontInfoForm((current) => ({ ...current, [field]: value }));
  }, []);

  const setLicenseInfoField = useCallback(<K extends keyof LicenseInfoFormState>(field: K, value: LicenseInfoFormState[K]) => {
    setLicenseInfoForm((current) => ({ ...current, [field]: value }));
  }, []);

  // Runs against the currently active editing style — metadata, metrics,
  // kerning structure and OpenType Feature rules are shared/family-level
  // concerns anyway, and glyph geometry is checked for whichever style the
  // designer is actually looking at right now. Recomputes live as the
  // export dialog stays open, so fixes made elsewhere reflect immediately.
  const qaReport = useMemo(() => {
    const qaGlyphs = glyphsByStyle[qaFontStyle] ?? glyphsByStyle.regular ?? {};
    const effectiveKerning = effectiveKerningPairs(qaKerningPairs, qaKerningOverridesByStyle, qaFontStyle);
    // Export dialog keeps its own draft (fontInfoForm/licenseInfoForm) that
    // only gets written back into the store when Export actually runs (see
    // runExport below). QA Check has to reflect what's on screen *right
    // now*, not the stale store snapshot from before the dialog opened —
    // otherwise fixes made in Font Info/License Info tabs never clear their
    // own warnings until after export. Mirrors the merge nameTablePreview
    // already does above.
    const liveFamilyName = fontInfoForm.familyName.trim() || qaFontInfo.familyName;
    // BUG FIX: this object used to spread `...qaFontInfo` and override
    // familyName/designer/etc, but never touched `fullName` — so it stayed
    // whatever stale value was last saved in the project (e.g. an old
    // working title), even after the real export path was fixed to derive
    // Full Name from Family Name. QA Check kept flagging "Full Name tidak
    // diawali Family Name" forever, because it was checking a value this
    // dialog never actually recomputes. Derive it live here the same way
    // the real export/preview do.
    const liveInfo: FontInfo = {
      ...qaFontInfo,
      familyName: liveFamilyName,
      styleName: fontStyleLabel(qaFontStyle, customFamilies),
      fullName: `${liveFamilyName} ${fontStyleLabel(qaFontStyle, customFamilies)}`,
      designer: fontInfoForm.designerName.trim(),
      designerURL: fontInfoForm.designerURL.trim(),
      manufacturer: fontInfoForm.foundry.trim(),
      manufacturerURL: fontInfoForm.website.trim(),
      trademark: fontInfoForm.trademark.trim(),
      copyright: fontInfoForm.copyright.trim(),
      version: fontInfoForm.version.trim(),
      license: licenseInfoForm.licenseOwner.trim()
        ? `${licenseInfoForm.licenseType || "Personal"} - ${licenseInfoForm.licenseOwner.trim()}`
        : licenseInfoForm.licenseType || qaFontInfo.license,
    };
    return runFontQA({
      glyphs: qaGlyphs,
      metrics: qaMetrics,
      info: liveInfo,
      kerningPairs: effectiveKerning,
      featureConfig: qaFeatureConfig,
    });
  }, [
    glyphsByStyle,
    qaFontStyle,
    qaMetrics,
    qaFontInfo,
    qaKerningPairs,
    qaKerningOverridesByStyle,
    qaFeatureConfig,
    fontInfoForm,
    licenseInfoForm.licenseOwner,
    licenseInfoForm.licenseType,
    customFamilies,
  ]);

  const dismissToast = useCallback(() => setToast(null), []);
  const showToast = useCallback((message: string, kind: ToastKind = "success") => {
    setToast({ id: ++toastId.current, kind, message });
  }, []);


  const beginExport = useCallback(() => {
    const s = useAppStore.getState();
    const initialFontName = s.fontInfo.familyName?.trim() || s.fontName || "";
    const existingLicense = s.fontInfo.license?.trim() || "";
    const knownLicenseType = LICENSE_TYPE_OPTIONS.find((option) => existingLicense.toLowerCase().startsWith(option.toLowerCase()));

    setFontInfoForm({
      fontName: initialFontName,
      familyName: s.fontInfo.familyName?.trim() || initialFontName,
      style: fontStyleLabel(s.fontStyle, s.customFamilies),
      designerName: s.fontInfo.designer?.trim() || "",
      designerURL: s.fontInfo.designerURL?.trim() || "",
      foundry: s.fontInfo.manufacturer?.trim() || "",
      copyright: s.fontInfo.copyright?.trim() || (initialFontName ? `Copyright © ${new Date().getFullYear()} ${initialFontName}` : ""),
      version: s.fontInfo.version?.trim() || "1.000",
      website: s.fontInfo.manufacturerURL?.trim() || "",
      trademark: s.fontInfo.trademark?.trim() || "",
    });
    setLicenseInfoForm({
      licenseType: knownLicenseType ?? "",
      licenseOwner: s.fontInfo.designer?.trim() || "",
      permission: "",
      restriction: "",
      note: "",
    });
    setFormats(["ttf"]);
    setSelectedStyles(detectExportableStyles(s.glyphsByStyle, s.customFamilies));
    setExportTab("fontinfo");
    setExportOpen(true);
    setOpen(false);
    void refreshExportUsage();
  }, [refreshExportUsage]);

  useEffect(() => {
    onExportButtonReady?.(beginExport);
  }, [beginExport, onExportButtonReady]);

  // Persist the current FONT INFO / LICENSE INFO drafts into the project
  // store WITHOUT running an export, so the data isn't lost if the user
  // closes the dialog (or the app) before exporting. Mirrors exactly the
  // field mapping runExport uses to build its FontInfo, so a later export
  // produces identical name-table records. Called by the "Save Info" button.
  const [infoSaved, setInfoSaved] = useState(false);
  const saveFontInfoDraft = useCallback(() => {
    const fontName = fontInfoForm.fontName.trim();
    if (!fontName) {
      showToast("Font Name wajib diisi sebelum menyimpan.", "error");
      setExportTab("fontinfo");
      return;
    }
    const familyName = fontInfoForm.familyName.trim() || fontName;
    const styleName = fontInfoForm.style.trim() || qaFontInfo.styleName || "Regular";
    const resolvedLicense = licenseInfoForm.licenseOwner.trim()
      ? `${licenseInfoForm.licenseType || "Personal"} - ${licenseInfoForm.licenseOwner.trim()}`
      : (licenseInfoForm.licenseType || qaFontInfo.license || "");
    const patch: Partial<FontInfo> = {
      familyName,
      styleName,
      fullName: `${familyName} ${styleName}`.trim(),
      designer: fontInfoForm.designerName.trim(),
      designerURL: fontInfoForm.designerURL.trim(),
      manufacturer: fontInfoForm.foundry.trim(),
      manufacturerURL: fontInfoForm.website.trim(),
      trademark: fontInfoForm.trademark.trim(),
      copyright: fontInfoForm.copyright.trim(),
      version: fontInfoForm.version.trim() || "1.000",
      license: resolvedLicense,
      licenseURL: fontInfoForm.website.trim(),
    };
    setFontInfo(patch);
    // Keep the project's display name in sync with the family name the way
    // renaming the font elsewhere does, so the two never drift apart.
    if (familyName) setFontName(familyName);
    setInfoSaved(true);
    window.setTimeout(() => setInfoSaved(false), 2000);
    showToast("Font Info & License tersimpan.", "success");
  }, [fontInfoForm, licenseInfoForm, qaFontInfo, setFontInfo, setFontName, showToast]);

  useEffect(() => {
    if (!exportOpen || nameTableTools) return;
    let cancelled = false;
    void import("@/utils/fontIO").then(({ normalizeFontMetadata, previewNameTableRecords }) => {
      if (!cancelled) setNameTableTools({ normalizeFontMetadata, previewNameTableRecords });
    });
    return () => {
      cancelled = true;
    };
  }, [exportOpen, nameTableTools]);

  // Mirrors the metadata the real export builds in runExport below (same
  // fallbacks, same license-string join) so this preview never drifts from
  // what actually gets written to the font. Only the first selected style
  // is shown — a multi-style Family export gets its own Regular/Bold/Italic
  // subfamily per file, but the rest of the record set is identical.
  const nameTablePreview = useMemo(() => {
    if (!nameTableTools) return null;
    const fontName = fontInfoForm.fontName.trim();
    if (!fontName) return null;
    const familyName = fontInfoForm.familyName.trim() || fontName;
    const styleName = fontInfoForm.style.trim() || "Regular";
    const resolvedLicense = licenseInfoForm.licenseOwner.trim()
      ? `${licenseInfoForm.licenseType || "Personal"} - ${licenseInfoForm.licenseOwner.trim()}`
      : licenseInfoForm.licenseType || "All Rights Reserved";

    const previewInfo: Partial<FontInfo> = {
      familyName,
      styleName,
      // BUG FIX: this used to build Full Name from `fontName` (the "Font
      // Name" field) instead of `familyName` ("Family Name"). Those two
      // fields can diverge — e.g. a leftover working title like "rough 2"
      // in Font Name while Family Name was renamed to the real brand name
      // — and Full Name silently kept the stale value, tripping the QA
      // Check's "Full Name tidak diawali Family Name" warning with no way
      // to fix it from the UI. Full Name must start with Family Name by
      // OpenType convention, so derive it from `familyName`.
      fullName: `${familyName} ${styleName}`,
      postscriptName: "",
      uniqueID: "",
      designer: fontInfoForm.designerName.trim(),
      designerURL: fontInfoForm.designerURL.trim(),
      manufacturer: fontInfoForm.foundry.trim(),
      manufacturerURL: fontInfoForm.website.trim(),
      trademark: fontInfoForm.trademark.trim(),
      copyright: fontInfoForm.copyright.trim(),
      version: fontInfoForm.version.trim(),
      license: resolvedLicense,
      licenseURL: fontInfoForm.website.trim(),
    };
    const normalized = nameTableTools.normalizeFontMetadata(previewInfo, fontName);
    return nameTableTools.previewNameTableRecords(normalized);
  }, [nameTableTools, fontInfoForm, licenseInfoForm.licenseOwner, licenseInfoForm.licenseType]);

  // Family-aware summary: when more than one style is selected for export
  // (Regular + Bold/Italic, or any custom family), the name table preview
  // should show EACH style's Family Name (nameID 1) and Subfamily (nameID 2)
  // that will be written to its own file — not just the first style — so a
  // designer building a family can confirm the whole set before exporting.
  // Each row mirrors the exact family/subfamily resolution runExport uses
  // (per-row override first, else the automatic style label / family name).
  const familyNameTablePreview = useMemo(() => {
    const baseFamily = fontInfoForm.familyName.trim() || fontInfoForm.fontName.trim();
    if (!baseFamily) return null;
    const selected = selectedExportStyles(
      selectedStyles,
      detectExportableStyles(glyphsByStyle, customFamilies),
      customFamilies,
    );
    if (selected.length <= 1) return null; // not a family — single-style preview already covers it
    const styleOverride = fontInfoForm.style.trim();
    return selected.map((style) => {
      const override = styleNameOverrides[style];
      const subfamily =
        override?.styleName.trim() ||
        (selected.length === 1 && styleOverride ? styleOverride : fontStyleLabel(style, customFamilies));
      const family = override?.familyName.trim() || baseFamily;
      return { style, family, subfamily, fullName: `${family} ${subfamily}`.trim() };
    });
  }, [fontInfoForm, selectedStyles, glyphsByStyle, customFamilies, styleNameOverrides]);

  const save = () => {
    try {
      // Always derive from the live font name so a rename is picked up
      // automatically, even if this project was already saved before.
      const name = `${safeProjectBaseName(useAppStore.getState().fontName || projectFileName)}.fs`;
      downloadProject(snapshotFromStore(), name);
      setProjectFileName(name);
      showToast("Project saved");
    } catch (error) {
      console.error("[FontSeru] Project save failed.", error);
      showToast("Unable to save the project.", "error");
    } finally {
      setOpen(false);
    }
  };

  const saveAs = () => {
    const current = safeProjectBaseName(useAppStore.getState().fontName || projectFileName);
    const chosen = window.prompt("Save FontSeru project as", current);
    if (!chosen) return;
    try {
      const filename = `${safeProjectBaseName(chosen)}.fs`;
      setProjectFileName(filename);
      downloadProject(snapshotFromStore(), filename);
      showToast("Project saved");
    } catch (error) {
      console.error("[FontSeru] Project save-as failed.", error);
      showToast("Unable to save the project.", "error");
    } finally {
      setOpen(false);
    }
  };

  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase();
      // The top-left name panel should always reflect the file that's
      // actually open, not whatever font/family name happens to be stored
      // inside it — so every import path derives the displayed name from
      // the opened filename itself (extension stripped), then applies it
      // via setFontName right after hydrating so it also runs the existing
      // "keep family name in sync" logic that setFontName already does.
      const derivedName = file.name.replace(/\.[^./\\]+$/, "").trim() || file.name;
      if (ext === "fs") {
        const project = parseFontSeruProject(await file.text());
        hydrateProject(project, file.name);
        useAppStore.getState().setFontName(derivedName);
        showToast("Project opened");
      } else if (ext === "ttf" || ext === "otf") {
        const { importOpenType } = await import("@/utils/fontIO");
        const imported = importOpenType(await file.arrayBuffer());
        useAppStore.getState().hydrate({
          glyphs: imported.glyphs,
          fontName: derivedName,
          fontInfo: imported.fontInfo,
          projectFileName: `${safeProjectBaseName(derivedName)}.fs`,
          metrics: imported.metrics,
          kerningPairs: imported.kerningPairs,
          kerningManual: {},
          activeChar: Object.keys(imported.glyphs)[0],
        });
        showToast("Font imported successfully");
      } else {
        throw new Error("Choose a .fs, .ttf, or .otf file.");
      }
    } catch (error) {
      console.error("[FontSeru] File import/open failed.", error);
      showToast(userFileError(error), "error");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
      setOpen(false);
    }
  };

  const runExport = async () => {
    if (busy) return;

    // --- Export Information System validation ---------------------------
    // Font name and Designer are required in FONT INFO; a License Type must
    // be picked in LICENSE INFO. None of this touches the TTF/OTF engine.
    const fontName = fontInfoForm.fontName.trim();
    if (!fontName) {
      showToast("Font Name wajib diisi.", "error");
      setExportTab("fontinfo");
      return;
    }

    const designerName = fontInfoForm.designerName.trim();
    if (!designerName) {
      showToast("Designer Name wajib diisi.", "error");
      setExportTab("fontinfo");
      return;
    }

    if (!licenseInfoForm.licenseType) {
      showToast("Pilih License Type sebelum export.", "error");
      setExportTab("license");
      return;
    }

    const familyName = fontInfoForm.familyName.trim() || fontName;
    const foundry = fontInfoForm.foundry.trim();
    const website = fontInfoForm.website.trim();
    const designerURL = fontInfoForm.designerURL.trim();
    const trademark = fontInfoForm.trademark.trim();
    const version = fontInfoForm.version.trim() || "1.000";
    const copyright = fontInfoForm.copyright.trim() || `Copyright © ${new Date().getFullYear()} ${fontName}`;
    const resolvedLicense = licenseInfoForm.licenseOwner.trim()
      ? `${licenseInfoForm.licenseType} - ${licenseInfoForm.licenseOwner.trim()}`
      : licenseInfoForm.licenseType;

    const availableAtExport = detectExportableStyles(useAppStore.getState().glyphsByStyle, useAppStore.getState().customFamilies);
    // Real enforcement point (not just checkbox styling): FREE accounts can
    // only ever export Regular, regardless of what `selectedStyles` holds.
    // Bold/Italic/custom families are all PRO-gated the same way.
    const allowedAtExport: FamilyStyleSelection = isPro
      ? availableAtExport
      : Object.fromEntries(
          Object.keys(availableAtExport).map((id) => [id, id === "regular" ? availableAtExport.regular : false]),
        );
    const styles = selectedExportStyles(selectedStyles, allowedAtExport, useAppStore.getState().customFamilies);
    if (!styles.length) {
      showToast("Select at least one style with vector glyphs.", "error");
      return;
    }

    // Real enforcement point for the FREE export limit (1x/calendar month).
    // This runs right before the font is actually generated/downloaded —
    // not just when the button is styled — and the allow/deny decision is
    // made server-side by the `increment_export_usage` RPC, so it can't be
    // bypassed by editing client code. PRO accounts always come back
    // allowed=true here and are never counted.
    setBusy(true);
    setExportProgress(0);
    setExportProgressLabel("Menyiapkan…");
    const quota = await consumeExport();
    if (!quota.allowed) {
      setBusy(false);
      setExportOpen(false);
      openProModal("export");
      return;
    }

    // One progress step per selected style's font generation, plus one for
    // the final zip packaging (manifests + PDF + zip encoding).
    const totalExportSteps = styles.length + 1;
    let completedExportSteps = 0;
    const advanceExportProgress = (nextLabel?: string) => {
      completedExportSteps++;
      setExportProgress(completedExportSteps / totalExportSteps);
      if (nextLabel) setExportProgressLabel(nextLabel);
    };

    try {
      const s = useAppStore.getState();
      const baseName = safeFontFileBaseName(fontName);
      const multiStyle = styles.length > 1;
      const files: Array<{
        extension: "ttf" | "otf" | "woff" | "woff2";
        name: string;
        blob: Blob;
      }> = [];

      // A user-entered Style name (FONT INFO tab) is honored for the common
      // single-style export. For Family exports (2+ styles) and any custom
      // family, `styleNameOverrides` (typed per-row in the Styles list)
      // takes priority when the designer actually filled it in — falling
      // back to the automatic Regular/Bold/Italic label (or the automatic
      // family name) exactly like before when left blank.
      const styleOverride = fontInfoForm.style.trim();

      const { generateFontFiles } = await import("@/utils/fontIO");

      // FAMILY GROUPING: when the user asks to combine 2+ styles into one
      // family, pick a shared typographic family name (nameID 16) — the base
      // Family Name field — and hand each face a distinct subfamily + a
      // disambiguated OS/2 identity so Font Book / Windows treat them as one
      // family with several members. The reference (Regular) face is the
      // first non-italic style, else the first style.
      const groupAsFamily = combineFamily && styles.length > 1;
      const sharedTypographicFamily = familyName;
      const styleLabelFor = (style: FontStyle) => {
        const ov = styleNameOverrides[style];
        return (
          ov?.styleName.trim() ||
          (styles.length === 1 && styleOverride ? styleOverride : fontStyleLabel(style, s.customFamilies))
        );
      };
      const regularRefStyle = groupAsFamily
        ? (styles.find((st) => !/\b(italic|oblique)\b/i.test(styleLabelFor(st))) ?? styles[0])
        : null;

      // Family export is orchestration only: each selected style still passes
      // through the existing font generator and its validation pipeline.
      for (let styleIdx = 0; styleIdx < styles.length; styleIdx++) {
        const style = styles[styleIdx];
        const override = styleNameOverrides[style];
        const styleName =
          override?.styleName.trim() ||
          (styles.length === 1 && styleOverride ? styleOverride : fontStyleLabel(style, s.customFamilies));
        // When grouping, every file's Family Name is the shared typographic
        // family; otherwise keep the per-style family (old behavior).
        const styleFamilyName = groupAsFamily
          ? sharedTypographicFamily
          : (override?.familyName.trim() || familyName);
        const grouping = groupAsFamily
          ? {
              typographicFamily: sharedTypographicFamily,
              typographicSubfamily: styleName,
              faceIndex: styleIdx,
              faceCount: styles.length,
              isRegularReference: style === regularRefStyle,
            }
          : undefined;
        const exportInfo: FontInfo = {
          ...s.fontInfo,
          familyName: styleFamilyName,
          styleName,
          fullName: `${styleFamilyName} ${styleName}`,
          postscriptName: "",
          uniqueID: "",
          designer: designerName,
          designerURL,
          manufacturer: foundry,
          manufacturerURL: website,
          trademark,
          copyright,
          version,
          license: resolvedLicense,
          licenseURL: website,
        };

        const effectiveKerning = effectiveKerningPairs(
          s.kerningPairs,
          s.kerningOverridesByStyle,
          style,
        );
        // Each exported style's space glyph should match the word spacing
        // this style actually previews with — Bold/Italic can have their
        // own override (see wordSpacingOverridesByStyle), otherwise they
        // fall back to the shared metrics.wordSpacing like everything else.
        const styleWordSpacing = effectiveWordSpacing(s.metrics.wordSpacing, s.wordSpacingOverridesByStyle, style);
        const styleMetrics = styleWordSpacing !== undefined
          ? { ...s.metrics, wordSpacing: styleWordSpacing }
          : s.metrics;
        setExportProgressLabel(multiStyle ? `Generating ${styleName}…` : "Generating font…");
        let generated: Awaited<ReturnType<typeof generateFontFiles>>;
        try {
          generated = await generateFontFiles(
            s.glyphsByStyle[style],
            styleMetrics,
            exportInfo,
            effectiveKerning,
            formats,
            s.featureConfig,
            grouping,
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to export ${styleName}. ${detail}`);
        }
        if (!generated.length) throw new Error(`No font file was generated for ${styleName}.`);

        const fileBase = multiStyle || style !== "regular"
          ? `${baseName}-${styleName}`
          : baseName;

        for (const file of generated) {
          files.push({
            extension: file.extension,
            name: `${fileBase}.${file.extension}`,
            blob: new Blob([file.buffer], { type: file.mimeType }),
          });
        }
        advanceExportProgress();
      }

      // --- Export Information System: manifests -----------------------
      // Bundled into the ZIP alongside the untouched TTF/OTF output.
      const creationDate = new Date().toISOString().slice(0, 10);
      const textEncoder = (text: string) => new Blob([text], { type: "text/plain" });

      const fontInfoText = [
        `Name: ${fontName}`,
        `Designer: ${designerName}`,
        `Version: ${version}`,
        `Copyright: ${copyright}`,
        `Creation Date: ${creationDate}`,
      ].join("\n") + "\n";

      const licenseText = [
        `Font Name: ${fontName}`,
        `Creator: ${designerName}`,
        `License Type: ${licenseInfoForm.licenseType}`,
        licenseInfoForm.licenseOwner.trim() ? `License Owner: ${licenseInfoForm.licenseOwner.trim()}` : null,
        `Permission: ${licenseInfoForm.permission.trim() || "-"}`,
        `Restriction: ${licenseInfoForm.restriction.trim() || "-"}`,
        licenseInfoForm.note.trim() ? `Note: ${licenseInfoForm.note.trim()}` : null,
      ].filter((line): line is string => line !== null).join("\n") + "\n";

      // A polished, human-readable companion to License.txt: same terms,
      // laid out as a shareable PDF with the designer's name/URL and a
      // plain-English explanation of what the chosen license allows.
      const { generateLicensePdf } = await import("@/utils/licensePdf");
      const licensePdfBlob = generateLicensePdf({
        fontName,
        familyName,
        designerName,
        foundry,
        website,
        copyright,
        version,
        licenseType: licenseInfoForm.licenseType,
        licenseOwner: licenseInfoForm.licenseOwner.trim(),
        permission: licenseInfoForm.permission,
        restriction: licenseInfoForm.restriction,
        note: licenseInfoForm.note,
      });

      // Export always ships as a ZIP now: font binaries + FontInfo.txt +
      // License.txt + License Summary.pdf, per the Export Information
      // System spec.
      const zipEntries = [
        ...files.map((file) => ({ name: file.name, blob: file.blob })),
        { name: "FontInfo.txt", blob: textEncoder(fontInfoText) },
        { name: "License.txt", blob: textEncoder(licenseText) },
        { name: "License Summary.pdf", blob: licensePdfBlob },
      ];
      setExportProgressLabel("Packaging ZIP…");
      const zipBlob = await createZipBlob(zipEntries);
      advanceExportProgress("Menyimpan…");
      const zipName = styles.length > 1 ? `${baseName}-Family.zip` : `${baseName}.zip`;
      const result = await saveFontBlob(zipBlob, zipName, "zip");
      if (result === "cancelled") return;

      setExportOpen(false);
      setExportSuccess({ zipName, styleCount: styles.length });
    } catch (error) {
      console.error("[FontSeru] Export failed:", error);
      const detail = error instanceof Error ? error.message.trim() : "";
      const message = detail && detail.length <= 220
        ? detail
        : "Unable to generate the font. Please check the font name and glyph data.";
      showToast(message, "error");
    } finally {
      setBusy(false);
      setExportProgress(0);
    }
  };

  const availableStyleCount = exportableStyleList(customFamilies).filter(({ id }) => styleAvailability[id]).length;
  const selectedStyleList = selectedExportStyles(selectedStyles, styleAvailability, customFamilies);
  const selectedStyleCount = selectedStyleList.length;
  const primaryExportLabel = selectedStyleCount > 1
    ? (selectedStyleCount === availableStyleCount ? "Export All Family ZIP" : "Export Family ZIP")
    : selectedStyleCount === 1
      ? `Export ${fontStyleLabel(selectedStyleList[0], customFamilies)} ZIP`
      : "Select a style";


  return (
    <>
      <div className="fm-filemenu-wrap" ref={menuWrapRef}>
        <button
          className="fm-topbtn"
          onClick={() => (open ? setOpen(false) : openMenu())}
          aria-expanded={open}
          data-testid="file-menu-btn"
        >
          {/* Leading icon added so this button stays recognizable on
              tablet/phone widths, where `.fm-topbtn` collapses to an
              icon-only square (see the ≤1180px rule in app.css) — without
              an icon here, only the trailing chevron survived that
              collapse, making the entire File menu look like it had
              disappeared. */}
          <FileText size={14} /> File <ChevronDown size={13} />
        </button>

        {open && (
          <>
            <div
              className="fm-filemenu-backdrop"
              onClick={() => setOpen(false)}
              aria-hidden="true"
              data-testid="file-menu-backdrop"
            />
            <div
              className="fm-filemenu"
              role="menu"
              style={menuPos ? { top: menuPos.top, left: menuPos.left } : undefined}
            >
            <button onClick={() => { newProject(); setOpen(false); showToast("New project created"); }}>
              <FilePlus2 size={14} /> New
            </button>
            <button onClick={() => inputRef.current?.click()} disabled={busy}>
              <FolderOpen size={14} /> Open / Import…
            </button>
            <div className="fm-filemenu-sep" />
            <button onClick={save}><Save size={14} /> Save <kbd>⌘S</kbd></button>
            <button onClick={saveAs}><SaveAll size={14} /> Save As…</button>
            {cloudVisible && (
              <>
                <div className="fm-filemenu-sep" />
                <button
                  onClick={openSaveToCloudDialog}
                  className={cloudLocked ? "fm-filemenu-locked" : undefined}
                  title={cloudLocked ? "Save to Cloud (PRO)" : undefined}
                >
                  <CloudUpload size={14} /> Save to Cloud…
                  {cloudLocked && <Lock size={11} className="fm-lock-badge-inline" />}
                </button>
                <button
                  onClick={openCloudDialog}
                  className={cloudLocked ? "fm-filemenu-locked" : undefined}
                  title={cloudLocked ? "Open from Cloud (PRO)" : undefined}
                >
                  <CloudDownload size={14} /> Open from Cloud…
                  {cloudLocked && <Lock size={11} className="fm-lock-badge-inline" />}
                </button>
              </>
            )}
            <div className="fm-filemenu-sep" />
            <button onClick={beginExport}><Download size={14} /> Export Font…</button>
            </div>
          </>
        )}

        <input
          ref={inputRef}
          hidden
          type="file"
          // iPadOS/Safari's Files picker matches `accept` against known UTTypes,
          // not raw extensions — since ".fs" isn't a registered system type, an
          // extension-only/unrecognized-MIME accept list (the previous value)
          // makes .fs files render greyed-out and unselectable there, even
          // though the exact same list works fine on desktop browsers. Widening
          // this with generic MIME types that DO map to known UTTypes (.fs is
          // plain JSON text, so "application/json"/"text/plain"/
          // "application/octet-stream" all resolve to something iOS
          // recognizes) keeps every file kind selectable everywhere. This is
          // purely a picker-compatibility hint — the actual accept/reject
          // decision still happens after selection, in importFile() below,
          // which checks the real file extension regardless of what MIME type
          // (if any) the OS reports.
          accept=".fs,.ttf,.otf,font/ttf,font/otf,application/json,text/plain,application/octet-stream"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
          }}
        />
      </div>

      <Toast toast={toast} onClose={dismissToast} />

      {exportOpen && (
        <div
          className="fm-export-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !busy) setExportOpen(false);
          }}
        >
          <section className="fm-export-dialog" role="dialog" aria-modal="true" aria-labelledby="font-export-title">
            <header>
              <div>
                <span className="fm-panel-eyebrow">Download</span>
                <h2 id="font-export-title">Export Font</h2>
              </div>
              <button
                type="button"
                className="fm-iconbtn"
                onClick={() => setExportOpen(false)}
                disabled={busy}
                aria-label="Close export dialog"
              >
                <X size={17} />
              </button>
            </header>

            <div className="fm-export-body">
            <div className="fm-export-main">
            <div className="fm-export-tabs" role="tablist" aria-label="Export information">
              <button
                type="button"
                role="tab"
                aria-selected={exportTab === "fontinfo"}
                className={`fm-export-tab${exportTab === "fontinfo" ? " active" : ""}`}
                onClick={() => setExportTab("fontinfo")}
              >
                <FileText size={13} /> Font Info
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={exportTab === "license"}
                className={`fm-export-tab${exportTab === "license" ? " active" : ""}`}
                onClick={() => setExportTab("license")}
              >
                <ScrollText size={13} /> License Info
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={exportTab === "qa"}
                className={`fm-export-tab${exportTab === "qa" ? " active" : ""}`}
                onClick={() => setExportTab("qa")}
              >
                <ShieldCheck size={13} /> QA Check
                {qaReport.errorCount > 0 && <span className="fm-qa-tab-badge fm-qa-tab-badge-error">{qaReport.errorCount}</span>}
                {qaReport.errorCount === 0 && qaReport.warningCount > 0 && <span className="fm-qa-tab-badge fm-qa-tab-badge-warning">{qaReport.warningCount}</span>}
              </button>
            </div>

            {exportTab === "qa" && (
              <div className="fm-export-form fm-qa-panel" role="tabpanel" aria-label="Font QA">
                <div className={`fm-qa-summary${qaReport.errorCount > 0 ? " fm-qa-summary-error" : qaReport.warningCount > 0 ? " fm-qa-summary-warning" : " fm-qa-summary-ok"}`}>
                  {qaReport.errorCount > 0 ? (
                    <>
                      <XCircle size={16} />
                      <span>{qaReport.errorCount} masalah wajib dibenerin sebelum export aman disubmit.</span>
                    </>
                  ) : qaReport.warningCount > 0 ? (
                    <>
                      <AlertTriangle size={16} />
                      <span>Tidak ada error, tapi ada {qaReport.warningCount} hal yang sebaiknya dicek dulu.</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={16} />
                      <span>Semua pemeriksaan lolos. Font ini siap diekspor.</span>
                    </>
                  )}
                </div>

                <div className="fm-qa-list">
                  {qaReport.issues
                    .slice()
                    .sort((a, b) => QA_SEVERITY_ORDER[a.severity] - QA_SEVERITY_ORDER[b.severity])
                    .map((issue) => (
                      <div key={issue.id} className={`fm-qa-item fm-qa-item-${issue.severity}`}>
                        <div className="fm-qa-item-icon">{QA_SEVERITY_ICON[issue.severity]}</div>
                        <div className="fm-qa-item-body">
                          <div className="fm-qa-item-title">{issue.title}</div>
                          <div className="fm-qa-item-message">{issue.message}</div>
                        </div>
                      </div>
                    ))}
                </div>

                <InfoTip>
                  Pemeriksaan ini jalan otomatis di style yang sedang aktif ({fontStyleLabel(qaFontStyle, customFamilies)}) dan tidak menghalangi export — keputusan tetap di tangan kamu.
                </InfoTip>
              </div>
            )}

            {exportTab === "fontinfo" && (
              <div className="fm-export-form" role="tabpanel" aria-label="Font info">
                <label className="fm-export-field">
                  <span>Font Name</span>
                  <input
                    value={fontInfoForm.fontName}
                    onChange={(event) => setFontInfoField("fontName", event.target.value)}
                    autoFocus
                    spellCheck={false}
                    placeholder="My Font"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Family Name</span>
                  <input
                    value={fontInfoForm.familyName}
                    onChange={(event) => setFontInfoField("familyName", event.target.value)}
                    spellCheck={false}
                    placeholder="Defaults to Font Name"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Style</span>
                  <input
                    value={fontInfoForm.style}
                    onChange={(event) => setFontInfoField("style", event.target.value)}
                    spellCheck={false}
                    placeholder="Regular"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Designer Name</span>
                  <input
                    value={fontInfoForm.designerName}
                    onChange={(event) => setFontInfoField("designerName", event.target.value)}
                    placeholder="Your name"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Designer URL</span>
                  <input
                    value={fontInfoForm.designerURL}
                    onChange={(event) => setFontInfoField("designerURL", event.target.value)}
                    spellCheck={false}
                    placeholder="https://yourportfolio.com (opsional)"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Foundry</span>
                  <input
                    value={fontInfoForm.foundry}
                    onChange={(event) => setFontInfoField("foundry", event.target.value)}
                    placeholder="Foundry / studio name"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Copyright</span>
                  <input
                    value={fontInfoForm.copyright}
                    onChange={(event) => setFontInfoField("copyright", event.target.value)}
                    placeholder={`Copyright © ${new Date().getFullYear()}`}
                  />
                </label>

                <label className="fm-export-field">
                  <span>Trademark</span>
                  <input
                    value={fontInfoForm.trademark}
                    onChange={(event) => setFontInfoField("trademark", event.target.value)}
                    placeholder="ex: MyFont is a trademark of Foundry Name (opsional)"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Version</span>
                  <input
                    value={fontInfoForm.version}
                    onChange={(event) => setFontInfoField("version", event.target.value)}
                    placeholder="1.000"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Website</span>
                  <input
                    value={fontInfoForm.website}
                    onChange={(event) => setFontInfoField("website", event.target.value)}
                    spellCheck={false}
                    placeholder="https://example.com"
                  />
                </label>

                <div className="fm-nametable-preview">
                  <button
                    type="button"
                    className="fm-nametable-preview-toggle"
                    onClick={() => setNameTablePreviewOpen((current) => !current)}
                    aria-expanded={nameTablePreviewOpen}
                  >
                    <ChevronDown
                      size={14}
                      className={`fm-nametable-preview-chevron${nameTablePreviewOpen ? " open" : ""}`}
                    />
                    <span>Name Table Preview</span>
                    {nameTablePreview && <span className="fm-nametable-preview-count">{nameTablePreview.length}</span>}
                  </button>

                  {nameTablePreviewOpen && (
                    <div className="fm-nametable-preview-body">
                      {!nameTablePreview ? (
                        <p className="fm-hint">Isi Font Name dulu untuk lihat preview name table.</p>
                      ) : (
                        <>
                          {familyNameTablePreview && (
                            <div className="fm-nametable-family">
                              <div className="fm-nametable-family-head">
                                Family: <strong>{fontInfoForm.familyName.trim() || fontInfoForm.fontName.trim()}</strong>
                                <span className="fm-nametable-preview-count">{familyNameTablePreview.length} styles</span>
                              </div>
                              <div className="fm-nametable-preview-list">
                                {familyNameTablePreview.map((row) => (
                                  <div className="fm-nametable-preview-row" key={row.style}>
                                    <span className="fm-nametable-preview-label">{row.subfamily}</span>
                                    <span className="fm-nametable-preview-value">{row.fullName}</span>
                                  </div>
                                ))}
                              </div>
                              <div className="fm-nametable-family-note">Record di bawah ini contoh untuk style pertama; tiap style di atas ditulis ke file-nya sendiri.</div>
                            </div>
                          )}
                          <div className="fm-nametable-preview-list">
                            {nameTablePreview.map((record) => (
                              <div className="fm-nametable-preview-row" key={record.id}>
                                <span className="fm-nametable-preview-label">
                                  {record.label} <em>({record.id})</em>
                                </span>
                                <span className="fm-nametable-preview-value">{record.value}</span>
                              </div>
                            ))}
                          </div>
                          <InfoTip>
                            Ini persis record yang bakal ditulis ke name table font (TTF &amp; OTF) — dicek dulu di sini sebelum jadi file. Family export multi-style pakai subfamily masing-masing style, sisanya sama.
                          </InfoTip>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {exportTab === "license" && (
              <div className="fm-export-form" role="tabpanel" aria-label="License info">
                <label className="fm-export-field">
                  <span>License Type</span>
                  <select
                    value={licenseInfoForm.licenseType}
                    onChange={(event) => setLicenseInfoField("licenseType", event.target.value as LicenseType)}
                  >
                    <option value="">Select license type…</option>
                    {LICENSE_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>

                <label className="fm-export-field">
                  <span>License Owner</span>
                  <input
                    value={licenseInfoForm.licenseOwner}
                    onChange={(event) => setLicenseInfoField("licenseOwner", event.target.value)}
                    placeholder="Name of the license owner"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Permission</span>
                  <input
                    value={licenseInfoForm.permission}
                    onChange={(event) => setLicenseInfoField("permission", event.target.value)}
                    placeholder="e.g. Free for personal projects"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Restriction</span>
                  <input
                    value={licenseInfoForm.restriction}
                    onChange={(event) => setLicenseInfoField("restriction", event.target.value)}
                    placeholder="e.g. No resale or redistribution"
                  />
                </label>

                <label className="fm-export-field fm-export-field-full">
                  <span>Note</span>
                  <input
                    value={licenseInfoForm.note}
                    onChange={(event) => setLicenseInfoField("note", event.target.value)}
                    placeholder="Optional note"
                  />
                </label>
              </div>
            )}

            </div>

            <div className="fm-export-sidebar">
            <div className="fm-export-form fm-export-options">
              <div className="fm-export-field">
                <span>Styles</span>
                <div className="fm-export-style-list" role="group" aria-label="Font family styles">
                  {exportableStyleList(customFamilies).map(({ id, label }) => {
                    const available = styleAvailability[id];
                    // Bold/Italic ("Export Family") are PRO-only; Regular
                    // stays free for everyone. Locked options stay visible
                    // (dimmed + lock icon) per spec rather than being
                    // hidden, and tapping them opens the existing
                    // ProUpsellModal instead of toggling the checkbox. This
                    // is UI-level; runExport() below also strips any
                    // non-regular style for FREE as the real enforcement
                    // point, so this can't be bypassed by forcing the
                    // checkbox state some other way.
                    const locked = id !== "regular" && !isPro;
                    const checked = available && selectedStyles[id] && !locked;
                    const isCustomFamily = !FONT_STYLES.some((s) => s.id === id);
                    const override = styleNameOverrides[id];
                    return (
                      <div key={id} className="fm-export-style-row">
                      <label
                        className={`fm-export-style-option${available ? "" : " disabled"}${locked ? " fm-export-style-locked" : ""}`}
                        title={locked ? `${label} (PRO)` : available ? `${label} vector glyphs detected` : `${label} has no vector glyphs`}
                        onClick={(event) => {
                          if (locked) {
                            event.preventDefault();
                            openProModal("family");
                          }
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!available || busy || locked}
                          onChange={(event) => {
                            if (locked) return;
                            const value = event.target.checked;
                            setSelectedStyles((current) => ({ ...current, [id]: value }));
                          }}
                        />
                        <span className="fm-export-checkmark" aria-hidden="true" />
                        <span className="fm-export-style-name">{label}</span>
                        {locked && <Lock size={11} className="fm-lock-badge-inline" />}
                        {!locked && !available && <span className="fm-export-style-status">No vectors</span>}
                      </label>
                      {checked && (selectedStyleCount > 1 || isCustomFamily) && (
                        <div className="fm-export-style-name-overrides">
                          <input
                            className="fm-export-style-name-override"
                            value={override?.familyName ?? ""}
                            onChange={(event) => setStyleNameOverride(id, "familyName", event.target.value)}
                            spellCheck={false}
                            placeholder={`Family: ${fontInfoForm.familyName.trim() || fontInfoForm.fontName.trim() || "same as above"}`}
                            title="Override the Family Name baked into this style's file only (nameID 1/16). Leave blank to use the Family Name above."
                          />
                          <input
                            className="fm-export-style-name-override"
                            value={override?.styleName ?? ""}
                            onChange={(event) => setStyleNameOverride(id, "styleName", event.target.value)}
                            spellCheck={false}
                            placeholder={`Style: ${fontStyleLabel(id, customFamilies)}`}
                            title="Override the Style/Subfamily Name baked into this file (nameID 2/17). Leave blank to use the automatic label."
                          />
                        </div>
                      )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {selectedStyleCount > 1 && (
                <div className="fm-export-field">
                  <label className="fm-export-combine-family" title="Gabungkan semua style jadi SATU family di Mac & Windows (nameID 16/17 + OS/2 dibedakan per style). Matikan kalau tiap style mau jadi family sendiri.">
                    <input
                      type="checkbox"
                      checked={combineFamily}
                      disabled={busy}
                      onChange={(event) => setCombineFamily(event.target.checked)}
                    />
                    <span className="fm-export-checkmark" aria-hidden="true" />
                    <span className="fm-export-style-name">Combine as one family</span>
                  </label>
                  <p className="fm-hint">
                    {combineFamily
                      ? `Semua style dikenal sebagai satu family "${fontInfoForm.familyName.trim() || fontInfoForm.fontName.trim() || "—"}" waktu diinstall.`
                      : "Tiap style jadi family terpisah waktu diinstall."}
                  </p>
                </div>
              )}

              <div className="fm-export-field">
                <span>Format</span>
                <div className="fm-format-segment" role="group" aria-label="Font format">
                  {(["ttf", "otf", "woff", "woff2"] as ExportFontFormat[]).map((value) => {
                    const active = formats.includes(value);
                    return (
                      <button
                        type="button"
                        key={value}
                        className={active ? "active" : ""}
                        onClick={() => toggleFormat(value)}
                        aria-pressed={active}
                      >
                        {value.toUpperCase()}
                      </button>
                    );
                  })}
                </div>
              </div>

            </div>

            {!isPro && exportUsage && !exportUsage.unlimited && (
              <p className="fm-auth-note fm-export-quota-note" data-testid="export-quota-note">
                {exportUsage.limit !== null && exportUsage.used !== null && exportUsage.used >= exportUsage.limit
                  ? `Batas export FREE bulan ini sudah tercapai (${exportUsage.used}/${exportUsage.limit}). Upgrade ke PRO untuk export tanpa batas.`
                  : `Export FREE: ${exportUsage.used ?? 0}/${exportUsage.limit ?? 1} bulan ini.`}
              </p>
            )}

            {busy && (
              <div className="fm-export-progress" role="status" aria-live="polite">
                <div className="fm-export-progress-row">
                  <span>{exportProgressLabel}</span>
                  <span className="fm-export-progress-pct">{Math.round(exportProgress * 100)}%</span>
                </div>
                <div className="fm-export-progress-bar">
                  <div
                    className="fm-export-progress-fill"
                    style={{ width: `${Math.max(4, Math.min(100, Math.round(exportProgress * 100)))}%` }}
                  />
                </div>
              </div>
            )}

            <footer className="fm-export-actions">
              <button
                type="button"
                className="fm-primary-btn"
                onClick={() => void runExport()}
                disabled={busy || selectedStyleCount === 0}
              >
                {busy ? <Loader2 size={15} className="fm-spin" /> : <Download size={15} />}
                {busy ? "Exporting…" : primaryExportLabel}
              </button>
              <button
                type="button"
                className="fm-secondary-btn"
                onClick={saveFontInfoDraft}
                disabled={busy}
                title="Simpan Font Info & License ke project tanpa export, agar data tidak hilang"
              >
                {infoSaved ? <Check size={15} /> : <Save size={15} />}
                {infoSaved ? "Saved" : "Save Info"}
              </button>
              <button type="button" className="fm-secondary-btn" onClick={() => setExportOpen(false)} disabled={busy}>
                Cancel
              </button>
            </footer>
            </div>
            </div>
          </section>
        </div>
      )}

      {cloudDialog === "open" && (
        <div
          className="fm-export-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) {
              if (cloudOpenProgress) cancelCloudOpen();
              setCloudDialog(null);
            }
          }}
        >
          <section className="fm-export-dialog fm-cloud-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-open-title">
            <header>
              <div>
                <span className="fm-panel-eyebrow">Cloud</span>
                <h2 id="cloud-open-title" className="fm-cloud-title"><Cloud size={17} /> Open from Cloud</h2>
              </div>
              <button
                type="button"
                className="fm-iconbtn"
                onClick={() => {
                  if (cloudOpenProgress) cancelCloudOpen();
                  setCloudDialog(null);
                }}
                aria-label="Close cloud projects dialog"
              >
                <X size={17} />
              </button>
            </header>

            <div className="fm-cloud-body">
              {cloudError && <p className="fm-cloud-error">{cloudError}</p>}

              {cloudBusy && cloudProjects === null ? (
                <div className="fm-cloud-status">
                  <Loader2 size={16} className="fm-spin" />
                  <span>Loading your cloud projects…</span>
                </div>
              ) : cloudProjects && cloudProjects.length === 0 ? (
                <div className="fm-cloud-empty">
                  <Cloud size={22} />
                  <p>No projects saved to Cloud yet.</p>
                  <span>Use “Save to Cloud…” in the File menu to sync a project here.</span>
                </div>
              ) : (
                <ul className="fm-cloud-list" role="list">
                  {cloudProjects?.map((item) => {
                    const acting = cloudActionId === item.id;
                    const opening = acting && cloudOpenProgress !== null;
                    // While one item is opening, the rest of the list is
                    // disabled too — opening isn't instant any more for
                    // large projects, and letting the user start a second
                    // action mid-download would be confusing.
                    const disabled = cloudActionId !== null && !opening;
                    return (
                      <li key={item.id} className="fm-cloud-item">
                        <button
                          type="button"
                          className="fm-cloud-item-main"
                          onClick={() => void openFromCloud(item)}
                          disabled={acting || disabled}
                        >
                          <span className="fm-cloud-item-icon">
                            {opening ? <Loader2 size={15} className="fm-spin" /> : <FileText size={15} />}
                          </span>
                          <span className="fm-cloud-item-info">
                            <span className="fm-cloud-item-name">{item.name}</span>
                            {opening && cloudOpenProgress ? (
                              <span className="fm-cloud-item-meta">{cloudOpenProgress.label}</span>
                            ) : (
                              <span className="fm-cloud-item-meta">Updated {new Date(item.updatedAt).toLocaleString()}</span>
                            )}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="fm-cloud-item-delete"
                          aria-label={`Delete ${item.name} from Cloud`}
                          onClick={() => void deleteFromCloud(item)}
                          disabled={acting || disabled}
                        >
                          {acting && !opening ? <Loader2 size={14} className="fm-spin" /> : <Trash2 size={14} />}
                        </button>
                        {opening && cloudOpenProgress && (
                          <div className="fm-cloud-progress fm-cloud-progress-inline" role="status" aria-live="polite">
                            <div className="fm-cloud-progress-row">
                              <span>{cloudOpenProgress.label}</span>
                              <span className="fm-cloud-progress-pct">{cloudOpenProgress.percent}%</span>
                            </div>
                            <div className="fm-cloud-progress-bar">
                              <div
                                className="fm-cloud-progress-fill"
                                style={{ width: `${Math.max(4, Math.min(100, cloudOpenProgress.percent))}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <footer className="fm-export-actions">
              <button
                type="button"
                className="fm-secondary-btn"
                onClick={() => {
                  if (cloudOpenProgress) {
                    cancelCloudOpen();
                  } else {
                    setCloudDialog(null);
                  }
                }}
              >
                {cloudOpenProgress ? "Batalkan" : "Close"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {cloudDialog === "save" && (
        <div
          className="fm-export-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) {
              if (cloudSaving) cancelCloudSave();
              setCloudDialog(null);
            }
          }}
        >
          <section className="fm-export-dialog fm-cloud-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-save-title">
            <header>
              <div>
                <span className="fm-panel-eyebrow">Cloud</span>
                <h2 id="cloud-save-title" className="fm-cloud-title"><CloudUpload size={17} /> Save to Cloud</h2>
              </div>
              <button
                type="button"
                className="fm-iconbtn"
                onClick={() => {
                  if (cloudSaving) cancelCloudSave();
                  setCloudDialog(null);
                }}
                aria-label="Close save to cloud dialog"
              >
                <X size={17} />
              </button>
            </header>

            <div className="fm-export-form">
              <label className="fm-export-field">
                <span>Project Name</span>
                <input
                  value={cloudSaveName}
                  onChange={(event) => setCloudSaveName(event.target.value)}
                  autoFocus
                  disabled={cloudSaving}
                  spellCheck={false}
                  placeholder="My Font"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !cloudSaving && safeProjectBaseName(cloudSaveName)) {
                      void confirmSaveToCloud();
                    }
                  }}
                />
              </label>

              {cloudSaving && cloudSaveProgress && (
                <div className="fm-cloud-progress" role="status" aria-live="polite">
                  <div className="fm-cloud-progress-row">
                    <span>{cloudSaveProgress.label}</span>
                    <span className="fm-cloud-progress-pct">{cloudSaveProgress.percent}%</span>
                  </div>
                  <div className="fm-cloud-progress-bar">
                    <div
                      className="fm-cloud-progress-fill"
                      style={{ width: `${Math.max(4, Math.min(100, cloudSaveProgress.percent))}%` }}
                    />
                  </div>
                </div>
              )}

              {cloudError && <p className="fm-cloud-error">{cloudError}</p>}

              {cloudSaveNameTaken && !cloudError && (
                <p className="fm-cloud-hint"><CloudUpload size={12} /> A cloud project with this name already exists — saving will overwrite it.</p>
              )}

              {cloudUsageBytes !== null && (
                <div className="fm-cloud-quota">
                  <div className="fm-cloud-quota-row">
                    <span>Cloud storage used</span>
                    <span>{formatBytes(cloudUsageBytes)} / {formatBytes(CLOUD_STORAGE_QUOTA_BYTES)}</span>
                  </div>
                  <div className="fm-cloud-quota-bar">
                    <div
                      className={`fm-cloud-quota-fill${cloudUsageBytes / CLOUD_STORAGE_QUOTA_BYTES > 0.9 ? " fm-cloud-quota-fill-warn" : ""}`}
                      style={{ width: `${Math.min(100, (cloudUsageBytes / CLOUD_STORAGE_QUOTA_BYTES) * 100)}%` }}
                    />
                  </div>
                </div>
              )}

              {cloudProjects && cloudProjects.length > 0 && (
                <div className="fm-cloud-existing">
                  <span className="fm-cloud-existing-label">Already in Cloud</span>
                  <ul className="fm-cloud-existing-list">
                    {cloudProjects.slice(0, 5).map((item) => (
                      <li key={item.id}>{item.name}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <footer className="fm-export-actions">
              <button
                type="button"
                className="fm-secondary-btn"
                onClick={() => {
                  if (cloudSaving) {
                    cancelCloudSave();
                  } else {
                    setCloudDialog(null);
                  }
                }}
              >
                {cloudSaving ? "Batalkan" : "Cancel"}
              </button>
              <button
                type="button"
                className="fm-primary-btn"
                onClick={() => void confirmSaveToCloud()}
                disabled={cloudSaving || !safeProjectBaseName(cloudSaveName)}
              >
                {cloudSaving ? <Loader2 size={15} className="fm-spin" /> : <CloudUpload size={15} />}
                {cloudSaving ? "Saving…" : "Save to Cloud"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {exportSuccess && (
        <div
          className="fm-export-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setExportSuccess(null);
          }}
        >
          <section
            className="fm-export-dialog fm-cloud-dialog fm-cloud-success-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-success-title"
          >
            <div className="fm-cloud-success-icon" aria-hidden="true">
              <Check size={26} strokeWidth={2.5} />
            </div>
            <h2 id="export-success-title">Export berhasil</h2>
            <p className="fm-cloud-success-body">
              <strong>&ldquo;{exportSuccess.zipName}&rdquo;</strong> berhasil dibuat
              {exportSuccess.styleCount > 1 ? ` (${exportSuccess.styleCount} style)` : ""} dan sudah tersimpan/terunduh
              ke perangkatmu.
            </p>
            <footer className="fm-export-actions fm-cloud-success-actions">
              <button type="button" className="fm-primary-btn" onClick={() => setExportSuccess(null)} autoFocus>
                OK, Mengerti
              </button>
            </footer>
          </section>
        </div>
      )}

      {cloudSaveSuccess && (
        <div
          className="fm-export-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setCloudSaveSuccess(null);
          }}
        >
          <section
            className="fm-export-dialog fm-cloud-dialog fm-cloud-success-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cloud-success-title"
          >
            <div className="fm-cloud-success-icon" aria-hidden="true">
              <Check size={26} strokeWidth={2.5} />
            </div>
            <h2 id="cloud-success-title">Berhasil disimpan ke Cloud</h2>
            <p className="fm-cloud-success-body">
              Project <strong>&ldquo;{cloudSaveSuccess}&rdquo;</strong> berhasil disimpan ke Cloud dan bisa dibuka
              lagi dari perangkat lain lewat menu <strong>File → Open from Cloud…</strong>
            </p>
            <footer className="fm-export-actions fm-cloud-success-actions">
              <button type="button" className="fm-primary-btn" onClick={() => setCloudSaveSuccess(null)} autoFocus>
                OK, Mengerti
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
