import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  MousePointer2,
  PenTool,
  Paintbrush,
  Spline,
  Hand,
  ZoomIn,
  Undo2,
  Redo2,
  Download,
  Sun,
  ChevronDown,
  PenLine,
  Highlighter,
  Feather,
  Pencil,
  Layers,
  FlaskConical,
  Wand2,
  Sparkles,
  Check,
  X,
} from "lucide-react";
import { FontSeruLogo } from "@/components/FontSeruLogo";

/**
 * All content in this file is 100% static/mock data used purely to *play
 * back* an animated walkthrough. It never reads from or writes to
 * `src/glyph/store.ts` (the real editor state), IndexedDB, or Supabase —
 * see ProductTour.tsx for the full isolation guarantees. `<FontSeruLogo />`
 * (used below) does a single read-only theme lookup so the mock UI matches
 * the visitor's current light/dark theme — nothing is written back.
 *
 * Every scene renders FontSeru's *real* CSS classes (fm-topbar,
 * fm-floating-toolbar, fm-rightpanel, fm-lab-modal, fm-feature-*, ...) with
 * static content, instead of a bespoke mockup — so the tour looks like an
 * actual screen recording of the app rather than a generic slideshow.
 */

// ---------------------------------------------------------------- MOTION --

export interface TourWaypoint {
  /** 0..1 progress (within the current scene) at which the cursor arrives
   * at this waypoint and its content (caption/highlight) becomes active. */
  t: number;
  cx: number;
  cy: number;
  /** Shown in the tour's fixed caption bar (not floated near the cursor —
   * a floating tooltip can end up covering the very thing it's pointing
   * at). */
  caption?: string;
  highlight?: { x: number; y: number; w: number; h: number };
  click?: boolean;
}

export interface TourMotionState {
  cx: number;
  cy: number;
  content: TourWaypoint;
  arrivedIdx: number;
  rippleAt: number;
}

const MOVE_WINDOW = 0.07;

/** Turns a scene's [0..1] progress into a live cursor position + the
 * "currently active" waypoint (for caption/highlight), gliding smoothly
 * between stops rather than snapping. Pure function of `progress`, so
 * replaying a scene (progress reset to 0) replays identically. */
