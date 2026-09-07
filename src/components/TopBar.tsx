import React from "react";
import {
  Download, FlaskConical, Layers, Maximize, Minimize, Redo2, Undo2, Wand2,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  Copy, Trash2, Film, MoreHorizontal, Info,
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
  const commitFontNameEdit = useAppStore((s) => s.commitFontNameEdit);
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

  // --- "More" overflow menu (tablet/phone widths, see .fm-topbar-more-hide
  // in app.css) ---------------------------------------------------------
  // Below 1180px the align/boolean/object-action groups and the secondary
  // nav buttons (Timelapse/Family/Feature Builder/Test Lab/About) are
  // hidden from the bar itself and re-rendered here instead, so the bar
  // stays a single row that always fits the screen width with no
  // horizontal scrolling and no wrapping to extra rows. Same fixed-position
  // dropdown approach as FileMenu/AuthWidget (see the note there) so it
  // can never be clipped by anything.
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [morePos, setMorePos] = React.useState<{ top: number; left: number } | null>(null);
  const moreWrapRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!moreOpen) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setMoreOpen(false); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  React.useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [moreOpen]);

  const openMore = React.useCallback(() => {
    const rect = moreWrapRef.current?.getBoundingClientRect();
    const menuWidth = 240;
    const left = rect
      ? Math.max(10, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 10))
      : 14;
    const top = rect ? rect.bottom + 8 : 60;
    setMorePos({ top, left });
    setMoreOpen(true);
  }, []);

  return (
    <div className="fm-topbar">
      {/* The glyph-list / inspector-panel drawer shortcuts used to live here
          inline (see git history) but are now floating buttons over the
          canvas instead — see MobileDrawerToggles, rendered in App.tsx —
          so each shortcut sits on the actual side of the screen it opens,
          and this bar stays pure identity + actions. */}
      <FontSeruLogo />
      <div className="fm-divider" />
      <FileMenu onExportButtonReady={handleExportReady} />
      {/* Hidden below 1180px on phones and re-rendered inside the "More"
          dropdown instead (see fm-topbar-more-hide in app.css); on tablets
          it's shown inline instead, icon-only. Given a leading icon here
          (unlike the plain-label version this used to be) so it doesn't
          collapse to an empty, icon-less button once the icon-only sizing
          kicks in — it has no other icon of its own like the other
          fm-topbtn buttons. */}
      <div className="fm-topbar-more-hide">
        <AboutModal triggerIcon={<Info size={15} />} />
      </div>
      <input
        className="fm-fontname"
        value={fontName}
        onChange={(event) => setFontName(event.target.value)}
        onBlur={commitFontNameEdit}
        onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
        spellCheck={false}
        data-testid="font-name-input"
      />
      {/* Everything below is wrapped as one unit (see .fm-topbar-row2 in
          app.css) so it can be laid out independently of row one (logo/
          file/font name) on narrow phone widths, where it wraps onto its
          own centered row — a tidy "identity" row on top, a tidy "actions"
          row below, instead of the two rows fighting over the same
          left/right-pinned spacing. Above the phone breakpoint this wrapper
          is invisible (`display: contents`) and changes nothing. */}
      <div className="fm-topbar-row2">
      <div className="fm-topbtn-group">
        <button className="fm-topbtn" disabled={past.length === 0 && !liveOutline} onClick={undo} title="Undo (Cmd/Ctrl+Z)" data-testid="undo-btn">
          <Undo2 size={15} /> Undo
        </button>
        <button className="fm-topbtn" disabled={future.length === 0} onClick={redo} title="Redo (Cmd/Ctrl+Shift+Z)" data-testid="redo-btn">
          <Redo2 size={15} /> Redo
        </button>
      </div>

      {/* Align / boolean / object-action groups below are hidden below
          1180px (see .fm-topbar-more-hide in app.css) and re-rendered
          inside the "More" dropdown near the end of this bar instead —
          that's what lets tablet/phone widths show a single row that
          fits the screen with no horizontal scrolling and no wrapping. */}
      <div className="fm-align-divider fm-topbar-more-hide" />

      <div className="fm-align-group fm-topbar-more-hide" role="group" aria-label="Align selected objects">
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

      <div className="fm-align-divider fm-topbar-more-hide" />

      <div className="fm-align-group fm-topbar-more-hide" role="group" aria-label="Boolean shape actions">
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

      <div className="fm-align-divider fm-topbar-more-hide" />

      <div className="fm-align-group fm-topbar-more-hide" role="group" aria-label="Object actions">
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
        className="fm-topbtn fm-testlab-nav fm-topbar-more-hide"
        onClick={openTimelapse}
        title="Open Timelapse Recording"
        data-testid="timelapse-btn"
      >
        <Film size={15} /> Timelapse
      </button>
      <button
        className="fm-topbtn fm-testlab-nav fm-topbar-more-hide fm-topbar-phone-show"
        onClick={openFamily}
        title="Open Family Auto Generate"
        data-testid="family-btn"
      >
        <Layers size={15} /> Family
      </button>
      <button
        className="fm-topbtn fm-testlab-nav fm-topbar-more-hide fm-topbar-phone-show"
        onClick={openFeatureBuilder}
        title="Open OpenType Feature Builder"
        data-testid="feature-builder-btn"
      >
        <Wand2 size={15} /> Feature Builder
      </button>
      <button className="fm-topbtn fm-testlab-nav fm-topbar-more-hide fm-topbar-phone-show" onClick={() => openTestLab("specimen")} title="Open Test Lab" data-testid="test-lab-btn">
        <FlaskConical size={15} /> Test Lab
      </button>

      {/* "More" overflow menu: only visible below 1180px (see
          .fm-topbar-more-btn in app.css). Holds the align/boolean/object
          groups and the secondary nav buttons hidden above, as full-width
          labeled rows instead of bare icons since there's no width
          pressure inside a dropdown. */}
      <div className="fm-topbar-more-btn fm-filemenu-wrap" ref={moreWrapRef}>
        <button
          type="button"
          className="fm-topbtn"
          onClick={() => (moreOpen ? setMoreOpen(false) : openMore())}
          aria-expanded={moreOpen}
          title="More actions"
          aria-label="More actions"
          data-testid="topbar-more-btn"
        >
          <MoreHorizontal size={18} />
        </button>

        {moreOpen && (
          <>
            <div
              className="fm-filemenu-backdrop"
              onClick={() => setMoreOpen(false)}
              aria-hidden="true"
              data-testid="topbar-more-backdrop"
            />
            <div
              className="fm-filemenu fm-morebar-menu"
              role="menu"
              style={morePos ? { top: morePos.top, left: morePos.left } : undefined}
            >
              <div className="fm-morebar-section-label">Align</div>
              <div className="fm-morebar-grid">
                {ALIGN_BUTTONS.map(({ mode, label, icon: Icon }) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={selectedObjectIds.length < 2}
                    onClick={() => { alignSelectedObjects(mode); setMoreOpen(false); }}
                    title={label}
                    aria-label={label}
                  >
                    <Icon size={15} strokeWidth={1.7} />
                  </button>
                ))}
              </div>

              <div className="fm-filemenu-sep" />
              <div className="fm-morebar-section-label">Combine</div>
              <div className="fm-morebar-grid">
                {BOOLEAN_BUTTONS.map(({ op, label }) => (
                  <button
                    key={op}
                    type="button"
                    disabled={booleanEligibleCount < 2}
                    onClick={() => { booleanSelectedObjects(op); setMoreOpen(false); }}
                    title={label}
                    aria-label={label}
                  >
                    <BooleanOpIcon op={op} size={15} />
                  </button>
                ))}
              </div>

              <div className="fm-filemenu-sep" />
              <button
                disabled={selectedObjectIds.length === 0}
                onClick={() => { copySelection(); pasteClipboard(); setMoreOpen(false); }}
              >
                <Copy size={14} strokeWidth={1.7} /> Duplicate
              </button>
              <button
                disabled={selectedObjectIds.length === 0}
                onClick={() => { flipSelectedObjects("horizontal"); setMoreOpen(false); }}
              >
                <FlipIcon direction="horizontal" size={14} /> Flip Horizontal
              </button>
              <button
                disabled={selectedObjectIds.length === 0}
                onClick={() => { flipSelectedObjects("vertical"); setMoreOpen(false); }}
              >
                <FlipIcon direction="vertical" size={14} /> Flip Vertical
              </button>
              <button
                className="fm-filemenu-danger"
                disabled={selectedObjectIds.length === 0}
                onClick={() => { deleteSelectedObjects(); setMoreOpen(false); }}
              >
                <Trash2 size={14} strokeWidth={1.7} /> Delete
              </button>

              <div className="fm-filemenu-sep" />
              <button onClick={() => { openTimelapse(); setMoreOpen(false); }}>
                <Film size={14} /> Timelapse
              </button>
              <button onClick={() => { openFamily(); setMoreOpen(false); }}>
                <Layers size={14} /> Family
              </button>
              <button onClick={() => { openFeatureBuilder(); setMoreOpen(false); }}>
                <Wand2 size={14} /> Feature Builder
              </button>
              <button onClick={() => { openTestLab("specimen"); setMoreOpen(false); }}>
                <FlaskConical size={14} /> Test Lab
              </button>

              <div className="fm-filemenu-sep" />
              {/* Not wrapped with a menu-closing onClick: AboutModal's own
                  overlay (z-index 200) renders above this dropdown (z-index
                  80) regardless, and closing this menu first would unmount
                  AboutModal — and the "open" state it just set — before its
                  modal ever gets a chance to render. */}
              <AboutModal triggerClassName="" triggerIcon={<Info size={14} />} triggerLabel="About Us" />
            </div>
          </>
        )}
      </div>

      <button
        className="fm-topbtn fm-export-nav"
        onClick={() => exportRef.current?.()}
        title="Export font"
        data-testid="export-font-btn"
      >
        <Download size={15} /> Export
      </button>
      <button
        className="fm-theme-toggle fm-fullscreen-toggle"
        onClick={toggleFullscreen}
        title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
        data-testid="fullscreen-toggle"
      >
        {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
      </button>
      <button className="fm-theme-toggle fm-theme-toggle-bare" onClick={toggleTheme} title="Toggle theme" data-testid="theme-toggle">
        {theme === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
      </button>
      <AuthWidget />
      </div>
    </div>
  );
}
