import React from "react";
import {
  Download, FlaskConical, Layers, Maximize, Minimize, Redo2, Undo2, Wand2,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  Copy, Trash2, Film, Menu, PanelRight,
} from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { useTimelapseUiStore } from "@/timelapse/timelapseUiStore";
import type { AlignMode } from "@/editor/objectOps";
import { isBooleanEligible, type BooleanOp } from "@/editor/booleanOps";
import { BooleanOpIcon } from "@/components/icons/BooleanOpIcon";
import { FlipIcon } from "@/components/icons/FlipIcon";
import { SunIcon, MoonIcon } from "@/components/icons/ThemeIcon";
import { FileMenu } from "@/components/FileMenu";
import { FontSeruLogo } from "@/components/FontSeruLogo";
import { AuthWidget } from "@/components/AuthWidget";
import { AboutModal } from "@/components/AboutModal";

const ALIGN_BUTTONS: { mode: AlignMode; label: string; icon: typeof AlignStartVertical }[] = [
  { mode: "left", label: "Align Left", icon: AlignStartVertical },
  { mode: "hcenter", label: "Align Horizontal Center", icon: AlignCenterVertical },
  { mode: "right", label: "Align Right", icon: AlignEndVertical },
  { mode: "top", label: "Align Top", icon: AlignStartHorizontal },
  { mode: "vcenter", label: "Align Vertical Center", icon: AlignCenterHorizontal },
  { mode: "bottom", label: "Align Bottom", icon: AlignEndHorizontal },
];

const BOOLEAN_BUTTONS: { op: BooleanOp; label: string }[] = [
  { op: "union", label: "Add / Union" },
  { op: "subtract", label: "Subtract" },
  { op: "intersect", label: "Intersect" },
];