export function useTourMotion(waypoints: TourWaypoint[], progress: number): TourMotionState {
  let arrivedIdx = 0;
  for (let i = 0; i < waypoints.length; i++) {
    if (waypoints[i].t <= progress) arrivedIdx = i;
    else break;
  }

  const [rippleAt, setRippleAt] = useState(0);
  useEffect(() => {
    if (waypoints[arrivedIdx]?.click) setRippleAt((v) => v + 1);
    // Only the arrival index should retrigger the ripple.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivedIdx]);

  const prev = waypoints[arrivedIdx];
  const next = waypoints[arrivedIdx + 1];

  let cx = prev.cx;
  let cy = prev.cy;
  let content: TourWaypoint = prev;

  if (next) {
    const moveStart = Math.max(prev.t, next.t - MOVE_WINDOW);
    if (progress >= moveStart) {
      const span = Math.max(0.0001, next.t - moveStart);
      const localP = Math.min(1, Math.max(0, (progress - moveStart) / span));
      cx = prev.cx + (next.cx - prev.cx) * localP;
      cy = prev.cy + (next.cy - prev.cy) * localP;
      content = next;
    }
  }

  return { cx, cy, content, arrivedIdx, rippleAt };
}

/** Reports the active waypoint's caption up to the tour's fixed caption
 * bar (see ProductTour.tsx) whenever it changes, so every scene's captions
 * render in one consistent place instead of floating over the UI. */
function useCaptionReporter(content: TourWaypoint, onCaption?: (text: string | null) => void) {
  useEffect(() => {
    onCaption?.(content.caption ?? null);
  }, [content, onCaption]);
}

/** Fake cursor + click ripple + spotlight highlight, absolutely positioned
 * inside a `position:relative` `.pt-stage` container. Shared by every
 * scene so movement/highlight all look and feel identical. The caption
 * text itself is NOT rendered here — it goes to the tour's fixed caption
 * bar instead, so it never overlaps the UI it's describing. */
export function TourCursorLayer({ motion }: { motion: TourMotionState }) {
  const { cx, cy, content, rippleAt } = motion;
  return (
    <>
      {content.highlight && (
        <div
          className="pt-highlight"
          style={{
            left: `${content.highlight.x}%`,
            top: `${content.highlight.y}%`,
            width: `${content.highlight.w}%`,
            height: `${content.highlight.h}%`,
          }}
        />
      )}
      {rippleAt > 0 && (
        <span key={rippleAt} className="pt-click-ripple" style={{ left: `${cx}%`, top: `${cy}%` }} />
      )}
      <div className="pt-cursor-wrap" style={{ left: `${cx}%`, top: `${cy}%` }}>
        <MousePointer2 className="pt-cursor-icon" size={22} strokeWidth={2.25} />
      </div>
    </>
  );
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// --------------------------------------------------------- ANCHOR SYSTEM --
//
// Instead of guessing cursor/highlight positions as hand-picked percentages
// (which drift out of sync the moment the real layout changes), every
// interactive target in a scene carries a `data-tour-anchor="name"`
// attribute. `useStageAnchors` measures those real DOM elements against the
// scene's own stage container and returns their rects in percent — so the
// fake cursor and spotlight always land exactly on the real button/panel,
// at any window size.

interface AnchorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function useStageAnchors(stageRef: RefObject<HTMLDivElement>): Record<string, AnchorRect> {
  const [rects, setRects] = useState<Record<string, AnchorRect>>({});

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const measure = () => {
      const stageRect = stage.getBoundingClientRect();
      if (stageRect.width === 0 || stageRect.height === 0) return;
      const nodes = stage.querySelectorAll<HTMLElement>("[data-tour-anchor]");
      const next: Record<string, AnchorRect> = {};
      nodes.forEach((el) => {
        const name = el.getAttribute("data-tour-anchor");
        if (!name) return;
        const r = el.getBoundingClientRect();
        next[name] = {
          x: ((r.left - stageRect.left) / stageRect.width) * 100,
          y: ((r.top - stageRect.top) / stageRect.height) * 100,
          w: (r.width / stageRect.width) * 100,
          h: (r.height / stageRect.height) * 100,
        };
      });
      setRects(next);
    };

    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(stage);
    window.addEventListener("resize", measure);
    // Re-measure shortly after mount too, in case webfonts/layout still
    // settle a frame or two after first paint.
    const t1 = window.setTimeout(measure, 60);
    const t2 = window.setTimeout(measure, 260);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [stageRef]);

  return rects;
}

export interface BaseWaypoint {
  t: number;
  /** `data-tour-anchor` value of the real element this waypoint targets. */
  anchor: string;
  /** Where inside the anchor's rect the cursor rests, as a 0..1 fraction of
   * its width/height. Defaults to the center — pass a custom offset to
   * point at a specific spot inside a larger area (e.g. a point on the
   * canvas rather than its center). */
  offset?: { x: number; y: number };
  /** Shown in the tour's fixed caption bar while this waypoint is active. */
  caption?: string;
  click?: boolean;
  /** Extra spotlight padding around the anchor's rect, in percent of the
   * stage. Defaults to 2.5. */
  padding?: number;
  /** Set to false to suppress the spotlight ring for this waypoint (still
   * moves the cursor + shows the caption). Defaults to true. */
  highlight?: boolean;
}

/** Resolves anchor-based waypoints into concrete cursor/highlight
 * percentages using measured DOM rects. Anchors not yet measured (e.g. the
 * very first paint) fall back to the stage center so nothing crashes or
 * jumps off-screen. */
function useResolvedWaypoints(base: BaseWaypoint[], rects: Record<string, AnchorRect>): TourWaypoint[] {
  return useMemo(
    () =>
      base.map((b) => {
        const r = rects[b.anchor] ?? { x: 48, y: 48, w: 4, h: 4 };
        const ox = b.offset?.x ?? 0.5;
        const oy = b.offset?.y ?? 0.5;
        const pad = b.padding ?? 2.5;
        const wp: TourWaypoint = {
          t: b.t,
          cx: r.x + r.w * ox,
          cy: r.y + r.h * oy,
          caption: b.caption,
          click: b.click,
        };
        if (b.highlight !== false) {
          wp.highlight = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
        }
        return wp;
      }),
    [base, rects]
  );
}

// ============================================================================
// SHARED APP CHROME — every scene renders this "app shell" (or, for the
// modal-based features, renders it dimmed behind an inline copy of the
// real fm-lab-modal chrome), reusing FontSeru's actual CSS classes.
// ============================================================================

function MockGlyphNav() {
  const sample = "AaBbCcDdEeFf".split("");
  return (
    <div className="pt-glyphnav-mini" aria-hidden="true">
      <div className="pt-glyphnav-mini-head">
        <span>Glyphs</span>
        <span className="pt-glyphnav-mini-count">128</span>
      </div>
      <div className="pt-glyphnav-mini-grid">
        {sample.map((c, i) => (
          <div key={`${c}-${i}`} className={`pt-glyphnav-mini-tile${i === 0 ? " is-active" : ""}`}>
            {c}
          </div>
        ))}
      </div>
    </div>
  );
}

function AppShellTopBar() {
  return (
    <div className="fm-topbar">
      <FontSeruLogo />
      <div className="fm-divider" />
      <div className="fm-fontname" aria-hidden="true">
        Untitled Font
      </div>
      <div className="fm-topbtn-group">
        <button className="fm-topbtn" tabIndex={-1} aria-hidden="true">
          <Undo2 size={15} /> Undo
        </button>
        <button className="fm-topbtn" tabIndex={-1} aria-hidden="true">
          <Redo2 size={15} /> Redo
        </button>
      </div>
      <div className="fm-spacer" />
      <button className="fm-topbtn fm-testlab-nav" data-tour-anchor="topbar-family" tabIndex={-1} aria-hidden="true">
        <Layers size={15} /> Family
      </button>
      <button className="fm-topbtn fm-testlab-nav" data-tour-anchor="topbar-feature" tabIndex={-1} aria-hidden="true">
        <Wand2 size={15} /> Feature Builder
      </button>
      <button className="fm-topbtn fm-testlab-nav" data-tour-anchor="topbar-testlab" tabIndex={-1} aria-hidden="true">
        <FlaskConical size={15} /> Test Lab
      </button>
      <button className="fm-topbtn fm-export-nav" tabIndex={-1} aria-hidden="true">
        <Download size={15} /> Export
      </button>
      <button className="fm-theme-toggle" tabIndex={-1} aria-hidden="true">
        <Sun size={16} />
      </button>
    </div>
  );
}

function FloatingToolbarMock({ activeTool }: { activeTool: "select" | "brush" }) {
  return (
    <div className="fm-floating-toolbar" aria-hidden="true">
      <div className="fm-tool-group">
        <button className="fm-tool" tabIndex={-1}>
          <span className="fm-home-tool-icon" />
        </button>
      </div>
      <div className="fm-tool-group">
        <button className={`fm-tool${activeTool === "select" ? " active" : ""}`} tabIndex={-1}>
          <MousePointer2 size={18} strokeWidth={1.7} />
        </button>
        <button className="fm-tool" tabIndex={-1}>
          <Spline size={18} strokeWidth={1.7} />
        </button>
        <button className="fm-tool" tabIndex={-1}>
          <PenTool size={18} strokeWidth={1.7} />
        </button>
        <button
          className={`fm-tool${activeTool === "brush" ? " active" : ""}`}
          tabIndex={-1}
          data-tour-anchor="tool-brush"
        >
          <Paintbrush size={18} strokeWidth={1.7} />
        </button>
      </div>
      <div className="fm-toolbar-divider" />
      <div className="fm-tool-group">
        <button className="fm-tool" tabIndex={-1}>
          <ZoomIn size={18} strokeWidth={1.7} />
        </button>
        <button className="fm-tool" tabIndex={-1}>
          <Hand size={18} strokeWidth={1.7} />
        </button>
      </div>
    </div>
  );
}

/** The persistent app frame every scene sits inside: topbar, glyph list,
 * canvas area (with the real floating toolbar) and a right-panel slot. */
function AppShell({
  activeTool,
  rightPanel,
  canvasChildren,
  dimmed,
}: {
  activeTool: "select" | "brush";
  rightPanel: ReactNode;
  canvasChildren?: ReactNode;
  dimmed?: boolean;
}) {
  return (
    <div className={`pt-app-shell${dimmed ? " pt-dimmed" : ""}`}>
      <AppShellTopBar />
      <div className="fm-body">
        <MockGlyphNav />
        <div className="fm-canvas-wrap">
          <div className="fm-canvas-area">
            <div className="fm-canvas-frame" data-tour-anchor="canvas">
              {canvasChildren}
            </div>
            <FloatingToolbarMock activeTool={activeTool} />
          </div>
        </div>
        <div className="fm-rightpanel">{rightPanel}</div>
      </div>
    </div>
  );
}

/** Idle right-panel content shown behind modal-based scenes (Family / Test
 * Lab / Feature Builder), matching the real Select-tool panel's header. */
function IdleRightPanel({ char }: { char: string }) {
  const code = char.codePointAt(0);
  return (
    <div className="fm-panel-header">
      <div className="fm-panel-glyph pt-mock-glyph">{char}</div>
      <div className="fm-panel-meta">
        <div className="fm-panel-char">{char}</div>
        <div className="fm-panel-code">U+{code ? code.toString(16).toUpperCase().padStart(4, "0") : "0000"}</div>
        <div className="fm-panel-cat">Lowercase</div>
      </div>
    </div>
  );
}

/** Inline replica of FontSeru's real `.fm-lab-backdrop` / `.fm-lab-modal`
 * chrome (used by Test Lab, Family and Feature Builder), scoped to sit
 * inside the tour's own stage rather than covering the whole viewport. */
function InlineLabModal({
  extraModalClass,
  icon,
  title,
  children,
}: {
  extraModalClass?: string;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="fm-lab-backdrop pt-inline-modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`fm-lab-modal pt-inline-modal${extraModalClass ? ` ${extraModalClass}` : ""}`}>
        <div className="fm-lab-head">
          <div className="fm-lab-title">
            {icon}
            <span>{title}</span>
          </div>
          <div className="fm-spacer" />
          <button className="fm-theme-toggle" tabIndex={-1} aria-hidden="true">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export interface SceneProps {
  progress: number;
  onCaption?: (text: string | null) => void;
}


const BRUSH_BASE: BaseWaypoint[] = [
  { t: 0, anchor: "tool-brush", caption: "Brush tool — draw with pressure & taper" },
  { t: 0.1, anchor: "tool-brush", click: true, caption: "Brush tool — draw with pressure & taper" },
  {
    t: 0.24,
    anchor: "canvas",
    offset: { x: 0.68, y: 0.28 },
    highlight: false,
    caption: "Draw straight onto the glyph canvas",
  },
  {
    t: 0.44,
    anchor: "canvas",
    offset: { x: 0.34, y: 0.8 },
    highlight: false,
    caption: "FontSeru builds a clean vector outline as you draw",
  },
  { t: 0.64, anchor: "width-profile", click: true, caption: "Width Profile — shape the taper" },
  { t: 0.86, anchor: "width-profile", caption: "Natural, hand-lettered taper — instantly" },
  { t: 1, anchor: "canvas" },
];

const BRUSH_PRESET_CARDS: { label: string; Icon: typeof PenLine; active?: boolean }[] = [
  { label: "Round", Icon: PenLine, active: true },
  { label: "Marker", Icon: Highlighter },
  { label: "Calligraphic", Icon: Feather },
  { label: "Pencil", Icon: Pencil },
];

// Hand-authored flowing "S" stroke used to sell "drawing a glyph". Uses
// pathLength=1000 so the dash-offset math below is independent of the
// path's real geometry.
const BRUSH_PATH_D = "M158,58 C126,32 72,36 62,66 C52,96 96,104 124,116 C158,131 182,146 168,178 C154,209 98,208 70,184";

function BrushRightPanel({ taperP, sizeP }: { taperP: number; sizeP: number }) {
  const size = Math.round(18 + sizeP * 10);
  const startWidth = Math.round(4 + taperP * 14);
  const endWidth = Math.round(18 - taperP * 14);

  return (
    <>
      <IdleRightPanel char="s" />
      <div className="fm-section open">
        <div className="fm-section-head" aria-hidden="true">
          <span className="fm-section-title">Brush Preset</span>
          <ChevronDown size={14} className="fm-section-caret" />
        </div>
        <div className="fm-section-body">
          <div className="fm-brush-grid">
            {BRUSH_PRESET_CARDS.map(({ label, Icon, active }) => (
              <div key={label} className={`fm-brush-card${active ? " active" : ""}`}>
                <span className="fm-brush-icon">
                  <Icon size={17} strokeWidth={1.8} />
                </span>
                <span className="fm-brush-name">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="fm-section open">
        <div className="fm-section-head" aria-hidden="true">
          <span className="fm-section-title">Stroke Settings</span>
          <ChevronDown size={14} className="fm-section-caret" />
        </div>
        <div className="fm-section-body">
          <div className="fm-field">
            <div className="fm-slider-row-label">
              <span className="fm-slider-label-group">
                <label>Size</label>
              </span>
              <span>{size}</span>
            </div>
            <input type="range" min={1} max={200} value={size} readOnly tabIndex={-1} style={{ pointerEvents: "none" }} />
          </div>
          <div className="fm-field" data-tour-anchor="width-profile">
            <label>Width Profile</label>
            <div className="fm-width-profile-grid">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className={`fm-width-profile-btn${i === 3 ? " active" : ""}`} aria-hidden="true">
                  <svg viewBox="0 0 40 16" width={26} height={11}>
                    <polygon points="0,8 20,3 40,8 20,13" fill="currentColor" />
                  </svg>
                </div>
              ))}
            </div>
            <div className="pt-taper-readout">
              <span>
                Start <b>{startWidth}</b>
              </span>
              <span>
                End <b>{endWidth}</b>
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export function BrushScene({ progress, onCaption }: SceneProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const rects = useStageAnchors(stageRef);
  const waypoints = useResolvedWaypoints(BRUSH_BASE, rects);
  const motion = useTourMotion(waypoints, progress);
  useCaptionReporter(motion.content, onCaption);

  const drawP = clamp01((progress - 0.16) / (0.44 - 0.16));
  const convertP = clamp01((progress - 0.46) / (0.54 - 0.46));
  const taperP = clamp01((progress - 0.64) / (0.98 - 0.64));

  return (
    <div className="pt-stage" ref={stageRef}>
      <AppShell
        activeTool="brush"
        rightPanel={<BrushRightPanel taperP={taperP} sizeP={taperP} />}
        canvasChildren={
          <>
            <div className="pt-canvas-guides">
              <div className="pt-guide-line" style={{ top: "20%" }} />
              <div className="pt-guide-line pt-guide-baseline" style={{ top: "82%" }} />
            </div>
            <svg className="pt-brush-svg" viewBox="0 0 220 220" preserveAspectRatio="xMidYMid meet">
              <path
                className="pt-brush-stroke"
                d={BRUSH_PATH_D}
                pathLength={1000}
                style={{ strokeDasharray: 1000, strokeDashoffset: 1000 * (1 - drawP), opacity: 1 - convertP }}
              />
              <path
                className="pt-brush-fill"
                d={BRUSH_PATH_D}
                style={{
                  opacity: convertP,
                  strokeWidth: 6 + taperP * 6,
                  transform: `scaleY(${1 + Math.sin(taperP * Math.PI) * 0.05})`,
                  transformOrigin: "110px 110px",
                }}
              />
            </svg>
            {convertP > 0.05 && (
              <div className="pt-outline-badge" style={{ opacity: convertP }}>
                <Check size={12} /> Outline ready
              </div>
            )}
          </>
        }
      />
      <TourCursorLayer motion={motion} />
    </div>
  );
}

// ----------------------------------------------------------- 2. FAMILY ---

const FAMILY_BASE: BaseWaypoint[] = [
  { t: 0, anchor: "family-row-regular", caption: "One Regular master — the whole family" },
  {
    t: 0.22,
    anchor: "family-generate-btn",
    click: true,
    caption: "Generate Bold, Italic & custom styles",
  },
  { t: 0.5, anchor: "family-row-bold", caption: "Bold — weight synthesized automatically" },
  { t: 0.76, anchor: "family-row-italic", caption: "Italic — slant adjusted to match" },
  { t: 1, anchor: "family-generate-btn", highlight: false },
];

interface FamilyRowDef {
  key: string;
  label: string;
  weight: number;
  italic: boolean;
  revealFrom: number;
  anchor: string;
}
const FAMILY_ROWS: FamilyRowDef[] = [
  { key: "regular", label: "Regular", weight: 400, italic: false, revealFrom: 0, anchor: "family-row-regular" },
  { key: "bold", label: "Bold", weight: 800, italic: false, revealFrom: 0.3, anchor: "family-row-bold" },
  { key: "italic", label: "Italic", weight: 400, italic: true, revealFrom: 0.54, anchor: "family-row-italic" },
];
const FAMILY_ROW_GLYPHS = "ABCDEFGH".split("");

function FamilyModalBody({ progress }: { progress: number }) {
  return (
    <div className="fm-lab-body fm-family-auto-body">
      <div className="fm-family-auto-previews" data-testid="pt-family-previews">
        {FAMILY_ROWS.map((row) => {
          const localP = clamp01((progress - row.revealFrom) / 0.18);
          const done = row.key !== "regular" && localP >= 1;
          return (
            <div className="fm-family-auto-row" key={row.key} data-tour-anchor={row.anchor}>
              <div className="fm-family-auto-row-head">
                <div>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <strong>{row.label}</strong>
                    {done && (
                      <span className="pt-generated-badge">
                        <Check size={10} /> Generated
                      </span>
                    )}
                  </span>
                </div>
              </div>
              <div className="fm-family-auto-strip">
                {FAMILY_ROW_GLYPHS.map((g) => (
                  <div key={g} className="fm-family-auto-glyph has-vector">
                    <span className="fm-family-auto-char">{g}</span>
                    <div
                      className="fm-family-auto-thumb"
                      style={{
                        fontWeight: row.key === "regular" ? 400 : 400 + localP * (row.weight - 400),
                        fontStyle: row.italic ? (localP > 0.15 ? "italic" : "normal") : "normal",
                        opacity: row.key === "regular" ? 1 : 0.4 + localP * 0.6,
                        fontSize: 26,
                        fontFamily: "var(--sans)",
                      }}
                    >
                      {g}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="fm-family-generate">
        <div className="fm-family-generate-head">
          <Wand2 size={15} />
          <div>
            <strong>Auto-Generate Styles</strong>
            <span>One click from your Regular master</span>
          </div>
        </div>
        <div className="fm-family-generate-tabs" role="tablist" aria-hidden="true">
          {["Bold", "Italic", "Family"].map((t, i) => (
            <button key={t} type="button" className={i === 0 ? "active" : ""} tabIndex={-1}>
              {t}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="fm-action-btn accent"
          data-tour-anchor="family-generate-btn"
          tabIndex={-1}
        >
          <Sparkles size={13} /> Generate Selected Styles
        </button>
      </div>
    </div>
  );
}

export function FamilyScene({ progress, onCaption }: SceneProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const rects = useStageAnchors(stageRef);
  const waypoints = useResolvedWaypoints(FAMILY_BASE, rects);
  const motion = useTourMotion(waypoints, progress);
  useCaptionReporter(motion.content, onCaption);

  return (
    <div className="pt-stage" ref={stageRef}>
      <AppShell activeTool="select" rightPanel={<IdleRightPanel char="A" />} dimmed />
      <InlineLabModal extraModalClass="fm-family-auto-modal" icon={<Layers size={14} />} title="Family">
        <FamilyModalBody progress={progress} />
      </InlineLabModal>
      <TourCursorLayer motion={motion} />
    </div>
  );
}

// ---------------------------------------------------------- 3. TEST LAB --

const TESTLAB_BASE: BaseWaypoint[] = [
  { t: 0, anchor: "lab-specimen", caption: "Test Lab — preview real typography" },
  { t: 0.3, anchor: "lab-kern-pair", click: true, caption: "Kerning pairs, previewed live" },
  { t: 0.58, anchor: "lab-kern-pair", caption: "Fine-tune spacing between any pair" },
  { t: 0.82, anchor: "lab-side", caption: "Tune size, tracking & sample text" },
  { t: 1, anchor: "lab-specimen", highlight: false },
];

function TestLabModalBody({ progress }: { progress: number }) {
  const kernP = clamp01((progress - 0.22) / (0.4 - 0.22));
  const sizeP = clamp01((progress - 0.7) / (0.95 - 0.7));

  return (
    <div className="fm-lab-body">
      <div className="fm-lab-grid">
        <div className="fm-lab-main">
          <div className="pt-lab-specimen" style={{ fontSize: `${26 + sizeP * 14}px` }} data-tour-anchor="lab-specimen">
            <span>Typ</span>
            <span className="pt-lab-kern-pair" data-tour-anchor="lab-kern-pair" data-active={kernP > 0.05}>
              <span className="pt-lab-kern-glyph">o</span>
              <span className="pt-lab-kern-glyph" style={{ marginLeft: `${-2 - kernP * 4}px` }}>
                g
              </span>
              {kernP > 0.05 && <span className="pt-lab-kern-badge">{Math.round(-24 * kernP)}</span>}
            </span>
            <span>raphy</span>
          </div>
          <div className="pt-lab-specimen pt-lab-specimen-sub">The quick brown fox jumps</div>
        </div>
        <div className="fm-lab-side" data-tour-anchor="lab-side">
          <div className="fm-lab-side-section">
            <div className="fm-section-title">Kerning</div>
            <div className="fm-field">
              <div className="fm-slider-row-label">
                <span className="fm-slider-label-group">
                  <label>Pair (o, g)</label>
                </span>
                <span>{Math.round(-24 * kernP)}</span>
              </div>
              <input
                type="range"
                min={-80}
                max={80}
                value={Math.round(-24 * kernP)}
                readOnly
                tabIndex={-1}
                style={{ pointerEvents: "none" }}
              />
            </div>
          </div>
          <div className="fm-lab-side-section">
            <div className="fm-section-title">Display</div>
            <div className="fm-field">
              <div className="fm-slider-row-label">
                <span className="fm-slider-label-group">
                  <label>Size</label>
                </span>
                <span>{Math.round(26 + sizeP * 14)}px</span>
              </div>
              <input
                type="range"
                min={12}
                max={96}
                value={Math.round(26 + sizeP * 14)}
                readOnly
                tabIndex={-1}
                style={{ pointerEvents: "none" }}
              />
            </div>
            <div className="fm-field">
              <div className="fm-slider-row-label">
                <span className="fm-slider-label-group">
                  <label>Tracking</label>
                </span>
                <span>0</span>
              </div>
              <input type="range" min={-10} max={10} value={0} readOnly tabIndex={-1} style={{ pointerEvents: "none" }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TestLabScene({ progress, onCaption }: SceneProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const rects = useStageAnchors(stageRef);
  const waypoints = useResolvedWaypoints(TESTLAB_BASE, rects);
  const motion = useTourMotion(waypoints, progress);
  useCaptionReporter(motion.content, onCaption);

  return (
    <div className="pt-stage" ref={stageRef}>
      <AppShell activeTool="select" rightPanel={<IdleRightPanel char="T" />} dimmed />
      <InlineLabModal icon={<FlaskConical size={14} />} title="Test Lab">
        <TestLabModalBody progress={progress} />
      </InlineLabModal>
      <TourCursorLayer motion={motion} />
    </div>
  );
}

// ------------------------------------------------------ 4. FEATURE BUILDER

const FEATURE_BASE: BaseWaypoint[] = [
  { t: 0, anchor: "feature-section", caption: "Ligature, Alternate or Swash rules" },
  { t: 0.3, anchor: "feature-form", click: true, caption: "Choose the glyphs the rule combines" },
  { t: 0.56, anchor: "feature-form", caption: "Preview updates as you build the rule" },
  { t: 0.8, anchor: "feature-btn-primary", click: true, caption: "Save — the rule is ready to export" },
  { t: 1, anchor: "feature-rule-row" },
];

function FeatureModalBody({ progress }: { progress: number }) {
  const mergeP = clamp01((progress - 0.5) / (0.72 - 0.5));
  const savedP = clamp01((progress - 0.82) / (0.92 - 0.82));

  return (
    <div className="fm-lab-body fm-feature-body">
      <p className="fm-feature-intro">Build OpenType substitution rules visually — no font code required.</p>
      <div className="fm-feature-rule-tabs" aria-hidden="true">
        <span className="pt-chip pt-chip-active">Ligature</span>
        <span className="pt-chip">Alternate</span>
        <span className="pt-chip">Swash</span>
      </div>
      <section className="fm-feature-section" data-tour-anchor="feature-section">
        <div className="fm-section-title">Ligature</div>
        <div className="fm-feature-form" data-tour-anchor="feature-form">
          <div className="fm-feature-thumb pt-feature-merge-thumb" style={{ transform: `translateX(${mergeP * 10}px)` }}>
            f
          </div>
          <span className="fm-feature-plus" style={{ opacity: 1 - mergeP }}>
            +
          </span>
          <div
            className="fm-feature-thumb pt-feature-merge-thumb"
            style={{ transform: `translateX(${-mergeP * 10}px)` }}
          >
            i
          </div>
          <span className="fm-feature-arrow">→</span>
          <div
            className="fm-feature-thumb pt-feature-merge-thumb pt-feature-merge-result"
            style={{ opacity: 0.4 + mergeP * 0.6 }}
          >
            fi
          </div>
          <button
            type="button"
            className="fm-feature-btn fm-feature-btn-primary"
            data-tour-anchor="feature-btn-primary"
            tabIndex={-1}
          >
            Add Rule
          </button>
        </div>
        <div className="fm-feature-rule-list">
          {savedP > 0.05 ? (
            <div className="fm-feature-rule-row" data-tour-anchor="feature-rule-row" style={{ opacity: savedP }}>
              <span className="fm-feature-arrow">→</span>
              <span className="fm-feature-rule-label">f + i → fi</span>
              <div className="fm-spacer" />
              <span className="pt-generated-badge">
                <Sparkles size={10} /> Saved
              </span>
            </div>
          ) : (
            <div className="fm-feature-empty" data-tour-anchor="feature-rule-row">
              No ligature rules yet.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function FeatureBuilderScene({ progress, onCaption }: SceneProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const rects = useStageAnchors(stageRef);
  const waypoints = useResolvedWaypoints(FEATURE_BASE, rects);
  const motion = useTourMotion(waypoints, progress);
  useCaptionReporter(motion.content, onCaption);

  return (
    <div className="pt-stage" ref={stageRef}>
      <AppShell activeTool="select" rightPanel={<IdleRightPanel char="f" />} dimmed />
      <InlineLabModal extraModalClass="fm-feature-modal" icon={<Wand2 size={14} />} title="Feature Builder">
        <FeatureModalBody progress={progress} />
      </InlineLabModal>
      <TourCursorLayer motion={motion} />
    </div>
  );
}

export const TOUR_SCENES = [
  { id: "brush", title: "Brush", icon: Paintbrush, Component: BrushScene },
  { id: "family", title: "Family", icon: Layers, Component: FamilyScene },
  { id: "testlab", title: "Test Lab", icon: FlaskConical, Component: TestLabScene },
  { id: "feature", title: "Feature Builder", icon: Wand2, Component: FeatureBuilderScene },
] as const;
