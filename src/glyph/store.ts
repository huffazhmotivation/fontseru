import { create } from "zustand";
import type { UserPlan } from "@/auth/AuthProvider";
import type { GlyphMap, Glyph, GlyphFamily, FontStyle, CustomFamily } from "@/types/glyph";
import { MAX_CUSTOM_FAMILIES, hasOutline } from "@/types/glyph";
import type { GlyphOutline, StrokeCap, VectorObject } from "@/types/geometry";
import type { ToolId } from "@/types/tool";
import type { BrushSettings, BrushType } from "@/types/brush";
import { buildDefaultGlyphs } from "./defaultGlyphs";
import { cloneGlyphMap, familyFromRegular, newCustomFamilyGlyphs } from "./family";
import { generateBoldFromRegular, generateItalicFromRegular, generateCustomFromRegular, type FamilyGenerationResult } from "./autoGenerate";
import { DEFAULT_METRICS, defaultFontInfo, type FontInfo, type FontMetrics } from "@/types/font";
import { BRUSH_PRESETS } from "@/brushes/presets";
import { cloneObject, deleteNodes } from "@/editor/nodeOps";
import { cloneObjectWithNewIds, translateObject, objectsBounds, scaleObject } from "@/editor/objectOps";
import type { ShapeKind } from "@/editor/shapeBuilder";
import { shortId } from "@/utils/id";
import { expandStrokeObject, normalizeBrushSettings } from "@/brushes/strokeToOutline";
import { applyBooleanOp, type BooleanOp } from "@/editor/booleanOps";
import { composeMultilingualGlyphs, type MultilingualResult } from "@/glyph/multilingual";
import type { KerningPairs, KerningManualFlags, KerningOverridesByStyle, KerningOverrideManualByStyle, KerningContext } from "@/types/kerning";
import { kerningKey, decodeKerningKey } from "@/types/kerning";
import { suggestKerningPair, autoKernAllAvailablePairs } from "@/kerning/autoKern";
import { autoSpaceAllGlyphs as computeAutoSpaceAllGlyphs, suggestWordSpacing, type AutoSpaceResult } from "@/kerning/autoSpace";
import type { FeatureBuilderConfig, LigatureRule, AlternateRule, SwashRule, FeatureGlyphRef } from "@/types/opentypeFeatures";
import { emptyFeatureConfig, nextFeatureRuleId } from "@/types/opentypeFeatures";
import { nextFeatureGlyphUnicode, buildFeatureGlyph, isFeatureGlyphUnicode } from "@/glyph/featureGlyphs";
import type { GlyphCategory } from "@/types/glyph";

export type Theme = "light" | "dark";
export type PenMode = "shape" | "line";
export type GlyphMetricKey = "advanceWidth" | "lsb" | "rsb";
export type GlyphMetricScope = "current" | "all";
export type SelectionSkewHandle = "skew-x-top" | "skew-x-bottom" | "skew-y-left" | "skew-y-right";

export interface NodeRef {
  contourId: string;
  nodeId: string;
}
export interface HandleRef extends NodeRef {
  part: "handleIn" | "handleOut";
}

export type GhostMode = "sample" | "family" | "image";

export interface GhostSettings {
  enabled: boolean;
  mode: GhostMode;
  opacity: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  /** Data URL of a user-uploaded custom ghost/reference image, or null when
   * none has been set. Reference-only: never part of glyph/vector data. */
  imageSrc: string | null;
  /** Natural width/height ratio of imageSrc, so it renders without
   * stretching. Undefined until an image is uploaded. */
  imageAspect?: number;
}

interface HistoryEntry {
  glyphs: GlyphMap;
  /** Present only for atomic operations that mutate a non-active family style. */
  glyphsByStyle?: GlyphFamily;
  metrics: FontMetrics;
  kerningPairs: KerningPairs;
  kerningManual: KerningManualFlags;
  /** Optional so history created by pre-family operations remains compatible. */
  kerningOverridesByStyle?: KerningOverridesByStyle;
  kerningOverrideManualByStyle?: KerningOverrideManualByStyle;
  autoKernLastRun?: { processed: number; updated: number; preservedManual: number } | null;
}
const HISTORY_LIMIT = 120;

function normalizedFontMetric(metrics: FontMetrics, key: keyof FontMetrics, raw: number): number {
  const rounded = Math.round(raw);
  const limit = Math.max(1000, metrics.unitsPerEm * 4);
  if (key === "unitsPerEm") return Math.max(16, Math.min(16384, rounded));
  if (key === "ascender") return Math.max(Math.max(metrics.baseline, metrics.capHeight, metrics.xHeight) + 1, Math.min(limit, rounded));
  if (key === "descender") return Math.min(metrics.baseline - 1, Math.max(-limit, rounded));
  if (key === "baseline") return Math.max(metrics.descender + 1, Math.min(metrics.ascender - 1, rounded));
  if (key === "capHeight") return Math.max(metrics.descender, Math.min(metrics.ascender, rounded));
  if (key === "xHeight") return Math.max(metrics.descender, Math.min(metrics.ascender, rounded));
  if (key === "wordSpacing") return Math.max(0, rounded);
  return rounded;
}

function sameRef(a: NodeRef, b: NodeRef): boolean {
  return a.contourId === b.contourId && a.nodeId === b.nodeId;
}


function applyGlyphMetricPatch(
  glyph: Glyph,
  patch: Partial<Pick<Glyph, GlyphMetricKey>>
): Glyph {
  let next: Glyph = { ...glyph };

  // LSB is the left ink position in the editor. Moving it translates the
  // outline and the advance by the same amount, preserving the current RSB.
  if (patch.lsb !== undefined && Number.isFinite(patch.lsb)) {
    const nextLsb = Math.round(patch.lsb);
    const dx = nextLsb - next.lsb;
    next = {
      ...next,
      lsb: nextLsb,
      advanceWidth: Math.max(1, next.advanceWidth + dx),
      outline: { objects: next.outline.objects.map((o) => translateObject(o, dx, 0)) },
    };
  }

  // RSB is the distance from the rightmost ink edge to the advance boundary.
  // Changing it keeps the ink fixed and moves the advance boundary.
  if (patch.rsb !== undefined && Number.isFinite(patch.rsb)) {
    const nextRsb = Math.round(patch.rsb);
    next = {
      ...next,
      advanceWidth: Math.max(1, next.advanceWidth + (nextRsb - next.rsb)),
      rsb: nextRsb,
    };
  }

  // Direct Advance Width edits move the same right boundary. Keep the stored
  // RSB coherent with that movement instead of leaving stale metric metadata.
  if (patch.advanceWidth !== undefined && Number.isFinite(patch.advanceWidth)) {
    const nextAdvance = Math.max(1, Math.round(patch.advanceWidth));
    const delta = nextAdvance - next.advanceWidth;
    next = {
      ...next,
      advanceWidth: nextAdvance,
      rsb: next.rsb + delta,
    };
  }

  return next;
}

function applyGlyphMetricToMap(
  glyphs: GlyphMap,
  char: string,
  patch: Partial<Pick<Glyph, GlyphMetricKey>>,
  scope: GlyphMetricScope
): GlyphMap {
  if (scope === "all") {
    const next: GlyphMap = {};
    for (const [key, glyph] of Object.entries(glyphs)) {
      next[key] = applyGlyphMetricPatch(glyph, patch);
    }
    return next;
  }
  const glyph = glyphs[char];
  if (!glyph) return glyphs;
  return { ...glyphs, [char]: applyGlyphMetricPatch(glyph, patch) };
}



/**
 * Mirrors `AuthContextValue.plan` (src/auth/AuthProvider.tsx), which is the
 * single source of truth and is always derived fresh from `profiles.plan`.
 * This copy exists ONLY so store actions below (setFontStyle,
 * generateFromRegular, generateFamilyBold/Italic, openFamily) can enforce
 * the FREE/PRO lock at the actual entry point — not just in UI components —
 * so calling these actions directly (devtools, console, a different UI
 * path) can't bypass the lock. AuthProvider pushes updates here via
 * `setPlan` whenever `profiles.plan` changes; nothing in this file ever
 * computes or guesses a plan value itself.
 */
interface AppState {
  /** Synced from AuthProvider via `setPlan` (see the module doc comment
   * above); never computed here. Defaults to "free" (the safe default)
   * until the first sync happens. */
  plan: UserPlan;
  setPlan: (plan: UserPlan) => void;
  theme: Theme;
  fontName: string;
  fontInfo: FontInfo;
  projectFileName: string;
  /** Sketch Mode: an additive canvas mode for tablet/pen drawing. Does not
   * replace or alter normal mode; toggling it back off restores the usual UI. */
  sketchMode: boolean;
  /** Sketch Mode only: whether the right inspector drawer is slid open over
   * the canvas. Ignored outside Sketch Mode (the right panel is always
   * visible there, unaffected by this flag). */
  sketchRightPanelOpen: boolean;
  tool: ToolId;
  penMode: PenMode;
  /** Shape tool only: which primitive the next click-drag draws. Chosen
   * from the small popup under the floating toolbar's Shape button. */
  shapeKind: ShapeKind;
  /** Pen tool (Shape mode) only: when true, finishing an open path (Escape /
   * double-click the last point) auto-closes it into a filled shape instead
   * of leaving it open. Default false preserves the pre-existing behavior. */
  penAutoClose: boolean;
  lineWidth: number;
  lineCap: StrokeCap;
  brushCap: StrokeCap;
  /** When on, resizing/scaling a selected object keeps its stroke width
   * constant instead of scaling it with the object. Purely a transform-time
   * behavior flag; does not affect the brush/line default width elsewhere. */
  strokeWidthLocked: boolean;
  zoom: number;
  /** View center, in SVG coordinate space (Y-down). */
  pan: { x: number; y: number };
  fitNonce: number;
  showGrid: boolean;
  gridSize: number;
  showGuides: boolean;
  /** Soft-snap vector objects (move/transform/scale) to metric & sidebearing
   * guide lines — never grid. Off by default; toggled from BottomBar. */
  snapEnabled: boolean;
  metrics: FontMetrics;
  ghost: GhostSettings;
  brush: BrushSettings;
  glyphMetricScope: GlyphMetricScope;
  glyphMetricFocus: GlyphMetricKey | null;

  /** Glyph map for the currently selected family style. */
  glyphs: GlyphMap;
  glyphsByStyle: GlyphFamily;
  fontStyle: FontStyle;
  /** User-created Glyph tabs beyond Regular/Bold/Italic. Their glyph data
   * lives in glyphsByStyle[id] exactly like any built-in style; this array
   * only tracks which ids exist and what they're called. */
  customFamilies: CustomFamily[];
  activeChar: string;

  // Kerning (kept separate from glyph geometry — see types/kerning.ts)
  kerningPairs: KerningPairs;
  kerningManual: KerningManualFlags;
  /** Sparse style-specific layer; absence means inherit Shared kerningPairs. */
  kerningOverridesByStyle: KerningOverridesByStyle;
  kerningOverrideManualByStyle: KerningOverrideManualByStyle;
  autoKernLastRun: { processed: number; updated: number; preservedManual: number } | null;
  /** Last "Auto Spacing" run against the active style's glyphs, for a brief status readout. */
  autoSpaceLastRun: { updated: number; skipped: number; skippedManual: number } | null;
  /** Last "Apply Tracking" bake against the active style's glyphs. */
  trackingApplyLastRun: { units: number; updated: number } | null;

