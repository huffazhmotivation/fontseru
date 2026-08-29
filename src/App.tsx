import { lazy, Suspense, useEffect, useRef } from "react";
import { useAppStore } from "@/glyph/store";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { loadProject, saveProject } from "@/glyph/persist";
import { TopBar } from "@/components/TopBar";
import { FloatingToolbar } from "@/components/FloatingToolbar";
import { SketchModeToggle } from "@/components/SketchModeToggle";
import { SketchToolbar } from "@/components/SketchToolbar";
import { SketchRightPanelToggle } from "@/components/SketchRightPanelToggle";
import { GlyphStepper } from "@/components/GlyphStepper";
import { GlyphSideNav } from "@/components/GlyphSideNav";
import { GlyphNav } from "@/components/GlyphNav";
import { RightPanel } from "@/components/RightPanel";
import { BottomBar } from "@/components/BottomBar";
import { GlyphCanvas } from "@/editor/GlyphCanvas";
import { LoginModal } from "@/components/LoginModal";
import { EmailConfirmedWelcome } from "@/components/EmailConfirmedWelcome";
import { ProUpsellModal } from "@/components/ProUpsellModal";
import { ProductTour } from "@/components/ProductTour/ProductTour";

// These three overlays are heavy (Test Lab pulls in the whole specimen
// renderer, Trace Image pulls in imagetracerjs, Family Auto-Generate pulls
// in the bold/italic synthesis engine) but are only used occasionally.
// Loading them lazily means their code is not downloaded/parsed/executed
// until the user actually opens that feature, instead of on every app
// load — this is one of the biggest wins for initial load speed.
const TestLabOverlay = lazy(() =>
  import("@/components/TestLab/TestLabOverlay").then((m) => ({ default: m.TestLabOverlay }))
);
const FamilyAutoGenerateOverlay = lazy(() =>
  import("@/components/FamilyAutoGenerateOverlay").then((m) => ({ default: m.FamilyAutoGenerateOverlay }))
);
const TraceImageOverlay = lazy(() =>
  import("@/components/TraceImage/TraceImageOverlay").then((m) => ({ default: m.TraceImageOverlay }))
);
const FeatureBuilderOverlay = lazy(() =>
  import("@/components/FeatureBuilder/FeatureBuilderOverlay").then((m) => ({ default: m.FeatureBuilderOverlay }))
);

export default function App() {
  const theme = useAppStore((s) => s.theme);
  const sketchMode = useAppStore((s) => s.sketchMode);
  const sketchRightPanelOpen = useAppStore((s) => s.sketchRightPanelOpen);
  const testLabOpen = useAppStore((s) => s.testLabOpen);
  const familyOpen = useAppStore((s) => s.familyOpen);
  const traceOpen = useAppStore((s) => s.traceOpen);
  const featureBuilderOpen = useAppStore((s) => s.featureBuilderOpen);
  useKeyboardShortcuts();

  // Once a heavy overlay has been opened for the first time, keep mounting
  // it forever afterwards (its own internal `if (!open) return null` hides
  // it) so in-progress state like typed preview text or trace settings
  // survives closing/reopening, exactly like before this change — the only
  // difference is its code is not fetched until the first open.
  const testLabEverOpened = useRef(false);
  const familyEverOpened = useRef(false);
  const traceEverOpened = useRef(false);
  const featureBuilderEverOpened = useRef(false);
  if (testLabOpen) testLabEverOpened.current = true;
  if (familyOpen) familyEverOpened.current = true;
  if (traceOpen) traceEverOpened.current = true;
  if (featureBuilderOpen) featureBuilderEverOpened.current = true;

  const hydratedRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore the saved project from IndexedDB on first mount.
  useEffect(() => {
    let cancelled = false;
    loadProject().then((snap) => {
      if (cancelled) return;
      if (snap?.glyphs) useAppStore.getState().hydrate({
        glyphs: snap.glyphs,
        glyphsByStyle: snap.glyphsByStyle,
        fontStyle: snap.fontStyle,
        customFamilies: snap.customFamilies,
        fontName: snap.fontName,
        fontInfo: snap.fontInfo,
        metrics: snap.metrics,
        kerningPairs: snap.kerningPairs,
        kerningManual: snap.kerningManual,
        kerningOverridesByStyle: snap.kerningOverridesByStyle,
        kerningOverrideManualByStyle: snap.kerningOverrideManualByStyle,
        featureConfig: snap.featureConfig,
      });
      hydratedRef.current = true;
    });
    return () => { cancelled = true; };
  }, []);

  // Persist glyphs + font name (debounced) whenever they change, and flush
  // immediately when the tab is hidden/closed so a quick reload can't lose work.
  useEffect(() => {
    const flush = () => {
      if (!hydratedRef.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const state = useAppStore.getState();
      saveProject({
        glyphs: state.glyphsByStyle.regular,
        glyphsByStyle: state.glyphsByStyle,
        fontStyle: state.fontStyle,
        customFamilies: state.customFamilies,
        fontName: state.fontName,
        fontInfo: state.fontInfo,
        metrics: state.metrics,
        kerningPairs: state.kerningPairs,
        kerningManual: state.kerningManual,
        kerningOverridesByStyle: state.kerningOverridesByStyle,
        kerningOverrideManualByStyle: state.kerningOverrideManualByStyle,
        featureConfig: state.featureConfig,
      });
    };
    const unsub = useAppStore.subscribe(() => {
      if (!hydratedRef.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, 350);
    });
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      unsub();
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <div
      className="fm-root"
      data-theme={theme}
      data-sketch-mode={sketchMode ? "true" : "false"}
      data-sketch-panel-open={sketchRightPanelOpen ? "true" : "false"}
    >
      <TopBar />
      <div className="fm-body">
        <GlyphNav />
        <div className="fm-canvas-wrap">
          <div className="fm-canvas-area">
            <GlyphCanvas />
            <FloatingToolbar />
            <SketchModeToggle />
            {sketchMode && <SketchToolbar />}
            {sketchMode && <GlyphStepper />}
            {sketchMode && <SketchRightPanelToggle />}
            {!sketchMode && <GlyphSideNav />}
          </div>
          <BottomBar />
        </div>
        <RightPanel />
      </div>
      <Suspense fallback={null}>
        {testLabEverOpened.current && <TestLabOverlay />}
        {familyEverOpened.current && <FamilyAutoGenerateOverlay />}
        {traceEverOpened.current && <TraceImageOverlay />}
        {featureBuilderEverOpened.current && <FeatureBuilderOverlay />}
      </Suspense>
      <LoginModal />
      <ProductTour />
      <EmailConfirmedWelcome />
      <ProUpsellModal />
    </div>
  );
}