export function TopBar() {
  const exportRef = React.useRef<(() => void) | null>(null);
  const handleExportReady = React.useCallback((open: () => void) => {
    exportRef.current = open;
  }, []);

  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const fontName = useAppStore((s) => s.fontName);
  const setFontName = useAppStore((s) => s.setFontName);
  const past = useAppStore((s) => s.past);
  const future = useAppStore((s) => s.future);
  const liveOutline = useAppStore((s) => s.liveOutline);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const openTestLab = useAppStore((s) => s.openTestLab);
  const openFamily = useAppStore((s) => s.openFamily);
  const openFeatureBuilder = useAppStore((s) => s.openFeatureBuilder);
  const selectedObjectIds = useAppStore((s) => s.selectedObjectIds);
  const alignSelectedObjects = useAppStore((s) => s.alignSelectedObjects);
  const booleanSelectedObjects = useAppStore((s) => s.booleanSelectedObjects);
  const flipSelectedObjects = useAppStore((s) => s.flipSelectedObjects);
  const copySelection = useAppStore((s) => s.copySelection);
  const pasteClipboard = useAppStore((s) => s.pasteClipboard);
  const deleteSelectedObjects = useAppStore((s) => s.deleteSelectedObjects);
  const toggleMobileNav = useAppStore((s) => s.toggleMobileNav);
  const toggleMobilePanel = useAppStore((s) => s.toggleMobilePanel);
  const activeGlyphObjects = useAppStore((s) => s.glyphs[s.activeChar]?.outline.objects);
  const openTimelapse = useTimelapseUiStore((s) => s.openPanel);

  const booleanEligibleCount = (activeGlyphObjects ?? [])
    .filter((o) => selectedObjectIds.includes(o.id))
    .filter(isBooleanEligible).length;

  const [isFullscreen, setIsFullscreen] = React.useState(false);
  React.useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = React.useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  return (
    <div className="fm-topbar">
      {/* Only visible below the mobile breakpoint (see app.css): opens the
          glyph list as a drawer over the canvas instead of it permanently
          eating layout width, which is what was clipping the UI on
          iPad/phone widths. */}
      <button
        type="button"
        className="fm-mobile-nav-toggle"
        onClick={toggleMobileNav}
        title="Glyph list"
        aria-label="Toggle glyph list"
        data-testid="mobile-nav-toggle"
      >
        <Menu size={18} />
      </button>
      <FontSeruLogo />
      <div className="fm-divider" />
      <FileMenu onExportButtonReady={handleExportReady} />
      <AboutModal />
      <input
        className="fm-fontname"
        value={fontName}
        onChange={(event) => setFontName(event.target.value)}
        spellCheck={false}
        data-testid="font-name-input"
      />
      <div className="fm-topbtn-group">
        <button className="fm-topbtn" disabled={past.length === 0 && !liveOutline} onClick={undo} title="Undo (Cmd/Ctrl+Z)" data-testid="undo-btn">
          <Undo2 size={15} /> Undo
        </button>
        <button className="fm-topbtn" disabled={future.length === 0} onClick={redo} title="Redo (Cmd/Ctrl+Shift+Z)" data-testid="redo-btn">
          <Redo2 size={15} /> Redo
        </button>
      </div>

      <div className="fm-align-divider" />

      <div className="fm-align-group" role="group" aria-label="Align selected objects">
        {ALIGN_BUTTONS.map(({ mode, label, icon: Icon }, i) => (
          <React.Fragment key={mode}>
            {i === 3 && <div className="fm-align-divider" />}
            <button
              type="button"
              className="fm-align-btn"
              disabled={selectedObjectIds.length < 2}
              onClick={() => alignSelectedObjects(mode)}
              title={label}
              aria-label={label}
              data-testid={`align-${mode}`}
            >
              <Icon size={15} strokeWidth={1.7} />
            </button>
          </React.Fragment>
        ))}
      </div>

      <div className="fm-align-divider" />

      <div className="fm-align-group" role="group" aria-label="Boolean shape actions">
        {BOOLEAN_BUTTONS.map(({ op, label }) => (
          <button
            key={op}
            type="button"
            className="fm-align-btn"
            disabled={booleanEligibleCount < 2}
            onClick={() => booleanSelectedObjects(op)}
            title={label}
            aria-label={label}
            data-testid={`boolean-${op}-btn`}
          >
            <BooleanOpIcon op={op} size={15} />
          </button>
        ))}
      </div>

      <div className="fm-align-divider" />

      <div className="fm-align-group" role="group" aria-label="Object actions">
        <button
          type="button"
          className="fm-align-btn"
          disabled={selectedObjectIds.length === 0}
          onClick={() => { copySelection(); pasteClipboard(); }}
          title="Duplicate"
          aria-label="Duplicate"
          data-testid="duplicate-btn"
        >
          <Copy size={15} strokeWidth={1.7} />
        </button>
        <button
          type="button"
          className="fm-align-btn"
          disabled={selectedObjectIds.length === 0}
          onClick={() => flipSelectedObjects("horizontal")}
          title="Flip Horizontal"
          aria-label="Flip Horizontal"
          data-testid="flip-horizontal-btn"
        >
          <FlipIcon direction="horizontal" size={15} />
        </button>
        <button
          type="button"
          className="fm-align-btn"
          disabled={selectedObjectIds.length === 0}
          onClick={() => flipSelectedObjects("vertical")}
          title="Flip Vertical"
          aria-label="Flip Vertical"
          data-testid="flip-vertical-btn"
        >
          <FlipIcon direction="vertical" size={15} />
        </button>
        <div className="fm-align-divider" />
        <button
          type="button"
          className="fm-align-btn danger"
          disabled={selectedObjectIds.length === 0}
          onClick={deleteSelectedObjects}
          title="Delete"
          aria-label="Delete"
          data-testid="delete-object-btn"
        >
          <Trash2 size={15} strokeWidth={1.7} />
        </button>
      </div>

      <div className="fm-spacer" />

      {/* Opening the Family panel is free for everyone — only the actual
          Bold/Italic/custom generation actions inside it are PRO-gated
          (enforced in the store, right where each action happens), so this
          button no longer shows a locked state. */}
      <button
        className="fm-topbtn fm-testlab-nav"
        onClick={openTimelapse}
        title="Open Timelapse Recording"
        data-testid="timelapse-btn"
      >
        <Film size={15} /> Timelapse
      </button>
      <button
        className="fm-topbtn fm-testlab-nav"
        onClick={openFamily}
        title="Open Family Auto Generate"
        data-testid="family-btn"
      >
        <Layers size={15} /> Family
      </button>
      <button
        className="fm-topbtn fm-testlab-nav"
        onClick={openFeatureBuilder}
        title="Open OpenType Feature Builder"
        data-testid="feature-builder-btn"
      >
        <Wand2 size={15} /> Feature Builder
      </button>
      <button className="fm-topbtn fm-testlab-nav" onClick={() => openTestLab("specimen")} title="Open Test Lab" data-testid="test-lab-btn">
        <FlaskConical size={15} /> Test Lab
      </button>
      <button
        className="fm-topbtn fm-export-nav"
        onClick={() => exportRef.current?.()}
        title="Export font"
        data-testid="export-font-btn"
      >
        <Download size={15} /> Export
      </button>
      <button
        className="fm-theme-toggle"
        onClick={toggleFullscreen}
        title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
        data-testid="fullscreen-toggle"
      >
        {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
      </button>
      <button className="fm-theme-toggle fm-theme-toggle-bare" onClick={toggleTheme} title="Toggle theme" data-testid="theme-toggle">
        {theme === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
      </button>
      {/* Mobile-only counterpart to the nav toggle above, opening the right
          inspector drawer (glyph metrics/tools/brush settings, etc). */}
      <button
        type="button"
        className="fm-mobile-panel-toggle"
        onClick={toggleMobilePanel}
        title="Inspector panel"
        aria-label="Toggle inspector panel"
        data-testid="mobile-panel-toggle"
      >
        <PanelRight size={18} />
      </button>
      <AuthWidget />
    </div>
  );
}