  // Font Test Lab / Kerning editor overlay
  testLabOpen: boolean;
  testLabTab: "kerning" | "specimen";

  // Family Auto Generate overlay
  familyOpen: boolean;

  // Trace Image overlay (additive — image-to-vector tracing workspace)
  traceOpen: boolean;

  // OpenType Feature Builder overlay (additive — ligature/alternate/swash
  // configuration; compiled into a GSUB table at export time, see
  // utils/fontIO.ts). Never touches glyph geometry/editor state directly.
  featureBuilderOpen: boolean;
  featureConfig: FeatureBuilderConfig;

  // Login modal (auth UI trigger) — additive UI state only, separate from
  // feature-locking (proModalOpen/proModalFeature below). Lets the
  // account button in TopBar/AuthWidget re-open the login popup on
  // demand; actual auth calls still live entirely in AuthProvider.
  loginModalOpen: boolean;

  // PRO feature-locking (Tracing/Family/Brush/Export limit) — additive UI
  // state only; plan itself always comes from AuthProvider/profiles, never
  // written here.
  proModalOpen: boolean;
  proModalFeature: "tracing" | "family" | "brush" | "export" | "cloud" | "featureBuilder" | null;

  selectedObjectIds: string[];
  /** Transient transform UI state; geometry remains the source of truth and project format stays unchanged. */
  selectionSkewAngle: number;
  selectionSkewHandle: SelectionSkewHandle;
  selectedNodes: NodeRef[];
  selectedHandle: HandleRef | null;
  drawingContourId: string | null;
  liveOutline: GlyphOutline | null;
  clipboard: VectorObject[] | null;
  /** Glyph the clipboard objects were copied from. Used by `pasteClipboard`
   * to decide whether to apply the small "nudge" offset (same-glyph paste,
   * so the copy doesn't land exactly on top of the original and become hard
   * to grab) or paste at the exact copied x/y (cross-glyph paste, where
   * there's nothing underneath to collide with and the user expects the
   * shape to land in the same canvas position it was copied from). */
  clipboardSourceChar: string | null;

  past: HistoryEntry[];
  future: HistoryEntry[];

  // chrome
  toggleTheme: () => void;
  toggleSketchMode: () => void;
  toggleSketchRightPanel: () => void;
  setFontName: (name: string) => void;
  setFontInfo: (patch: Partial<FontInfo>) => void;
  setProjectFileName: (name: string) => void;
  newProject: () => void;
  setTool: (tool: ToolId) => void;
  setPenMode: (mode: PenMode) => void;
  setShapeKind: (kind: ShapeKind) => void;
  setPenAutoClose: (on: boolean) => void;
  setLineWidth: (w: number) => void;
  setLineCap: (cap: StrokeCap) => void;
  setBrushCap: (cap: StrokeCap) => void;
  toggleStrokeWidthLock: () => void;
  setZoom: (z: number) => void;
  setPan: (pan: { x: number; y: number }) => void;
  resetView: () => void;
  fitGlyph: () => void;
  toggleGrid: () => void;
  setGridSize: (n: number) => void;
  toggleGuides: () => void;
  toggleSnap: () => void;
  setFontMetric: (key: keyof FontMetrics, value: number) => void;
  beginMetricDrag: () => void;
  setFontMetricLive: (key: keyof FontMetrics, value: number) => void;
  endMetricDrag: () => void;
  metricFocus: keyof FontMetrics | null;
  setMetricFocus: (key: keyof FontMetrics | null) => void;
  setActiveChar: (char: string) => void;
  setFontStyle: (style: FontStyle) => void;
  generateFromRegular: () => void;
  generateFamilyBold: (amount: number, replaceExisting?: boolean) => FamilyGenerationResult;
  generateFamilyItalic: (angle: number, replaceExisting?: boolean) => FamilyGenerationResult;
  generateFamilyCustom: (id: FontStyle, boldAmount: number, italicAngle: number, replaceExisting?: boolean) => FamilyGenerationResult;
  /** Creates a new custom Glyph tab with the given free-form name. PRO-only,
   * capped at MAX_CUSTOM_FAMILIES. Returns the new style id, or null if it
   * couldn't be created (locked, cap reached, or an empty name). */
  addCustomFamily: (name: string) => FontStyle | null;
  /** Removes a custom family tab and its glyph data. Falls back to Regular
   * if the removed tab was active. No-op for built-in styles. */
  removeCustomFamily: (id: FontStyle) => void;
  setGhost: (patch: Partial<GhostSettings>) => void;
  setBrushType: (type: BrushType) => void;
  setBrush: (patch: Partial<BrushSettings>) => void;

  // glyph editing
  updateGlyphMetrics: (char: string, patch: Partial<Pick<Glyph, GlyphMetricKey>>, scope?: GlyphMetricScope) => void;
  setGlyphMetricScope: (scope: GlyphMetricScope) => void;
  setGlyphMetricFocus: (key: GlyphMetricKey | null) => void;
  beginGlyphMetricDrag: () => void;
  setGlyphMetricLive: (char: string, key: GlyphMetricKey, value: number, scope?: GlyphMetricScope) => void;
  endGlyphMetricDrag: () => void;
  commitOutline: (char: string, outline: GlyphOutline) => void;
  setLiveOutline: (outline: GlyphOutline | null) => void;
  updateSelectedObject: (patch: Partial<VectorObject>) => void;

  // object selection / clipboard / transforms
  selectObjects: (ids: string[], additive?: boolean) => void;
  clearObjectSelection: () => void;
  setSelectionSkewState: (angle: number, handle?: SelectionSkewHandle) => void;
  nudgeSelectedObjects: (dx: number, dy: number) => void;
  deleteSelectedObjects: () => void;
  /**
   * Deletes whichever nodes are currently selected (Node tool selection
   * state). Mirrors deleteSelectedObjects but for selectedNodes — used by
   * Sketch Mode's floating toolbar Delete button so it follows whichever
   * selection (nodes or objects) is currently active. Never touches
   * selectedObjectIds.
   */
  deleteSelectedNodes: () => void;
  expandSelectedStrokes: () => void;
  flipSelectedObjects: (axis: "horizontal" | "vertical") => void;
  booleanSelectedObjects: (op: BooleanOp) => void;
  togglePenAutoClose: () => void;
  /** Composes accented-Latin + a few symbol glyphs from existing Regular
   * glyphs (see src/glyph/multilingual.ts). Never touches Bold/Italic
   * directly — those pick the new Regular glyphs up the same way any other
   * Regular glyph does, via the existing Generate From Regular pipeline. */
  addMultilingualGlyphs: () => MultilingualResult;
  copySelection: () => void;
  cutSelection: () => void;
  pasteClipboard: () => void;
  pasteExternalObjects: (objects: VectorObject[]) => void;
  groupSelectedObjects: () => void;
  ungroupSelectedObjects: () => void;

  // node selection
  selectNodes: (refs: NodeRef[], additive?: boolean) => void;
  toggleNodeSelection: (ref: NodeRef) => void;
  clearSelection: () => void;
  setSelectedHandle: (ref: HandleRef | null) => void;
  setDrawingContourId: (id: string | null) => void;

  // history / persistence
  undo: () => void;
  redo: () => void;
  hydrate: (patch: { glyphs?: GlyphMap; glyphsByStyle?: Partial<GlyphFamily>; fontStyle?: FontStyle; customFamilies?: CustomFamily[]; fontName?: string; fontInfo?: Partial<FontInfo>; projectFileName?: string; metrics?: Partial<FontMetrics>; kerningPairs?: KerningPairs; kerningManual?: KerningManualFlags; kerningOverridesByStyle?: KerningOverridesByStyle; kerningOverrideManualByStyle?: KerningOverrideManualByStyle; featureConfig?: FeatureBuilderConfig; activeChar?: string; gridSize?: number; showGrid?: boolean; showGuides?: boolean; snapEnabled?: boolean; ghost?: Partial<GhostSettings>; brush?: BrushSettings }) => void;

  // kerning
  setKerningPair: (left: string, right: string, value: number) => void;
  applyKerningSuggestion: (left: string, right: string) => void;
  resetKerningPair: (left: string, right: string) => void;
  autoKernAllPairs: (onProgress?: (fraction: number) => void) => Promise<void>;
  /** Normalizes every glyph's LSB/RSB in the active style to a shared,
   * optically-balanced baseline margin. Fixes inconsistent hand-drawn
   * sidebearings; runs before Auto Kern refines specific pairs on top. */
  autoSpaceAllGlyphs: (options?: { excludeManuallyKerned?: boolean; reKernAfter?: boolean }, onProgress?: (fraction: number) => void) => Promise<AutoSpaceResult>;
  /** Computes a word-spacing value from the font's own drawn glyphs and applies it (see `suggestWordSpacing`). Returns the value that was set. */
  autoWordSpacing: () => number;
  /** Bakes `trackingUnits` permanently into every glyph's LSB/RSB (split
   * evenly, so ink stays centered in its now-wider/narrower advance) in the
   * active style. Unlike Test Lab's live Tracking preview, this is real
   * glyph data and is included in font export. */
  applyTrackingToAllGlyphs: (trackingUnits: number) => { updated: number };
  beginKerningDrag: () => void;
  setKerningPairLive: (left: string, right: string, value: number) => void;
  endKerningDrag: () => void;

  // Family kerning — additive layer over the existing Single Test API.
  setFamilyKerningPair: (context: KerningContext, left: string, right: string, value: number) => void;
  resetFamilyKerningPair: (context: KerningContext, left: string, right: string) => void;
  autoKernAllPairsForContext: (context: KerningContext, onProgress?: (fraction: number) => void) => Promise<void>;
  /** Family-aware version of `autoSpaceAllGlyphs`: normalizes LSB/RSB for
   * the style selected as Test Lab's "Kerning Context" ("shared" maps to
   * Regular, the same baseline `autoKernAllPairsForContext` uses), instead
   * of always operating on whatever style happens to be open in the main
   * editor. This is what actually makes "Auto Spacing" work while Family
   * Test is active. */
  autoSpaceAllGlyphsForContext: (
    context: KerningContext,
    options?: { excludeManuallyKerned?: boolean; reKernAfter?: boolean },
    onProgress?: (fraction: number) => void
  ) => Promise<AutoSpaceResult>;
  beginFamilyKerningDrag: (context: KerningContext) => void;
  setFamilyKerningPairLive: (context: KerningContext, left: string, right: string, value: number) => void;
  endFamilyKerningDrag: () => void;

  // Test Lab overlay
  openTestLab: (tab?: "kerning" | "specimen") => void;
  closeTestLab: () => void;
  setTestLabTab: (tab: "kerning" | "specimen") => void;
  openFamily: () => void;
  closeFamily: () => void;

  // Trace Image overlay
  openTrace: () => void;
  closeTrace: () => void;
  /**
   * Applies a traced vector outline to a Regular-style glyph, always
   * targeting `glyphsByStyle.regular` regardless of which family style is
   * currently active in the main editor — the Trace Image panel shows the
   * Regular glyph set specifically. Fully undoable and keeps `glyphs` (the
   * active-style working copy) in sync when Regular happens to be active,
   * exactly like the other family-aware commit helpers above.
   */
  commitTracedGlyphOutline: (char: string, outline: GlyphOutline) => void;

