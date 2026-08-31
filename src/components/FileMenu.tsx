import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Cloud, CloudDownload, CloudUpload, Download, FilePlus2, FileText, FolderOpen, Loader2, Lock, Save, SaveAll, ScrollText, Trash2, X } from "lucide-react";
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
import { effectiveKerningPairs } from "@/types/kerning";
import { createZipBlob } from "@/utils/zip";
import { Toast, type ToastKind, type ToastMessage } from "@/components/Toast";

// --- Export Information System -------------------------------------------
// Purely additive: this data drives the OpenType name-table fields already
// accepted by `FontInfo` (unchanged) and two plain-text manifests bundled
// into the export ZIP. The TTF/OTF generator itself (`generateFontFiles`,
// `exportOTF`, `trueTypeWriter`) is never touched.

const LICENSE_TYPE_OPTIONS = ["Personal", "Commercial", "Corporate", "Extended"] as const;
type LicenseType = (typeof LICENSE_TYPE_OPTIONS)[number] | "";

type ExportTab = "fontinfo" | "license";

interface FontInfoFormState {
  fontName: string;
  familyName: string;
  style: string;
  designerName: string;
  foundry: string;
  copyright: string;
  version: string;
  website: string;
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
    foundry: "",
    copyright: "",
    version: "1.000",
    website: "",
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
  const [exportOpen, setExportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Real progress for the Export button: one step per selected style's font
  // generation, plus one final step for zipping the result — not a fake
  // timer, so it always reflects how much of `runExport` has actually run.
  const [exportProgress, setExportProgress] = useState(0);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastId = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const projectFileName = useAppStore((s) => s.projectFileName);
  const setProjectFileName = useAppStore((s) => s.setProjectFileName);
  const newProject = useAppStore((s) => s.newProject);
  const glyphsByStyle = useAppStore((s) => s.glyphsByStyle);
  const customFamilies = useAppStore((s) => s.customFamilies);
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
    setCloudSaving(true);
    setCloudError(null);
    try {
      await saveCloudProject(name, snapshotFromStore());
      setCloudDialog(null);
      showToast(`Saved "${name}" to Cloud`);
    } catch (error) {
      console.error("[FontSeru] Cloud save failed.", error);
      setCloudError(error instanceof Error ? error.message : "Unable to save to Cloud.");
      void refreshCloudProjects(); // usage may have changed even on a failed/partial attempt
    } finally {
      setCloudSaving(false);
    }
  }, [cloudSaveName, refreshCloudProjects]);

  const openFromCloud = useCallback(async (summary: CloudProjectSummary) => {
    setCloudActionId(summary.id);
    setCloudError(null);
    try {
      const { name, project } = await loadCloudProject(summary.id);
      hydrateProject(project, `${name}.fs`);
      useAppStore.getState().setFontName(name);
      setCloudDialog(null);
      showToast(`Opened "${name}" from Cloud`);
    } catch (error) {
      console.error("[FontSeru] Cloud open failed.", error);
      setCloudError(error instanceof Error ? error.message : "Unable to open this cloud project.");
    } finally {
      setCloudActionId(null);
    }
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
  const [selectedStyles, setSelectedStyles] = useState<FamilyStyleSelection>({
    regular: true,
  });

  const setFontInfoField = useCallback(<K extends keyof FontInfoFormState>(field: K, value: FontInfoFormState[K]) => {
    setFontInfoForm((current) => ({ ...current, [field]: value }));
  }, []);

  const setLicenseInfoField = useCallback(<K extends keyof LicenseInfoFormState>(field: K, value: LicenseInfoFormState[K]) => {
    setLicenseInfoForm((current) => ({ ...current, [field]: value }));
  }, []);

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
      foundry: s.fontInfo.manufacturer?.trim() || "",
      copyright: s.fontInfo.copyright?.trim() || (initialFontName ? `Copyright © ${new Date().getFullYear()} ${initialFontName}` : ""),
      version: s.fontInfo.version?.trim() || "1.000",
      website: s.fontInfo.manufacturerURL?.trim() || "",
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
    const advanceExportProgress = () => {
      completedExportSteps++;
      setExportProgress(completedExportSteps / totalExportSteps);
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
      // single-style export. For multi-style Family exports each binary
      // still needs its own correct Regular/Bold/Italic subfamily name for
      // OS font matching, so the automatic label is kept there.
      const styleOverride = fontInfoForm.style.trim();

      const { generateFontFiles } = await import("@/utils/fontIO");

      // Family export is orchestration only: each selected style still passes
      // through the existing font generator and its validation pipeline.
      for (const style of styles) {
        const styleName = styles.length === 1 && styleOverride ? styleOverride : fontStyleLabel(style, s.customFamilies);
        const exportInfo: FontInfo = {
          ...s.fontInfo,
          familyName,
          styleName,
          fullName: `${fontName} ${styleName}`,
          // Let normalization create a unique Family-Style PostScript name and
          // matching unique ID for every binary.
          postscriptName: "",
          uniqueID: "",
          designer: designerName,
          manufacturer: foundry,
          manufacturerURL: website,
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
        let generated: Awaited<ReturnType<typeof generateFontFiles>>;
        try {
          generated = await generateFontFiles(
            s.glyphsByStyle[style],
            s.metrics,
            exportInfo,
            effectiveKerning,
            formats,
            s.featureConfig,
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
      const zipBlob = await createZipBlob(zipEntries);
      advanceExportProgress();
      const zipName = styles.length > 1 ? `${baseName}-Family.zip` : `${baseName}.zip`;
      const result = await saveFontBlob(zipBlob, zipName, "zip");
      if (result === "cancelled") return;

      setExportOpen(false);
      showToast(styles.length > 1 ? "Font family ZIP saved successfully" : "Font ZIP saved successfully");
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
      <div className="fm-filemenu-wrap">
        <button
          className="fm-topbtn"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          data-testid="file-menu-btn"
        >
          File <ChevronDown size={13} />
        </button>

        {open && (
          <div className="fm-filemenu" role="menu">
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
            </div>

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

                <label className="fm-export-field">
                  <span>Note</span>
                  <input
                    value={licenseInfoForm.note}
                    onChange={(event) => setLicenseInfoField("note", event.target.value)}
                    placeholder="Optional note"
                  />
                </label>
              </div>
            )}

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
                    return (
                      <label
                        key={id}
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
                    );
                  })}
                </div>
              </div>

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

            <footer className="fm-export-actions">
              <button type="button" className="fm-secondary-btn" onClick={() => setExportOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="fm-primary-btn"
                onClick={() => void runExport()}
                disabled={busy || selectedStyleCount === 0}
              >
                <Download size={15} /> {busy ? `Preparing… ${Math.round(exportProgress * 100)}%` : primaryExportLabel}
              </button>
            </footer>
          </section>
        </div>
      )}

      {cloudDialog === "open" && (
        <div
          className="fm-export-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setCloudDialog(null);
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
                onClick={() => setCloudDialog(null)}
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
                    return (
                      <li key={item.id} className="fm-cloud-item">
                        <button
                          type="button"
                          className="fm-cloud-item-main"
                          onClick={() => void openFromCloud(item)}
                          disabled={acting}
                        >
                          <span className="fm-cloud-item-icon"><FileText size={15} /></span>
                          <span className="fm-cloud-item-info">
                            <span className="fm-cloud-item-name">{item.name}</span>
                            <span className="fm-cloud-item-meta">Updated {new Date(item.updatedAt).toLocaleString()}</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="fm-cloud-item-delete"
                          aria-label={`Delete ${item.name} from Cloud`}
                          onClick={() => void deleteFromCloud(item)}
                          disabled={acting}
                        >
                          {acting ? <Loader2 size={14} className="fm-spin" /> : <Trash2 size={14} />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <footer className="fm-export-actions">
              <button type="button" className="fm-secondary-btn" onClick={() => setCloudDialog(null)}>
                Close
              </button>
            </footer>
          </section>
        </div>
      )}

      {cloudDialog === "save" && (
        <div
          className="fm-export-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !cloudSaving) setCloudDialog(null);
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
                onClick={() => setCloudDialog(null)}
                disabled={cloudSaving}
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
                  spellCheck={false}
                  placeholder="My Font"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !cloudSaving && safeProjectBaseName(cloudSaveName)) {
                      void confirmSaveToCloud();
                    }
                  }}
                />
              </label>

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
              <button type="button" className="fm-secondary-btn" onClick={() => setCloudDialog(null)} disabled={cloudSaving}>
                Cancel
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
    </>
  );
}