  // OpenType Feature Builder overlay
  openFeatureBuilder: () => void;
  closeFeatureBuilder: () => void;
  /**
   * Creates a new drawable glyph for use as a ligature/alternate/swash
   * target, always in `glyphsByStyle.regular` — exactly like
   * `commitTracedGlyphOutline` above and the existing multilingual-glyph
   * pipeline. Bold/Italic/custom families pick it up later the normal way,
   * via "Generate From Regular". Returns false (no-op) if `key` is empty
   * or already exists. `category`/`advanceWidthFrom` only affect where the
   * new glyph is grouped in the existing Glyph list and its starting
   * advance width — never anything about how it renders or edits.
   */
  createFeatureGlyph: (key: string, category?: GlyphCategory, advanceWidthFrom?: string) => boolean;
  /** Internal sync helper: applies `nextConfig` and deletes whichever of
   * `candidateKeys` are Feature-Builder-created glyphs no longer referenced
   * by any rule in `nextConfig`. Called by the remove*Rule/Option actions
   * below — not meant to be called directly from UI. */
  deleteOrphanedFeatureGlyphs: (candidateKeys: FeatureGlyphRef[], nextConfig: FeatureBuilderConfig) => void;
  addLigatureRule: (components: FeatureGlyphRef[], target: FeatureGlyphRef) => void;
  removeLigatureRule: (id: string) => void;
  addAlternateOption: (base: FeatureGlyphRef, alternate: FeatureGlyphRef) => void;
  removeAlternateOption: (id: string, alternate: FeatureGlyphRef) => void;
  removeAlternateRule: (id: string) => void;
  setSwashRule: (base: FeatureGlyphRef, swash: FeatureGlyphRef) => void;
  removeSwashRule: (id: string) => void;

  // PRO feature-locking modal ("Join PRO")
  openProModal: (feature: "tracing" | "family" | "brush" | "export" | "cloud" | "featureBuilder") => void;
  closeProModal: () => void;

  // Login modal (auth UI trigger only — see loginModalOpen above)
  openLoginModal: () => void;
  closeLoginModal: () => void;
}

/** Every glyph key any surviving Feature Builder rule still points to — the
 * ligature components/target, alternate base/alternates, and swash
 * base/swash of every rule in `config`. Used to decide whether a
 * Feature-Builder-created glyph can be safely auto-deleted after one of its
 * rules is removed (a glyph reused by another rule must stay). */
function featureConfigReferencedKeys(config: FeatureBuilderConfig): Set<string> {
  const keys = new Set<string>();
  for (const rule of config.ligatures) {
    for (const c of rule.components) keys.add(c);
    keys.add(rule.target);
  }
  for (const rule of config.alternates) {
    keys.add(rule.base);
    for (const a of rule.alternates) keys.add(a);
  }
  for (const rule of config.swashes) {
    keys.add(rule.base);
    keys.add(rule.swash);
  }
  return keys;
}

export const useAppStore = create<AppState>()((set, get) => {
  let kerningDragSnapshot: { kerningPairs: KerningPairs; kerningManual: KerningManualFlags } | null = null;
  let familyKerningDragSnapshot: {
    context: KerningContext;
    kerningPairs: KerningPairs;
    kerningManual: KerningManualFlags;
    kerningOverridesByStyle: KerningOverridesByStyle;
    kerningOverrideManualByStyle: KerningOverrideManualByStyle;
  } | null = null;
  let metricDragSnapshot: FontMetrics | null = null;
  let glyphMetricDragSnapshot: GlyphMap | null = null;
  /** True if `contourId` still exists (with at least one node) in `char`'s
   * outline within `glyphs`. Used by undo/redo so that stepping through
   * history while the pen tool is mid-contour only removes/restores the
   * node in question — it doesn't force-exit the contour the person is
   * still actively drawing, unless that undo/redo made the contour itself
   * disappear entirely (e.g. undoing its very first node). */
  function contourStillExists(glyphs: GlyphMap, char: string, contourId: string | null): boolean {
    if (!contourId) return false;
    const glyph = glyphs[char];
    if (!glyph) return false;
    for (const obj of glyph.outline.objects) {
      for (const contour of obj.contours) {
        if (contour.id === contourId && contour.nodes.length > 0) return true;
      }
    }
    return false;
  }
  function commit(nextGlyphs: GlyphMap) {
    const { glyphs, glyphsByStyle, fontStyle, metrics, past, kerningPairs, kerningManual } = get();
    set({
      glyphs: nextGlyphs,
      glyphsByStyle: { ...glyphsByStyle, [fontStyle]: nextGlyphs },
      past: [...past, { glyphs, metrics, kerningPairs, kerningManual }].slice(-HISTORY_LIMIT),
      future: [],
    });
  }

  /** Same history stack as `commit`, for edits that touch kerning instead of glyph geometry. */
  function commitKerning(nextPairs: KerningPairs, nextManual: KerningManualFlags) {
    const { glyphs, metrics, past, kerningPairs, kerningManual } = get();
    set({
      kerningPairs: nextPairs,
      kerningManual: nextManual,
      past: [...past, { glyphs, metrics, kerningPairs, kerningManual }].slice(-HISTORY_LIMIT),
      future: [],
    });
  }

  function commitFamilyStyleKerning(style: FontStyle, nextPairs: KerningPairs, nextManual: KerningManualFlags) {
    const state = get();
    set({
      kerningOverridesByStyle: { ...state.kerningOverridesByStyle, [style]: nextPairs },
      kerningOverrideManualByStyle: { ...state.kerningOverrideManualByStyle, [style]: nextManual },
      past: [
        ...state.past,
        {
          glyphs: state.glyphs,
          metrics: state.metrics,
          kerningPairs: state.kerningPairs,
          kerningManual: state.kerningManual,
          kerningOverridesByStyle: state.kerningOverridesByStyle,
          kerningOverrideManualByStyle: state.kerningOverrideManualByStyle,
        },
      ].slice(-HISTORY_LIMIT),
      future: [],
    });
  }

  /** Same history/commit shape as `commit()`, but targets an arbitrary
   * family style instead of always writing to the currently active
   * `fontStyle`/`glyphs`. Used by family-aware actions (e.g. Auto Spacing
   * run against Test Lab's Family Test context) that must edit a style
   * other than the one currently open in the main editor. */
  function commitStyleGlyphs(style: FontStyle, nextGlyphs: GlyphMap) {
    const state = get();
    const nextFamily: GlyphFamily = { ...state.glyphsByStyle, [style]: nextGlyphs };
    set({
      glyphsByStyle: nextFamily,
      glyphs: state.fontStyle === style ? nextGlyphs : state.glyphs,
      past: [
        ...state.past,
        {
          glyphs: state.glyphs,
          glyphsByStyle: state.glyphsByStyle,
          metrics: state.metrics,
          kerningPairs: state.kerningPairs,
          kerningManual: state.kerningManual,
          kerningOverridesByStyle: state.kerningOverridesByStyle,
          kerningOverrideManualByStyle: state.kerningOverrideManualByStyle,
        },
      ].slice(-HISTORY_LIMIT),
      future: [],
    });
  }

  function commitFamilyGeneration(
    targetStyle: FontStyle,
    result: FamilyGenerationResult
  ): FamilyGenerationResult {
    if (result.glyphs === get().glyphsByStyle[targetStyle]) return result;
    const state = get();
    const nextFamily: GlyphFamily = { ...state.glyphsByStyle, [targetStyle]: result.glyphs };
    set({
      glyphsByStyle: nextFamily,
      glyphs: state.fontStyle === targetStyle ? result.glyphs : state.glyphs,
      past: [
        ...state.past,
        {
          glyphs: state.glyphs,
          glyphsByStyle: state.glyphsByStyle,
          metrics: state.metrics,
          kerningPairs: state.kerningPairs,
          kerningManual: state.kerningManual,
          kerningOverridesByStyle: state.kerningOverridesByStyle,
          kerningOverrideManualByStyle: state.kerningOverrideManualByStyle,
        },
      ].slice(-HISTORY_LIMIT),
      future: [],
      selectedObjectIds: [],
      selectedNodes: [],
      selectedHandle: null,
      drawingContourId: null,
      liveOutline: null,
    });
    return result;
  }

  /** Real (non-UI) enforcement point for PRO-only actions: used by every
   * store action below that must stay locked for FREE even if it's invoked
   * directly (console/devtools, a different UI path, etc.) instead of
   * through the gated buttons. Opens the existing ProUpsellModal instead of
   * performing the action. */
  function requirePro(feature: "tracing" | "family" | "brush" | "export" | "featureBuilder"): boolean {
    if (get().plan === "pro") return true;
    set({ proModalOpen: true, proModalFeature: feature });
    return false;
  }

  function finalizeLive() {
    const { liveOutline, activeChar, glyphs } = get();
    if (!liveOutline) return;
    const glyph = glyphs[activeChar];
    if (!glyph) return set({ liveOutline: null });
    commit({ ...glyphs, [activeChar]: { ...glyph, outline: liveOutline } });
    set({ liveOutline: null });
  }

  function activeGlyph(): Glyph | undefined {
    const { glyphs, activeChar } = get();
    return glyphs[activeChar];
  }

  const initialRegular = buildDefaultGlyphs();
  const initialFamily = familyFromRegular(initialRegular);

  return {
    plan: "free",
    setPlan: (plan) => set({ plan }),
    theme: "dark",
    fontName: "Untitled Font",
    fontInfo: defaultFontInfo("Untitled Font"),
    projectFileName: "Untitled Font.fs",
    sketchMode: false,
    sketchRightPanelOpen: false,
    tool: "select",
    penMode: "shape",
    shapeKind: "rectangle",
    penAutoClose: false,
    lineWidth: 24,
    lineCap: "round",
    brushCap: "round",
    strokeWidthLocked: false,
    zoom: 100,
    pan: { x: 500, y: 500 },
    fitNonce: 0,
    showGrid: true,
    gridSize: 50,
    showGuides: true,
    snapEnabled: false,
    metrics: { ...DEFAULT_METRICS },
    metricFocus: null,
    ghost: { enabled: true, mode: "sample", opacity: 0.12, scale: 1, offsetX: 0, offsetY: 0, imageSrc: null, imageAspect: undefined },
    brush: { type: "monoline", ...BRUSH_PRESETS.monoline.settings },
    glyphMetricScope: "current",
    glyphMetricFocus: null,

    glyphs: initialRegular,
    glyphsByStyle: initialFamily,
    fontStyle: "regular",
    customFamilies: [],
    activeChar: "A",

    kerningPairs: {},
    kerningManual: {},
    kerningOverridesByStyle: {},
    kerningOverrideManualByStyle: {},
    autoKernLastRun: null,
    autoSpaceLastRun: null,
    trackingApplyLastRun: null,
    testLabOpen: false,
    testLabTab: "specimen",
    familyOpen: false,
    traceOpen: false,
    featureBuilderOpen: false,
    featureConfig: emptyFeatureConfig(),
    loginModalOpen: false,
    proModalOpen: false,
    proModalFeature: null,

    selectedObjectIds: [],
    selectionSkewAngle: 0,
    selectionSkewHandle: "skew-x-top",
    selectedNodes: [],
    selectedHandle: null,
    drawingContourId: null,
    liveOutline: null,
    clipboard: null,
    clipboardSourceChar: null,

    past: [],
    future: [],

    toggleTheme: () => set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),
    // Entering Sketch Mode nudges the tool to Brush (its whole purpose is
    // drawing); leaving it never forces a tool change, so normal mode is
    // left exactly as the user had it.
    toggleSketchMode: () =>
      set((s) => ({
        sketchMode: !s.sketchMode,
        tool: !s.sketchMode ? "brush" : s.tool,
        // Always start Sketch Mode's right drawer closed so canvas space
        // is maximized the moment Sketch Mode turns on.
        sketchRightPanelOpen: !s.sketchMode ? false : s.sketchRightPanelOpen,
      })),
    // Sketch Mode's right-panel drawer only; closing it on exit keeps every
    // re-entry into Sketch Mode starting from the same clean, canvas-first
    // state rather than remembering a stale open drawer.
    toggleSketchRightPanel: () => set((s) => ({ sketchRightPanelOpen: !s.sketchRightPanelOpen })),
    setFontName: (name) => set((s) => ({
      fontName: name,
      fontInfo: s.fontInfo.familyName === s.fontName ? { ...s.fontInfo, familyName: name, fullName: `${name} ${s.fontInfo.styleName}` } : s.fontInfo,
    })),
    setFontInfo: (patch) => set((s) => ({ fontInfo: { ...s.fontInfo, ...patch } })),
    setProjectFileName: (name) => set({ projectFileName: name }),
    newProject: () => {
      const name = "Untitled Font";
      const regular = buildDefaultGlyphs();
      const family = familyFromRegular(regular);
      set({
        fontName: name,
        fontInfo: defaultFontInfo(name),
        projectFileName: `${name}.fs`,
        metrics: { ...DEFAULT_METRICS },
        glyphs: regular,
        glyphsByStyle: family,
        fontStyle: "regular",
        customFamilies: [],
        activeChar: "A",
        kerningPairs: {},
        kerningManual: {},
        kerningOverridesByStyle: {},
        kerningOverrideManualByStyle: {},
        autoKernLastRun: null,
        autoSpaceLastRun: null,
        trackingApplyLastRun: null,
        featureConfig: emptyFeatureConfig(),
        selectedObjectIds: [],
        selectedNodes: [],
        selectedHandle: null,
        drawingContourId: null,
        liveOutline: null,
        clipboard: null,
        clipboardSourceChar: null,
        glyphMetricScope: "current",
        glyphMetricFocus: null,
        past: [],
        future: [],
      });
    },
    setTool: (tool) => {
      finalizeLive();
      set((s) => ({
        tool,
        drawingContourId: null,
        selectedNodes: tool === "node" ? s.selectedNodes : [],
        selectedHandle: tool === "node" ? s.selectedHandle : null,
        // Keep selectedObjectIds when moving between Select <-> Node so the
        // Node tool knows which object's nodes should be active. Any other
        // tool (pen/shape/brush/...) still clears it, since those tools
        // don't have a notion of "the active object's nodes".
        selectedObjectIds: tool === "select" || tool === "node" ? s.selectedObjectIds : [],
      }));
    },
    setPenMode: (mode) => set({ penMode: mode }),
    setShapeKind: (kind) => set({ shapeKind: kind }),
    setPenAutoClose: (on) => set({ penAutoClose: on }),
    togglePenAutoClose: () => set((s) => ({ penAutoClose: !s.penAutoClose })),
    setLineWidth: (w) => set({ lineWidth: Math.max(1, Math.round(w)) }),
    setLineCap: (cap) => set({ lineCap: cap }),
    setBrushCap: (cap) => set({ brushCap: cap }),
    toggleStrokeWidthLock: () => set((s) => ({ strokeWidthLocked: !s.strokeWidthLocked })),
    setZoom: (z) => set({ zoom: Math.min(8000, Math.max(20, Math.round(z))) }),
    setPan: (pan) => set({ pan }),
    resetView: () => {
      const { metrics } = get();
      set({ zoom: 100, pan: { x: metrics.unitsPerEm / 2, y: (metrics.ascender - metrics.descender) / 2 } });
    },
    fitGlyph: () => set((s) => ({ fitNonce: s.fitNonce + 1 })),
    toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
    setGridSize: (n) => set({ gridSize: Math.min(200, Math.max(2, Math.round(n))) }),
    toggleGuides: () => set((s) => ({ showGuides: !s.showGuides })),
    toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
    setFontMetric: (key, value) => {
      const { metrics, glyphs, past, kerningPairs, kerningManual } = get();
      const nextValue = normalizedFontMetric(metrics, key, value);
      if (metrics[key] === nextValue) return;
      set({
        metrics: { ...metrics, [key]: nextValue },
        past: [...past, { glyphs, metrics, kerningPairs, kerningManual }].slice(-HISTORY_LIMIT),
        future: [],
      });
    },
    autoWordSpacing: () => {
      const { glyphs, metrics } = get();
      const suggestion = suggestWordSpacing(glyphs, metrics);
      get().setFontMetric("wordSpacing", suggestion);
      return suggestion;
    },
    beginMetricDrag: () => {
      if (!metricDragSnapshot) metricDragSnapshot = { ...get().metrics };
    },
    setFontMetricLive: (key, value) =>
      set((s) => ({
        metrics: {
          ...s.metrics,
          [key]: normalizedFontMetric(s.metrics, key, value),
        },
      })),
    endMetricDrag: () => {
      if (!metricDragSnapshot) return;
      const before = metricDragSnapshot;
      metricDragSnapshot = null;
      const { metrics, glyphs, past, kerningPairs, kerningManual } = get();
      if (JSON.stringify(before) === JSON.stringify(metrics)) return;
      set({
        past: [...past, { glyphs, metrics: before, kerningPairs, kerningManual }].slice(-HISTORY_LIMIT),
        future: [],
      });
    },
    setMetricFocus: (key) => set({ metricFocus: key }),
    setActiveChar: (char) => {
      finalizeLive();
      set({ activeChar: char, selectedNodes: [], selectedHandle: null, selectedObjectIds: [], drawingContourId: null });
    },

    setFontStyle: (style) => {
      if (style === get().fontStyle) return;
      // Bold/Italic are PRO-only; Regular always stays open to everyone.
      if (style !== "regular" && !requirePro("family")) return;
      finalizeLive();
      const state = get();
      const nextGlyphs = state.glyphsByStyle[style];
      const nextActiveChar = nextGlyphs[state.activeChar]
        ? state.activeChar
        : Object.keys(nextGlyphs)[0] ?? state.activeChar;
      set({
        fontStyle: style,
        glyphs: nextGlyphs,
        activeChar: nextActiveChar,
        selectedObjectIds: [],
        selectedNodes: [],
        selectedHandle: null,
        drawingContourId: null,
        liveOutline: null,
        clipboard: null,
        clipboardSourceChar: null,
        glyphMetricFocus: null,
        past: [],
        future: [],
      });
    },

    generateFromRegular: () => {
      if (!requirePro("family")) return;
      finalizeLive();
      const state = get();
      if (state.fontStyle === "regular") return;
      const generated = cloneGlyphMap(state.glyphsByStyle.regular);
      const nextActiveChar = generated[state.activeChar]
        ? state.activeChar
        : Object.keys(generated)[0] ?? state.activeChar;
      set({
        glyphs: generated,
        glyphsByStyle: { ...state.glyphsByStyle, [state.fontStyle]: generated },
        activeChar: nextActiveChar,
        selectedObjectIds: [],
        selectedNodes: [],
        selectedHandle: null,
        drawingContourId: null,
        liveOutline: null,
        clipboard: null,
        clipboardSourceChar: null,
        glyphMetricFocus: null,
        past: [],
        future: [],
      });
    },

    generateFamilyBold: (amount, replaceExisting = false) => {
      if (!requirePro("family")) {
        return { glyphs: get().glyphsByStyle.bold, generated: 0, replaced: 0, preserved: 0, skippedRegular: 0 };
      }
      finalizeLive();
      const state = get();
      return commitFamilyGeneration(
        "bold",
        generateBoldFromRegular(state.glyphsByStyle.regular, state.glyphsByStyle.bold, amount, replaceExisting)
      );
    },

    generateFamilyItalic: (angle, replaceExisting = false) => {
      if (!requirePro("family")) {
        return { glyphs: get().glyphsByStyle.italic, generated: 0, replaced: 0, preserved: 0, skippedRegular: 0 };
      }
      finalizeLive();
      const state = get();
      return commitFamilyGeneration(
        "italic",
        generateItalicFromRegular(state.glyphsByStyle.regular, state.glyphsByStyle.italic, angle, replaceExisting)
      );
    },

    generateFamilyCustom: (id, boldAmount, italicAngle, replaceExisting = false) => {
      if (!requirePro("family")) {
        return { glyphs: get().glyphsByStyle[id] ?? {}, generated: 0, replaced: 0, preserved: 0, skippedRegular: 0 };
      }
      finalizeLive();
      const state = get();
      const target = state.glyphsByStyle[id];
      if (!target) return { glyphs: {}, generated: 0, replaced: 0, preserved: 0, skippedRegular: 0 };
      return commitFamilyGeneration(
        id,
        generateCustomFromRegular(state.glyphsByStyle.regular, target, boldAmount, italicAngle, replaceExisting)
      );
    },

    addCustomFamily: (name) => {
      if (!requirePro("family")) return null;
      const state = get();
      const trimmed = name.trim();
      if (!trimmed) return null;
      if (state.customFamilies.length >= MAX_CUSTOM_FAMILIES) return null;
      finalizeLive();
      const id = shortId("family");
      const glyphs = newCustomFamilyGlyphs(state.glyphsByStyle.regular);
      const nextFamilies = [...state.customFamilies, { id, name: trimmed }];
      const nextGlyphsByStyle: GlyphFamily = { ...state.glyphsByStyle, [id]: glyphs };
      set({
        customFamilies: nextFamilies,
        glyphsByStyle: nextGlyphsByStyle,
        fontStyle: id,
        glyphs,
        activeChar: glyphs[state.activeChar] ? state.activeChar : Object.keys(glyphs)[0] ?? state.activeChar,
        selectedObjectIds: [],
        selectedNodes: [],
        selectedHandle: null,
        drawingContourId: null,
        liveOutline: null,
        clipboard: null,
        clipboardSourceChar: null,
        glyphMetricFocus: null,
        past: [],
        future: [],
      });
      return id;
    },

    removeCustomFamily: (id) => {
      const state = get();
      if (!state.customFamilies.some((f) => f.id === id)) return;
      const nextFamilies = state.customFamilies.filter((f) => f.id !== id);
      const nextGlyphsByStyle = { ...state.glyphsByStyle };
      delete nextGlyphsByStyle[id];
      const wasActive = state.fontStyle === id;
      const nextStyle = wasActive ? "regular" : state.fontStyle;
      const nextGlyphs = wasActive ? nextGlyphsByStyle.regular : state.glyphs;
      set({
        customFamilies: nextFamilies,
        glyphsByStyle: nextGlyphsByStyle,
        fontStyle: nextStyle,
        glyphs: nextGlyphs,
        activeChar: wasActive
          ? (nextGlyphs[state.activeChar] ? state.activeChar : Object.keys(nextGlyphs)[0] ?? state.activeChar)
          : state.activeChar,
        selectedObjectIds: [],
        selectedNodes: [],
        selectedHandle: null,
        drawingContourId: null,
        liveOutline: null,
      });
    },

    setGhost: (patch) => set((s) => ({ ghost: { ...s.ghost, ...patch } })),
    // Full replace, NOT a merge over the previous brush: presets like Pixel
    // set flags (gridSnap) that plain object-spread merging would let leak
    // into the next brush if the new preset simply omits that key. Every
    // brush switch must fully reset to the target preset's own settings —
    // this is what guarantees pixel grid-snapping never survives a switch
    // to Monoline/Marker/Calligraphic/Pencil/Grunge.
    setBrushType: (type) =>
      set(() => {
        const next = { type, ...BRUSH_PRESETS[type].settings } as BrushSettings;
        if (type !== "pixel") delete next.gridSnap;
        return { brush: next };
      }),
    setBrush: (patch) =>
      set((s) => {
        const next = { ...s.brush, ...patch };
        if (next.type === "pixel") next.gridSnap = true;
        else delete next.gridSnap;
        return { brush: next };
      }),

    updateGlyphMetrics: (char, patch, scope) => {
      const { glyphs, glyphMetricScope } = get();
      const nextGlyphs = applyGlyphMetricToMap(glyphs, char, patch, scope ?? glyphMetricScope);
      if (nextGlyphs === glyphs) return;
      commit(nextGlyphs);
    },

    setGlyphMetricScope: (scope) => set({ glyphMetricScope: scope }),
    setGlyphMetricFocus: (key) => set({ glyphMetricFocus: key }),

    beginGlyphMetricDrag: () => {
      if (!glyphMetricDragSnapshot) glyphMetricDragSnapshot = get().glyphs;
    },

    setGlyphMetricLive: (char, key, value, scope) => {
      if (!Number.isFinite(value)) return;
      const { glyphs, glyphsByStyle, fontStyle, glyphMetricScope } = get();
      const nextGlyphs = applyGlyphMetricToMap(glyphs, char, { [key]: value }, scope ?? glyphMetricScope);
      set({
        glyphs: nextGlyphs,
        glyphsByStyle: { ...glyphsByStyle, [fontStyle]: nextGlyphs },
      });
    },

    endGlyphMetricDrag: () => {
      if (!glyphMetricDragSnapshot) return;
      const before = glyphMetricDragSnapshot;
      glyphMetricDragSnapshot = null;
      const { glyphs, metrics, past, kerningPairs, kerningManual } = get();
      if (before === glyphs) return;
      set({
        past: [...past, { glyphs: before, metrics, kerningPairs, kerningManual }].slice(-HISTORY_LIMIT),
        future: [],
      });
    },

    commitOutline: (char, outline) => {
      const { glyphs } = get();
      const glyph = glyphs[char];
      if (!glyph) return;
      commit({ ...glyphs, [char]: { ...glyph, outline } });
      set({ liveOutline: null });
    },

    setLiveOutline: (outline) => set({ liveOutline: outline }),

    updateSelectedObject: (patch) => {
      const { glyphs, activeChar, selectedObjectIds } = get();
      const glyph = glyphs[activeChar];
      if (!glyph || selectedObjectIds.length === 0) return;
      const objects = glyph.outline.objects.map((o) => {
        if (!selectedObjectIds.includes(o.id)) return o;
        const next = cloneObject(o);
        if (patch.strokeWidth !== undefined && (o.kind === "line" || o.kind === "brush")) {
          next.strokeWidth = patch.strokeWidth;
        }
        if (
          patch.cap !== undefined &&
          (o.kind === "line" || (o.kind === "brush" && o.brushType === "monoline"))
        ) {
          next.cap = patch.cap;
        }
        const rest = { ...patch };
        delete rest.strokeWidth;
        delete rest.cap;
        return { ...next, ...rest };
      });
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
    },

    selectObjects: (ids, additive) =>
      set((s) => {
        if (!additive) {
          return {
            selectedObjectIds: ids,
            selectedNodes: [],
            selectedHandle: null,
            selectionSkewAngle: 0,
            selectionSkewHandle: "skew-x-top",
          };
        }
        const merged = new Set(s.selectedObjectIds);
        for (const id of ids) merged.has(id) ? merged.delete(id) : merged.add(id);
        return {
          selectedObjectIds: [...merged],
          selectionSkewAngle: 0,
          selectionSkewHandle: "skew-x-top",
        };
      }),
    clearObjectSelection: () => set({
      selectedObjectIds: [],
      selectionSkewAngle: 0,
      selectionSkewHandle: "skew-x-top",
    }),
    setSelectionSkewState: (angle, handle) =>
      set((s) => ({
        selectionSkewAngle: angle,
        selectionSkewHandle: handle ?? s.selectionSkewHandle,
      })),

    nudgeSelectedObjects: (dx, dy) => {
      const glyph = activeGlyph();
      const { glyphs, activeChar, selectedObjectIds } = get();
      if (!glyph || selectedObjectIds.length === 0) return;
      const objects = glyph.outline.objects.map((o) =>
        selectedObjectIds.includes(o.id) ? translateObject(o, dx, dy) : o
      );
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
    },

    deleteSelectedObjects: () => {
      const glyph = activeGlyph();
      const { glyphs, activeChar, selectedObjectIds } = get();
      if (!glyph || selectedObjectIds.length === 0) return;
      const objects = glyph.outline.objects.filter((o) => !selectedObjectIds.includes(o.id));
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
      set({ selectedObjectIds: [] });
    },

    deleteSelectedNodes: () => {
      const glyph = activeGlyph();
      const { activeChar, selectedNodes } = get();
      if (!glyph || selectedNodes.length === 0) return;
      get().commitOutline(activeChar, deleteNodes(glyph.outline, selectedNodes));
      set({ selectedNodes: [], selectedHandle: null });
    },

    expandSelectedStrokes: () => {
      const glyph = activeGlyph();
      const { glyphs, activeChar, selectedObjectIds } = get();
      if (!glyph) return;
      const newIds: string[] = [];
      const objects: VectorObject[] = [];
      for (const o of glyph.outline.objects) {
        if (selectedObjectIds.includes(o.id) && (o.kind === "line" || o.kind === "brush")) {
          const expanded = expandStrokeObject(o);
          if (expanded) { if (o.groupId) expanded.groupId = o.groupId; objects.push(expanded); newIds.push(expanded.id); continue; }
        }
        objects.push(o);
      }
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
      set({ selectedObjectIds: newIds });
    },

    // Mirrors the current selection in place around its combined bounding
    // box center. Position, transform state, per-object selection and all
    // glyph data (node types, groupId, stroke settings, samples) survive
    // untouched — only point/handle coordinates are reflected.
    flipSelectedObjects: (axis) => {
      const glyph = activeGlyph();
      const { glyphs, activeChar, selectedObjectIds } = get();
      if (!glyph || selectedObjectIds.length === 0) return;
      const bounds = objectsBounds(glyph.outline, selectedObjectIds);
      if (!bounds) return;
      const anchor = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
      const sx = axis === "horizontal" ? -1 : 1;
      const sy = axis === "vertical" ? -1 : 1;
      const objects = glyph.outline.objects.map((o) =>
        selectedObjectIds.includes(o.id) ? scaleObject(o, anchor, sx, sy, true) : o
      );
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
    },

    // Combines 2+ selected filled objects (shape/expanded) into one new
    // shape via a real polygon boolean op, and replaces them in place —
    // other objects, their order, and the rest of the glyph are untouched.
    booleanSelectedObjects: (op) => {
      const glyph = activeGlyph();
      const { glyphs, activeChar, selectedObjectIds } = get();
      if (!glyph) return;
      const inZOrder = glyph.outline.objects.filter((o) => selectedObjectIds.includes(o.id));
      const result = applyBooleanOp(inZOrder, op);
      if (!result) return;
      const eligibleIds = new Set(inZOrder.filter((o) => o.kind === "shape" || o.kind === "expanded").map((o) => o.id));
      const firstEligibleIndex = glyph.outline.objects.findIndex((o) => eligibleIds.has(o.id));
      const remaining = glyph.outline.objects.filter((o) => !eligibleIds.has(o.id));
      const insertAt = glyph.outline.objects.slice(0, firstEligibleIndex).filter((o) => !eligibleIds.has(o.id)).length;
      const objects = [...remaining.slice(0, insertAt), result, ...remaining.slice(insertAt)];
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
      set({ selectedObjectIds: [result.id] });
    },

    addMultilingualGlyphs: () => {
      finalizeLive();
      const state = get();
      const regularGlyphs = state.glyphsByStyle.regular;
      const result = composeMultilingualGlyphs(regularGlyphs, state.metrics);
      if (
        result.created === 0 &&
        result.markSlotsAdded === 0 &&
        result.symbolSlotsAdded === 0 &&
        result.letterSlotsAdded === 0
      ) {
        return result;
      }
      const nextGlyphsByStyle = { ...state.glyphsByStyle, regular: result.glyphs };
      const nextGlyphs = state.fontStyle === "regular" ? result.glyphs : state.glyphs;
      set({
        glyphs: nextGlyphs,
        glyphsByStyle: nextGlyphsByStyle,
        past: [
          ...state.past,
          { glyphs: state.glyphs, metrics: state.metrics, kerningPairs: state.kerningPairs, kerningManual: state.kerningManual },
        ].slice(-HISTORY_LIMIT),
        future: [],
      });
      return result;
    },

    copySelection: () => {
      const glyph = activeGlyph();
      if (!glyph) return;
      const { selectedObjectIds, activeChar } = get();
      const objs = glyph.outline.objects.filter((o) => selectedObjectIds.includes(o.id));
      if (objs.length) set({ clipboard: objs.map(cloneObject), clipboardSourceChar: activeChar });
    },
    cutSelection: () => {
      get().copySelection();
      get().deleteSelectedObjects();
    },
    pasteClipboard: () => {
      const { clipboard, clipboardSourceChar, glyphs, activeChar } = get();
      const glyph = glyphs[activeChar];
      if (!clipboard || clipboard.length === 0 || !glyph) return;
      // Pasting back into the same glyph it was copied from nudges the copy
      // so it doesn't land exactly on top of the original (which would make
      // the new shape invisible/hard to grab). Pasting into a different
      // glyph has nothing underneath to collide with, and the user expects
      // the shape to appear at the exact x/y it was copied from.
      const sameGlyph = clipboardSourceChar === activeChar;
      const [nudgeX, nudgeY] = sameGlyph ? [40, -40] : [0, 0];
      const groupMap = new Map<string, string>();
      const pasted = clipboard.map((source) => {
        const o = translateObject(cloneObjectWithNewIds(source), nudgeX, nudgeY);
        if (source.groupId) {
          let nextGroup = groupMap.get(source.groupId);
          if (!nextGroup) {
            nextGroup = shortId("group");
            groupMap.set(source.groupId, nextGroup);
          }
          o.groupId = nextGroup;
        } else {
          delete o.groupId;
        }
        return o;
      });
      const objects = [...glyph.outline.objects, ...pasted];
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
      // After landing in this glyph, treat it as the new clipboard "home" so
      // a repeated paste here nudges (avoiding an invisible exact-stack)
      // instead of re-pasting on top of the shape we just placed.
      set({
        tool: "select",
        selectedObjectIds: pasted.map((o) => o.id),
        selectedNodes: [],
        selectedHandle: null,
        clipboardSourceChar: activeChar,
      });
    },

    // Inserts already-transformed vector objects (already in font-unit space,
    // already carrying fresh ids) straight into the active glyph, additively,
    // and selects them. Used by the OS-clipboard SVG paste path (Affinity
    // Designer / Illustrator, etc.) — kept separate from `pasteClipboard`
    // above since that one always applies FontSeru's own internal-clipboard
    // nudge-on-paste offset, which pasted-in outside vectors don't need.
    pasteExternalObjects: (objects) => {
      const { glyphs, activeChar } = get();
      const glyph = glyphs[activeChar];
      if (!glyph || objects.length === 0) return;
      const merged = [...glyph.outline.objects, ...objects];
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects: merged } } });
      set({ tool: "select", selectedObjectIds: objects.map((o) => o.id), selectedNodes: [], selectedHandle: null });
    },

    groupSelectedObjects: () => {
      const { glyphs, activeChar, selectedObjectIds } = get();
      const glyph = glyphs[activeChar];
      if (!glyph || selectedObjectIds.length < 2) return;
      const groupId = shortId("group");
      const objects = glyph.outline.objects.map((o) =>
        selectedObjectIds.includes(o.id) ? { ...cloneObject(o), groupId } : o
      );
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
    },

    ungroupSelectedObjects: () => {
      const { glyphs, activeChar, selectedObjectIds } = get();
      const glyph = glyphs[activeChar];
      if (!glyph || selectedObjectIds.length === 0) return;
      const groupIds = new Set(
        glyph.outline.objects
          .filter((o) => selectedObjectIds.includes(o.id) && o.groupId)
          .map((o) => o.groupId as string)
      );
      if (groupIds.size === 0) return;
      const objects = glyph.outline.objects.map((o) => {
        if (!o.groupId || !groupIds.has(o.groupId)) return o;
        const next = cloneObject(o);
        delete next.groupId;
        return next;
      });
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
    },

    selectNodes: (refs, additive) =>
      set((s) => {
        if (!additive) return { selectedNodes: refs, selectedHandle: null };
        const merged = [...s.selectedNodes];
        for (const r of refs) if (!merged.some((m) => sameRef(m, r))) merged.push(r);
        return { selectedNodes: merged, selectedHandle: null };
      }),
    toggleNodeSelection: (ref) =>
      set((s) => {
        const exists = s.selectedNodes.some((m) => sameRef(m, ref));
        return {
          selectedNodes: exists ? s.selectedNodes.filter((m) => !sameRef(m, ref)) : [...s.selectedNodes, ref],
          selectedHandle: null,
        };
      }),
    clearSelection: () => set({ selectedNodes: [], selectedHandle: null }),
    setSelectedHandle: (ref) =>
      set({ selectedHandle: ref, selectedNodes: ref ? [{ contourId: ref.contourId, nodeId: ref.nodeId }] : [] }),
    setDrawingContourId: (id) => set({ drawingContourId: id }),

    undo: () => {
      const {
        past, future, glyphs, glyphsByStyle, fontStyle, metrics, kerningPairs, kerningManual,
        kerningOverridesByStyle, kerningOverrideManualByStyle, activeChar, drawingContourId,
      } = get();
      if (past.length === 0) return;
      const prev = past[past.length - 1];
      const familyTransaction = Boolean(prev.glyphsByStyle);
      const restoredFamily = prev.glyphsByStyle ?? { ...glyphsByStyle, [fontStyle]: prev.glyphs };
      const restoredGlyphs = familyTransaction ? restoredFamily[fontStyle] : prev.glyphs;
      const stillDrawing = contourStillExists(restoredGlyphs, activeChar, drawingContourId);
      set({
        glyphs: restoredGlyphs,
        glyphsByStyle: restoredFamily,
        metrics: prev.metrics,
        kerningPairs: prev.kerningPairs,
        kerningManual: prev.kerningManual,
        kerningOverridesByStyle: prev.kerningOverridesByStyle ?? kerningOverridesByStyle,
        kerningOverrideManualByStyle: prev.kerningOverrideManualByStyle ?? kerningOverrideManualByStyle,
        past: past.slice(0, -1),
        future: [{
          glyphs,
          glyphsByStyle: familyTransaction ? glyphsByStyle : undefined,
          metrics,
          kerningPairs,
          kerningManual,
          kerningOverridesByStyle,
          kerningOverrideManualByStyle,
        }, ...future].slice(0, HISTORY_LIMIT),
        selectedNodes: [], selectedHandle: null, selectedObjectIds: [],
        drawingContourId: stillDrawing ? drawingContourId : null,
        liveOutline: null,
      });
    },
    redo: () => {
      const {
        past, future, glyphs, glyphsByStyle, fontStyle, metrics, kerningPairs, kerningManual,
        kerningOverridesByStyle, kerningOverrideManualByStyle, activeChar, drawingContourId,
      } = get();
      if (future.length === 0) return;
      const next = future[0];
      const familyTransaction = Boolean(next.glyphsByStyle);
      const restoredFamily = next.glyphsByStyle ?? { ...glyphsByStyle, [fontStyle]: next.glyphs };
      const restoredGlyphs = familyTransaction ? restoredFamily[fontStyle] : next.glyphs;
      const stillDrawing = contourStillExists(restoredGlyphs, activeChar, drawingContourId);
      set({
        glyphs: restoredGlyphs,
        glyphsByStyle: restoredFamily,
        metrics: next.metrics,
        kerningPairs: next.kerningPairs,
        kerningManual: next.kerningManual,
        kerningOverridesByStyle: next.kerningOverridesByStyle ?? kerningOverridesByStyle,
        kerningOverrideManualByStyle: next.kerningOverrideManualByStyle ?? kerningOverrideManualByStyle,
        future: future.slice(1),
        past: [...past, {
          glyphs,
          glyphsByStyle: familyTransaction ? glyphsByStyle : undefined,
          metrics,
          kerningPairs,
          kerningManual,
          kerningOverridesByStyle,
          kerningOverrideManualByStyle,
        }].slice(-HISTORY_LIMIT),
        selectedNodes: [], selectedHandle: null, selectedObjectIds: [],
        drawingContourId: stillDrawing ? drawingContourId : null,
        liveOutline: null,
      });
    },

    hydrate: (patch) =>
      set((s) => {
        const incomingRegular = patch.glyphsByStyle?.regular ?? patch.glyphs;
        const fallbackFamily = incomingRegular ? familyFromRegular(incomingRegular) : s.glyphsByStyle;
        const explicitStyles = patch.glyphsByStyle ?? {};
        // Spread explicitStyles last so any custom-family keys it carries
        // (ids beyond regular/bold/italic) come through untouched, exactly
        // like the three built-ins already did.
        const family: GlyphFamily = {
          ...fallbackFamily,
          ...explicitStyles,
          regular: explicitStyles.regular ?? fallbackFamily.regular,
          bold: explicitStyles.bold ?? fallbackFamily.bold,
          italic: explicitStyles.italic ?? fallbackFamily.italic,
        };
        const customFamilies = patch.customFamilies ?? (incomingRegular ? [] : s.customFamilies);
        const style: FontStyle = patch.fontStyle ?? (incomingRegular ? "regular" : s.fontStyle);
        const activeGlyphs = family[style];
        const activeChar = patch.activeChar && activeGlyphs[patch.activeChar]
          ? patch.activeChar
          : activeGlyphs[s.activeChar]
            ? s.activeChar
            : Object.keys(activeGlyphs)[0] ?? s.activeChar;
        return {
          glyphs: activeGlyphs,
          glyphsByStyle: family,
          fontStyle: style,
          customFamilies,
          fontName: patch.fontName ?? s.fontName,
          fontInfo: patch.fontInfo ? { ...s.fontInfo, ...patch.fontInfo } : s.fontInfo,
          projectFileName: patch.projectFileName ?? s.projectFileName,
          metrics: patch.metrics ? { ...s.metrics, ...patch.metrics, baseline: patch.metrics.baseline ?? s.metrics.baseline ?? 0 } : s.metrics,
          kerningPairs: patch.kerningPairs ?? s.kerningPairs,
          kerningManual: patch.kerningManual ?? s.kerningManual,
          kerningOverridesByStyle: patch.kerningOverridesByStyle ?? (incomingRegular ? {} : s.kerningOverridesByStyle),
          kerningOverrideManualByStyle: patch.kerningOverrideManualByStyle ?? (incomingRegular ? {} : s.kerningOverrideManualByStyle),
          featureConfig: patch.featureConfig ?? (incomingRegular ? emptyFeatureConfig() : s.featureConfig),
          activeChar,
          gridSize: patch.gridSize ?? s.gridSize,
          showGrid: patch.showGrid ?? s.showGrid,
          showGuides: patch.showGuides ?? s.showGuides,
          snapEnabled: patch.snapEnabled ?? s.snapEnabled,
          ghost: patch.ghost
            ? {
                ...s.ghost,
                ...patch.ghost,
                // Older v1 projects have no mode field. Preserve the original
                // built-in reference behavior for those files.
                mode: patch.ghost.mode === "family" ? "family" : patch.ghost.mode === "image" ? "image" : "sample",
              }
            : s.ghost,
          // Older saved projects may still carry the pre-"single Size"
          // minSize/maxSize shape — normalize on load so the rest of the
          // app only ever sees the current BrushSettings shape.
          brush: patch.brush ? (normalizeBrushSettings(patch.brush) as BrushSettings) : s.brush,
          selectedObjectIds: [],
          selectedNodes: [],
          selectedHandle: null,
          drawingContourId: null,
          liveOutline: null,
          clipboard: null,
          clipboardSourceChar: null,
          glyphMetricFocus: null,
          past: [],
          future: [],
        };
      }),

    setKerningPair: (left, right, value) => {
      const { kerningPairs, kerningManual } = get();
      const key = kerningKey(left, right);
      commitKerning({ ...kerningPairs, [key]: Math.round(value) }, { ...kerningManual, [key]: true });
    },

    applyKerningSuggestion: (left, right) => {
      const { glyphs, metrics, kerningPairs, kerningManual } = get();
      const key = kerningKey(left, right);
      const suggestion = suggestKerningPair(glyphs, metrics, left, right);
      // Applying the computed suggestion is explicitly NOT a manual override,
      // so a later global auto-kerning pass is still free to refine it.
      commitKerning({ ...kerningPairs, [key]: suggestion }, { ...kerningManual, [key]: false });
    },

    resetKerningPair: (left, right) => {
      const { kerningPairs, kerningManual } = get();
      const key = kerningKey(left, right);
      const nextPairs = { ...kerningPairs };
      const nextManual = { ...kerningManual };
      delete nextPairs[key];
      delete nextManual[key];
      commitKerning(nextPairs, nextManual);
    },

    autoKernAllPairs: async (onProgress) => {
      const { glyphs, metrics, kerningPairs, kerningManual } = get();
      const result = await autoKernAllAvailablePairs(glyphs, metrics, kerningPairs, kerningManual, undefined, onProgress);
      commitKerning(result.pairs, result.manual);
      set({ autoKernLastRun: { processed: result.processed, updated: result.updated, preservedManual: result.preservedManual } });
    },

    autoSpaceAllGlyphs: async (options, onProgress) => {
      const excludeManuallyKerned = options?.excludeManuallyKerned ?? true;
      const reKernAfter = options?.reKernAfter ?? true;
      const { glyphs, metrics, kerningPairs, kerningManual } = get();

      // Glyphs that already have a hand-tuned kerning pair are left out of
      // the re-spacing pass by default: moving their LSB/RSB out from under
      // an existing manual kern value is exactly what causes the collisions
      // reported after running Auto Spacing on an already-kerned font.
      let excludeChars: Set<string> | undefined;
      if (excludeManuallyKerned) {
        excludeChars = new Set<string>();
        for (const [key, isManual] of Object.entries(kerningManual)) {
          if (!isManual) continue;
          const [left, right] = decodeKerningKey(key);
          excludeChars.add(left);
          excludeChars.add(right);
        }
      }

      const result = await computeAutoSpaceAllGlyphs(glyphs, metrics, applyGlyphMetricPatch, excludeChars, onProgress);
      if (result.updated > 0) commit(result.glyphs);
      set({ autoSpaceLastRun: { updated: result.updated, skipped: result.skipped, skippedManual: result.skippedManual } });

      // Re-run auto-kerning against the new spacing so non-manual pairs stay
      // consistent with it. Manual pairs are preserved untouched by
      // autoKernAllAvailablePairs itself (see kerningManual), so this never
      // overwrites kerning the user set by hand.
      if (reKernAfter && result.updated > 0) {
        const after = get();
        const kernResult = await autoKernAllAvailablePairs(
          after.glyphs,
          after.metrics,
          after.kerningPairs,
          after.kerningManual
        );
        commitKerning(kernResult.pairs, kernResult.manual);
        set({
          autoKernLastRun: {
            processed: kernResult.processed,
            updated: kernResult.updated,
            preservedManual: kernResult.preservedManual,
          },
        });
      }

      return result;
    },

    autoSpaceAllGlyphsForContext: async (context, options, onProgress) => {
      const excludeManuallyKerned = options?.excludeManuallyKerned ?? true;
      const reKernAfter = options?.reKernAfter ?? true;
      // "shared" has no glyph geometry of its own to space — it uses Regular
      // as the family baseline, the same convention autoKernAllPairsForContext
      // already uses for its "shared" case.
      const targetStyle = context === "shared" ? "regular" : context;
      const state = get();
      const styleGlyphs = state.glyphsByStyle[targetStyle] ?? {};

      // Effective manual-kerning exclude set for this style: the shared
      // layer plus this style's own override layer (a style override is
      // just as "manually tuned" as a shared manual pair, and either one
      // moving out from under a hand-set kern value causes the same
      // collisions Auto Spacing's exclude option exists to prevent).
      let excludeChars: Set<string> | undefined;
      if (excludeManuallyKerned) {
        excludeChars = new Set<string>();
        const collect = (manual: KerningManualFlags | undefined) => {
          if (!manual) return;
          for (const [key, isManual] of Object.entries(manual)) {
            if (!isManual) continue;
            const [left, right] = decodeKerningKey(key);
            excludeChars!.add(left);
            excludeChars!.add(right);
          }
        };
        collect(state.kerningManual);
        if (context !== "shared") collect(state.kerningOverrideManualByStyle[context]);
      }

      const result = await computeAutoSpaceAllGlyphs(styleGlyphs, state.metrics, applyGlyphMetricPatch, excludeChars, onProgress);
      if (result.updated > 0) commitStyleGlyphs(targetStyle, result.glyphs);
      set({ autoSpaceLastRun: { updated: result.updated, skipped: result.skipped, skippedManual: result.skippedManual } });

      // Re-run auto-kerning for this same context against the new spacing,
      // mirroring autoKernAllPairsForContext's own shared/override split.
      if (reKernAfter && result.updated > 0) {
        const after = get();
        const afterGlyphs = after.glyphsByStyle[targetStyle] ?? result.glyphs;
        if (context === "shared") {
          const kernResult = await autoKernAllAvailablePairs(afterGlyphs, after.metrics, after.kerningPairs, after.kerningManual);
          commitKerning(kernResult.pairs, kernResult.manual);
          set({
            autoKernLastRun: {
              processed: kernResult.processed,
              updated: kernResult.updated,
              preservedManual: kernResult.preservedManual,
            },
          });
        } else {
          const currentPairs = after.kerningOverridesByStyle[context] ?? {};
          const currentManual = after.kerningOverrideManualByStyle[context] ?? {};
          const kernResult = await autoKernAllAvailablePairs(afterGlyphs, after.metrics, currentPairs, currentManual, after.kerningPairs);
          commitFamilyStyleKerning(context, kernResult.pairs, kernResult.manual);
          set({
            autoKernLastRun: {
              processed: kernResult.processed,
              updated: kernResult.updated,
              preservedManual: kernResult.preservedManual,
            },
          });
        }
      }

      return result;
    },

    applyTrackingToAllGlyphs: (trackingUnits) => {
      const rounded = Math.round(Number.isFinite(trackingUnits) ? trackingUnits : 0);
      if (rounded === 0) {
        set({ trackingApplyLastRun: { units: 0, updated: 0 } });
        return { updated: 0 };
      }
      const { glyphs } = get();
      const half = rounded / 2;
      let next = glyphs;
      let updated = 0;
      for (const [char, glyph] of Object.entries(glyphs)) {
        if (!hasOutline(glyph)) continue;
        if (next === glyphs) next = { ...glyphs };
        next[char] = applyGlyphMetricPatch(glyph, { lsb: glyph.lsb + half, rsb: glyph.rsb + half });
        updated++;
      }
      if (updated > 0) commit(next);
      set({ trackingApplyLastRun: { units: rounded, updated } });
      return { updated };
    },

    beginKerningDrag: () => {
      if (kerningDragSnapshot) return;
      const { kerningPairs, kerningManual } = get();
      kerningDragSnapshot = { kerningPairs, kerningManual };
    },

    setKerningPairLive: (left, right, value) => {
      const { kerningPairs, kerningManual } = get();
      const key = kerningKey(left, right);
      set({
        kerningPairs: { ...kerningPairs, [key]: Math.round(value) },
        kerningManual: { ...kerningManual, [key]: true },
      });
    },

    endKerningDrag: () => {
      const snapshot = kerningDragSnapshot;
      kerningDragSnapshot = null;
      if (!snapshot) return;
      const { glyphs, past, kerningPairs, kerningManual } = get();
      if (snapshot.kerningPairs === kerningPairs && snapshot.kerningManual === kerningManual) return;
      set({
        past: [...past, { glyphs, metrics: get().metrics, kerningPairs: snapshot.kerningPairs, kerningManual: snapshot.kerningManual }].slice(-HISTORY_LIMIT),
        future: [],
      });
    },

    setFamilyKerningPair: (context, left, right, value) => {
      if (context === "shared") {
        get().setKerningPair(left, right, value);
        return;
      }
      const state = get();
      const key = kerningKey(left, right);
      const pairs = state.kerningOverridesByStyle[context] ?? {};
      const manual = state.kerningOverrideManualByStyle[context] ?? {};
      commitFamilyStyleKerning(
        context,
        { ...pairs, [key]: Math.round(value) },
        { ...manual, [key]: true }
      );
    },

    resetFamilyKerningPair: (context, left, right) => {
      if (context === "shared") {
        get().resetKerningPair(left, right);
        return;
      }
      const state = get();
      const key = kerningKey(left, right);
      const currentPairs = state.kerningOverridesByStyle[context] ?? {};
      const currentManual = state.kerningOverrideManualByStyle[context] ?? {};
      if (!(key in currentPairs) && !(key in currentManual)) return;
      const nextPairs = { ...currentPairs };
      const nextManual = { ...currentManual };
      delete nextPairs[key];
      delete nextManual[key];
      commitFamilyStyleKerning(context, nextPairs, nextManual);
    },

    autoKernAllPairsForContext: async (context, onProgress) => {
      if (context === "shared") {
        // Shared family auto-kern uses Regular as the family baseline while
        // keeping the exact existing auto-kern algorithm and manual rules.
        const state = get();
        const result = await autoKernAllAvailablePairs(
          state.glyphsByStyle.regular,
          state.metrics,
          state.kerningPairs,
          state.kerningManual,
          undefined,
          onProgress
        );
        commitKerning(result.pairs, result.manual);
        set({ autoKernLastRun: {
          processed: result.processed,
          updated: result.updated,
          preservedManual: result.preservedManual,
        } });
        return;
      }

      const state = get();
      const currentPairs = state.kerningOverridesByStyle[context] ?? {};
      const currentManual = state.kerningOverrideManualByStyle[context] ?? {};
      const result = await autoKernAllAvailablePairs(
        state.glyphsByStyle[context],
        state.metrics,
        currentPairs,
        currentManual,
        state.kerningPairs,
        onProgress
      );
      commitFamilyStyleKerning(context, result.pairs, result.manual);
      set({ autoKernLastRun: {
        processed: result.processed,
        updated: result.updated,
        preservedManual: result.preservedManual,
      } });
    },

    beginFamilyKerningDrag: (context) => {
      if (familyKerningDragSnapshot) return;
      const state = get();
      familyKerningDragSnapshot = {
        context,
        kerningPairs: state.kerningPairs,
        kerningManual: state.kerningManual,
        kerningOverridesByStyle: state.kerningOverridesByStyle,
        kerningOverrideManualByStyle: state.kerningOverrideManualByStyle,
      };
    },

    setFamilyKerningPairLive: (context, left, right, value) => {
      const key = kerningKey(left, right);
      const rounded = Math.round(value);
      if (context === "shared") {
        set((state) => ({
          kerningPairs: { ...state.kerningPairs, [key]: rounded },
          kerningManual: { ...state.kerningManual, [key]: true },
        }));
        return;
      }
      set((state) => ({
        kerningOverridesByStyle: {
          ...state.kerningOverridesByStyle,
          [context]: { ...(state.kerningOverridesByStyle[context] ?? {}), [key]: rounded },
        },
        kerningOverrideManualByStyle: {
          ...state.kerningOverrideManualByStyle,
          [context]: { ...(state.kerningOverrideManualByStyle[context] ?? {}), [key]: true },
        },
      }));
    },

    endFamilyKerningDrag: () => {
      const snapshot = familyKerningDragSnapshot;
      familyKerningDragSnapshot = null;
      if (!snapshot) return;
      const state = get();
      const sharedChanged =
        snapshot.kerningPairs !== state.kerningPairs ||
        snapshot.kerningManual !== state.kerningManual;
      const overrideChanged =
        snapshot.kerningOverridesByStyle !== state.kerningOverridesByStyle ||
        snapshot.kerningOverrideManualByStyle !== state.kerningOverrideManualByStyle;
      if (!sharedChanged && !overrideChanged) return;
      set({
        past: [...state.past, {
          glyphs: state.glyphs,
          metrics: state.metrics,
          kerningPairs: snapshot.kerningPairs,
          kerningManual: snapshot.kerningManual,
          kerningOverridesByStyle: snapshot.kerningOverridesByStyle,
          kerningOverrideManualByStyle: snapshot.kerningOverrideManualByStyle,
        }].slice(-HISTORY_LIMIT),
        future: [],
      });
    },

    openTestLab: (tab) => set((s) => ({ testLabOpen: true, familyOpen: false, traceOpen: false, featureBuilderOpen: false, testLabTab: tab ?? s.testLabTab })),
    closeTestLab: () => set({ testLabOpen: false }),
    setTestLabTab: (tab) => set({ testLabTab: tab }),
    // FREE users can open the Family panel to preview Bold/Italic/custom
    // family tabs and browse existing glyphs — only the actual generation
    // actions (switching to a non-Regular style, Auto Bold/Italic, Generate
    // Custom, adding a custom family) stay gated by requirePro("family")
    // below, exactly where they're invoked, so the panel itself is never
    // the thing that's locked.
    openFamily: () => {
      set({ familyOpen: true, testLabOpen: false, traceOpen: false, featureBuilderOpen: false });
    },
    closeFamily: () => set({ familyOpen: false }),

    openTrace: () => set({ traceOpen: true, testLabOpen: false, familyOpen: false, featureBuilderOpen: false }),
    closeTrace: () => set({ traceOpen: false }),

    openProModal: (feature) => set({ proModalOpen: true, proModalFeature: feature }),
    closeProModal: () => set({ proModalOpen: false }),

    openLoginModal: () => set({ loginModalOpen: true }),
    closeLoginModal: () => set({ loginModalOpen: false }),
    commitTracedGlyphOutline: (char, outline) => {
      const state = get();
      const regularGlyphs = state.glyphsByStyle.regular;
      const glyph = regularGlyphs[char];
      if (!glyph) return;
      const nextRegular: GlyphMap = { ...regularGlyphs, [char]: { ...glyph, outline } };
      const nextFamily: GlyphFamily = { ...state.glyphsByStyle, regular: nextRegular };
      set({
        glyphsByStyle: nextFamily,
        glyphs: state.fontStyle === "regular" ? nextRegular : state.glyphs,
        past: [
          ...state.past,
          {
            glyphs: state.glyphs,
            glyphsByStyle: state.glyphsByStyle,
            metrics: state.metrics,
            kerningPairs: state.kerningPairs,
            kerningManual: state.kerningManual,
            kerningOverridesByStyle: state.kerningOverridesByStyle,
            kerningOverrideManualByStyle: state.kerningOverrideManualByStyle,
          },
        ].slice(-HISTORY_LIMIT),
        future: [],
      });
    },

    openFeatureBuilder: () => set({ featureBuilderOpen: true, testLabOpen: false, familyOpen: false, traceOpen: false }),
    closeFeatureBuilder: () => set({ featureBuilderOpen: false }),

    createFeatureGlyph: (key, category, advanceWidthFrom) => {
      const trimmed = key.trim();
      if (!trimmed) return false;
      const state = get();
      const regularGlyphs = state.glyphsByStyle.regular;
      if (regularGlyphs[trimmed]) return false;
      const unicode = nextFeatureGlyphUnicode(state.glyphsByStyle);
      const sourceGlyph = advanceWidthFrom ? regularGlyphs[advanceWidthFrom] : undefined;
      const glyph = buildFeatureGlyph({
        key: trimmed,
        category,
        unicode,
        advanceWidth: sourceGlyph?.advanceWidth,
      });
      const nextRegular: GlyphMap = { ...regularGlyphs, [trimmed]: glyph };
      const nextFamily: GlyphFamily = { ...state.glyphsByStyle, regular: nextRegular };
      set({
        glyphsByStyle: nextFamily,
        glyphs: state.fontStyle === "regular" ? nextRegular : state.glyphs,
        past: [
          ...state.past,
          {
            glyphs: state.glyphs,
            glyphsByStyle: state.glyphsByStyle,
            metrics: state.metrics,
            kerningPairs: state.kerningPairs,
            kerningManual: state.kerningManual,
            kerningOverridesByStyle: state.kerningOverridesByStyle,
            kerningOverrideManualByStyle: state.kerningOverrideManualByStyle,
          },
        ].slice(-HISTORY_LIMIT),
        future: [],
      });
      return true;
    },

    /**
     * Keeps the Glyph list in sync with the Feature Builder: called after a
     * rule (or one option within a rule) is removed, so a ligature/alternate/
     * swash glyph that Feature Builder created for that rule disappears from
     * the Glyph list too instead of lingering as an orphan. Never touches a
     * glyph that (a) isn't one Feature Builder created (checked via its PUA
     * code point — see isFeatureGlyphUnicode) or (b) is still referenced by
     * another surviving rule (e.g. the same alternate glyph reused elsewhere).
     * Mirrors createFeatureGlyph's own history-push shape so this is a single
     * undoable step, and removes the glyph from every family style that has
     * it (Feature Builder glyphs only ever originate in Regular, but
     * "Generate From Regular" can copy them into Bold/Italic/custom styles).
     */
    deleteOrphanedFeatureGlyphs: (candidateKeys, nextConfig) => {
      const state = get();
      const stillReferenced = featureConfigReferencedKeys(nextConfig);
      const regularGlyphs = state.glyphsByStyle.regular;
      const toDelete = Array.from(new Set(candidateKeys)).filter(
        (key) => !stillReferenced.has(key) && isFeatureGlyphUnicode(regularGlyphs[key]?.unicode)
      );
      if (toDelete.length === 0) {
        set({ featureConfig: nextConfig });
        return;
      }
      const deleteSet = new Set(toDelete);
      const nextGlyphsByStyle: GlyphFamily = {};
      for (const [styleId, styleGlyphs] of Object.entries(state.glyphsByStyle)) {
        if (toDelete.some((key) => key in styleGlyphs)) {
          const next: GlyphMap = { ...styleGlyphs };
          for (const key of toDelete) delete next[key];
          nextGlyphsByStyle[styleId] = next;
        } else {
          nextGlyphsByStyle[styleId] = styleGlyphs;
        }
      }
      const nextGlyphs = nextGlyphsByStyle[state.fontStyle] ?? state.glyphs;
      const activeCharDeleted = deleteSet.has(state.activeChar);
      set({
        featureConfig: nextConfig,
        glyphsByStyle: nextGlyphsByStyle,
        glyphs: nextGlyphs,
        activeChar: activeCharDeleted ? Object.keys(nextGlyphs)[0] ?? state.activeChar : state.activeChar,
        selectedObjectIds: activeCharDeleted ? [] : state.selectedObjectIds,
        selectedNodes: activeCharDeleted ? [] : state.selectedNodes,
        selectedHandle: activeCharDeleted ? null : state.selectedHandle,
        drawingContourId: activeCharDeleted ? null : state.drawingContourId,
        liveOutline: activeCharDeleted ? null : state.liveOutline,
        past: [
          ...state.past,
          {
            glyphs: state.glyphs,
            glyphsByStyle: state.glyphsByStyle,
            metrics: state.metrics,
            kerningPairs: state.kerningPairs,
            kerningManual: state.kerningManual,
            kerningOverridesByStyle: state.kerningOverridesByStyle,
            kerningOverrideManualByStyle: state.kerningOverrideManualByStyle,
          },
        ].slice(-HISTORY_LIMIT),
        future: [],
      });
    },

    // OpenType Feature Builder: opening the overlay (openFeatureBuilder,
    // above) stays free for everyone so FREE users can look around — only
    // actually creating/editing a rule is PRO-gated, right at the point of
    // use, same pattern as the Family actions above. Removing an existing
    // rule is left ungated so a downgraded account can still clean up
    // rules it made while on PRO.
    addLigatureRule: (components, target) => {
      if (!requirePro("featureBuilder")) return;
      const cleanComponents = components.map((c) => c.trim()).filter(Boolean);
      const cleanTarget = target.trim();
      if (cleanComponents.length < 2 || !cleanTarget) return;
      const state = get();
      const rule: LigatureRule = { id: nextFeatureRuleId("liga"), components: cleanComponents, target: cleanTarget };
      set({ featureConfig: { ...state.featureConfig, ligatures: [...state.featureConfig.ligatures, rule] } });
    },
    removeLigatureRule: (id) => {
      const state = get();
      const rule = state.featureConfig.ligatures.find((r) => r.id === id);
      const nextConfig: FeatureBuilderConfig = {
        ...state.featureConfig,
        ligatures: state.featureConfig.ligatures.filter((r) => r.id !== id),
      };
      get().deleteOrphanedFeatureGlyphs(rule ? [rule.target] : [], nextConfig);
    },

    addAlternateOption: (base, alternate) => {
      if (!requirePro("featureBuilder")) return;
      const cleanBase = base.trim();
      const cleanAlt = alternate.trim();
      if (!cleanBase || !cleanAlt) return;
      const state = get();
      const existing = state.featureConfig.alternates.find((r) => r.base === cleanBase);
      let alternates: AlternateRule[];
      if (existing) {
        if (existing.alternates.includes(cleanAlt)) return;
        alternates = state.featureConfig.alternates.map((r) =>
          r.id === existing.id ? { ...r, alternates: [...r.alternates, cleanAlt] } : r
        );
      } else {
        const rule: AlternateRule = { id: nextFeatureRuleId("salt"), base: cleanBase, alternates: [cleanAlt] };
        alternates = [...state.featureConfig.alternates, rule];
      }
      set({ featureConfig: { ...state.featureConfig, alternates } });
    },
    removeAlternateOption: (id, alternate) => {
      const state = get();
      const rule = state.featureConfig.alternates.find((r) => r.id === id);
      if (!rule) return;
      const remaining = rule.alternates.filter((a) => a !== alternate);
      const alternates = remaining.length
        ? state.featureConfig.alternates.map((r) => (r.id === id ? { ...r, alternates: remaining } : r))
        : state.featureConfig.alternates.filter((r) => r.id !== id);
      const nextConfig: FeatureBuilderConfig = { ...state.featureConfig, alternates };
      get().deleteOrphanedFeatureGlyphs([alternate], nextConfig);
    },
    removeAlternateRule: (id) => {
      const state = get();
      const rule = state.featureConfig.alternates.find((r) => r.id === id);
      const nextConfig: FeatureBuilderConfig = {
        ...state.featureConfig,
        alternates: state.featureConfig.alternates.filter((r) => r.id !== id),
      };
      get().deleteOrphanedFeatureGlyphs(rule ? rule.alternates : [], nextConfig);
    },

    setSwashRule: (base, swash) => {
      if (!requirePro("featureBuilder")) return;
      const cleanBase = base.trim();
      const cleanSwash = swash.trim();
      if (!cleanBase || !cleanSwash) return;
      const state = get();
      const existing = state.featureConfig.swashes.find((r) => r.base === cleanBase);
      const swashes: SwashRule[] = existing
        ? state.featureConfig.swashes.map((r) => (r.id === existing.id ? { ...r, swash: cleanSwash } : r))
        : [...state.featureConfig.swashes, { id: nextFeatureRuleId("swsh"), base: cleanBase, swash: cleanSwash }];
      set({ featureConfig: { ...state.featureConfig, swashes } });
    },
    removeSwashRule: (id) => {
      const state = get();
      const rule = state.featureConfig.swashes.find((r) => r.id === id);
      const nextConfig: FeatureBuilderConfig = {
        ...state.featureConfig,
        swashes: state.featureConfig.swashes.filter((r) => r.id !== id),
      };
      get().deleteOrphanedFeatureGlyphs(rule ? [rule.swash] : [], nextConfig);
    },
  };
});

