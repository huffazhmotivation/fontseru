import { useEffect, useState } from "react";
import {
  MousePointer2,
  PenTool,
  Paintbrush,
  Shapes,
  Hand,
  Layers,
  FlaskConical,
  Wand2,
  Sparkles,
  Check,
} from "lucide-react";

/**
 * All content in this file is 100% static/mock data used purely to *play
 * back* an animated walkthrough. Nothing here reads from or writes to
 * `src/glyph/store.ts`, IndexedDB, or Supabase — see ProductTour.tsx for
 * the isolation guarantees.
 */

// ---------------------------------------------------------------- MOTION --

export interface TourWaypoint {
  /** 0..1 progress (within the current scene) at which the cursor arrives
   * at this waypoint and its content (tooltip/highlight) becomes active. */
  t: number;
  /** Cursor position, in percent of the scene stage. */
  cx: number;
  cy: number;
  tooltip?: string;
  tooltipPos?: "top" | "bottom" | "left" | "right";
  /** Spotlight rect, in percent of the scene stage. */
  highlight?: { x: number; y: number; w: number; h: number };
  /** Plays a click-ripple exactly as the cursor arrives here. */
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
 * "currently active" waypoint (for tooltip/highlight), gliding smoothly
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

/** Fake cursor + tooltip + spotlight highlight, absolutely positioned
 * inside a `position:relative` `.pt-stage` container. Shared by every
 * scene so movement/tooltip/highlight all look and feel identical. */
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
        {content.tooltip && (
          <div className={`pt-tooltip pt-tooltip-${content.tooltipPos ?? "bottom"}`}>{content.tooltip}</div>
        )}
      </div>
    </>
  );
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// A tiny left tool-rail shared by scenes that show the main canvas, so it
// visually matches FontSeru's real FloatingToolbar.
function ToolRail({ active }: { active: "select" | "pen" | "brush" | "shapes" | "pan" }) {
  const tools: { id: typeof active; icon: typeof MousePointer2 }[] = [
    { id: "select", icon: MousePointer2 },
    { id: "pen", icon: PenTool },
    { id: "brush", icon: Paintbrush },
    { id: "shapes", icon: Shapes },
    { id: "pan", icon: Hand },
  ];
  return (
    <div className="pt-toolrail">
      {tools.map(({ id, icon: Icon }) => (
        <div key={id} className={`pt-toolrail-btn${id === active ? " pt-toolrail-btn-active" : ""}`} data-tour-target={id}>
          <Icon size={16} />
        </div>
      ))}
    </div>
  );
}

function MiniTopBar({ label }: { label: string }) {
  return (
    <div className="pt-minitopbar">
      <div className="pt-minitopbar-dots">
        <span />
        <span />
        <span />
      </div>
      <div className="pt-minitopbar-label">{label}</div>
      <div className="pt-minitopbar-spacer" />
    </div>
  );
}

// ------------------------------------------------------------ 1. BRUSH ---

const BRUSH_WAYPOINTS: TourWaypoint[] = [
  { t: 0, cx: 10, cy: 46, highlight: { x: 3, y: 14, w: 11, h: 60 } },
  {
    t: 0.1,
    cx: 10,
    cy: 46,
    click: true,
    tooltip: "Brush tool — draw with pressure & taper",
    tooltipPos: "right",
    highlight: { x: 3, y: 14, w: 11, h: 60 },
  },
  {
    t: 0.2,
    cx: 30,
    cy: 30,
    tooltip: "Draw straight onto the glyph canvas",
    tooltipPos: "top",
    highlight: { x: 20, y: 12, w: 62, h: 70 },
  },
  {
    t: 0.4,
    cx: 34,
    cy: 76,
    tooltip: "FontSeru builds a clean vector outline as you draw",
    tooltipPos: "top",
    highlight: { x: 20, y: 12, w: 62, h: 70 },
  },
  {
    t: 0.62,
    cx: 80,
    cy: 66,
    click: true,
    tooltip: "Width Profile — shape the taper",
    tooltipPos: "left",
    highlight: { x: 66, y: 54, w: 30, h: 34 },
  },
  {
    t: 0.86,
    cx: 80,
    cy: 66,
    tooltip: "Natural, hand-lettered taper — instantly",
    tooltipPos: "left",
    highlight: { x: 66, y: 54, w: 30, h: 34 },
  },
  { t: 1, cx: 50, cy: 46 },
];

// Hand-authored flowing "S" stroke used to sell "drawing a glyph". Uses
// pathLength=1000 so the dash-offset math below is independent of the
// path's real geometry.
const BRUSH_PATH_D = "M158,58 C126,32 72,36 62,66 C52,96 96,104 124,116 C158,131 182,146 168,178 C154,209 98,208 70,184";

export function BrushScene({ progress }: { progress: number }) {
  const motion = useTourMotion(BRUSH_WAYPOINTS, progress);
  const drawP = clamp01((progress - 0.14) / (0.4 - 0.14));
  const convertP = clamp01((progress - 0.42) / (0.5 - 0.42));
  const taperP = clamp01((progress - 0.62) / (0.98 - 0.62));
  const startWidth = Math.round(4 + taperP * 14);
  const endWidth = Math.round(18 - taperP * 14);

  return (
    <div className="pt-feature-shell">
      <MiniTopBar label="Untitled Font — Glyph “s”" />
      <div className="pt-feature-body">
        <ToolRail active="brush" />
        <div className="pt-stage pt-stage-canvas">
          <div className="pt-canvas-guides">
            <div className="pt-guide-line" style={{ top: "22%" }} />
            <div className="pt-guide-line" style={{ top: "78%" }} />
            <div className="pt-guide-line pt-guide-baseline" style={{ top: "88%" }} />
          </div>
          <svg className="pt-brush-svg" viewBox="0 0 220 220" preserveAspectRatio="xMidYMid meet">
            <path
              className="pt-brush-stroke"
              d={BRUSH_PATH_D}
              pathLength={1000}
              style={{
                strokeDasharray: 1000,
                strokeDashoffset: 1000 * (1 - drawP),
                opacity: 1 - convertP,
              }}
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
          <TourCursorLayer motion={motion} />
        </div>
        <div className="pt-side-panel">
          <div className="pt-panel-title">
            <Paintbrush size={13} /> Brush
          </div>
          <div className="pt-panel-row">
            <span>Type</span>
            <span className="pt-chip pt-chip-active">Round</span>
          </div>
          <div className="pt-panel-row">
            <span>Size</span>
            <div className="pt-mini-slider">
              <div className="pt-mini-slider-fill" style={{ width: `${40 + taperP * 20}%` }} />
            </div>
          </div>
          <div className="pt-panel-block pt-panel-block-highlight" data-active={progress >= 0.55 && progress < 0.98}>
            <div className="pt-panel-subtitle">Width Profile</div>
            <svg className="pt-taper-graph" viewBox="0 0 100 32" preserveAspectRatio="none">
              <path
                d={`M2,${30 - taperP * 4} Q50,${2 + taperP * 10} 98,${30 - (1 - taperP) * 4}`}
                className="pt-taper-curve"
              />
              <circle cx={2 + taperP * 96} cy={30 - Math.sin(taperP * Math.PI) * 20} r={3} className="pt-taper-handle" />
            </svg>
            <div className="pt-panel-row pt-panel-row-tight">
              <span>Start</span>
              <span className="pt-mono-value">{startWidth}</span>
            </div>
            <div className="pt-panel-row pt-panel-row-tight">
              <span>End</span>
              <span className="pt-mono-value">{endWidth}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------- 2. FAMILY ---

const FAMILY_WAYPOINTS: TourWaypoint[] = [
  { t: 0, cx: 50, cy: 20, highlight: { x: 8, y: 10, w: 84, h: 16 } },
  {
    t: 0.12,
    cx: 50,
    cy: 20,
    tooltip: "One Regular master — the whole family",
    tooltipPos: "bottom",
    highlight: { x: 8, y: 10, w: 84, h: 16 },
  },
  {
    t: 0.3,
    cx: 50,
    cy: 76,
    click: true,
    tooltip: "Generate Bold, Italic & custom styles",
    tooltipPos: "top",
    highlight: { x: 34, y: 68, w: 32, h: 16 },
  },
  {
    t: 0.55,
    cx: 30,
    cy: 44,
    tooltip: "Bold — weight synthesized automatically",
    tooltipPos: "bottom",
    highlight: { x: 8, y: 30, w: 26, h: 34 },
  },
  {
    t: 0.78,
    cx: 70,
    cy: 44,
    tooltip: "Italic — slant & shape adjusted to match",
    tooltipPos: "bottom",
    highlight: { x: 58, y: 30, w: 26, h: 34 },
  },
  { t: 1, cx: 50, cy: 44 },
];

interface FamilyCardDef {
  key: string;
  label: string;
  weight: number;
  italic: boolean;
  revealFrom: number;
}
const FAMILY_CARDS: FamilyCardDef[] = [
  { key: "regular", label: "Regular", weight: 400, italic: false, revealFrom: 0 },
  { key: "bold", label: "Bold", weight: 800, italic: false, revealFrom: 0.4 },
  { key: "italic", label: "Italic", weight: 400, italic: true, revealFrom: 0.62 },
  { key: "custom", label: "Family", weight: 300, italic: false, revealFrom: 0.84 },
];

export function FamilyScene({ progress }: { progress: number }) {
  const motion = useTourMotion(FAMILY_WAYPOINTS, progress);
  return (
    <div className="pt-feature-shell">
      <MiniTopBar label="Untitled Font — Family" />
      <div className="pt-feature-body pt-feature-body-family">
        <div className="pt-stage pt-stage-family">
          <div className="pt-family-tabs">
            {["Regular", "Bold", "Italic", "Family"].map((t, i) => (
              <div key={t} className={`pt-family-tab${i === 0 ? " pt-family-tab-active" : ""}`}>
                {t}
              </div>
            ))}
          </div>
          <div className="pt-family-generate-row">
            <div className="pt-generate-btn" data-armed={progress >= 0.24 && progress < 0.34}>
              <Wand2 size={13} /> Auto-Generate Styles
            </div>
          </div>
          <div className="pt-family-grid">
            {FAMILY_CARDS.map((card) => {
              const localP = clamp01((progress - card.revealFrom) / 0.16);
              const done = localP >= 1;
              const generating = localP > 0 && localP < 1;
              return (
                <div key={card.key} className="pt-family-card">
                  <div className="pt-family-card-head">
                    <span>{card.label}</span>
                    {card.key !== "regular" && done && (
                      <span className="pt-generated-badge">
                        <Check size={10} /> Generated
                      </span>
                    )}
                  </div>
                  <div
                    className="pt-family-glyph"
                    style={{
                      fontWeight: card.key === "regular" ? 400 : 400 + localP * (card.weight - 400),
                      fontStyle: card.italic ? (localP > 0.15 ? "italic" : "normal") : "normal",
                      opacity: card.key === "regular" ? 1 : 0.35 + localP * 0.65,
                    }}
                  >
                    Ag
                  </div>
                  {card.key !== "regular" && generating && (
                    <div className="pt-mini-slider pt-mini-slider-thin">
                      <div className="pt-mini-slider-fill" style={{ width: `${localP * 100}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <TourCursorLayer motion={motion} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------- 3. TEST LAB --

const TESTLAB_WAYPOINTS: TourWaypoint[] = [
  { t: 0, cx: 50, cy: 14, highlight: { x: 6, y: 4, w: 88, h: 16 } },
  {
    t: 0.14,
    cx: 50,
    cy: 14,
    tooltip: "Test Lab — preview real typography",
    tooltipPos: "bottom",
    highlight: { x: 6, y: 4, w: 88, h: 16 },
  },
  {
    t: 0.36,
    cx: 32,
    cy: 46,
    tooltip: "Live specimen text, set in your font",
    tooltipPos: "top",
    highlight: { x: 6, y: 30, w: 88, h: 30 },
  },
  {
    t: 0.6,
    cx: 46,
    cy: 46,
    click: true,
    tooltip: "Kerning pairs, previewed side by side",
    tooltipPos: "top",
    highlight: { x: 30, y: 34, w: 24, h: 22 },
  },
  {
    t: 0.82,
    cx: 78,
    cy: 78,
    tooltip: "Tune size, tracking & sample text",
    tooltipPos: "left",
    highlight: { x: 62, y: 68, w: 32, h: 18 },
  },
  { t: 1, cx: 50, cy: 46 },
];

export function TestLabScene({ progress }: { progress: number }) {
  const motion = useTourMotion(TESTLAB_WAYPOINTS, progress);
  const kernP = clamp01((progress - 0.5) / (0.66 - 0.5));
  const sizeP = clamp01((progress - 0.7) / (0.95 - 0.7));

  return (
    <div className="pt-feature-shell">
      <div className="pt-lab-topbar">
        <FlaskConical size={14} /> Test Lab
      </div>
      <div className="pt-stage pt-stage-lab">
        <div className="pt-lab-specimen" style={{ fontSize: `${28 + sizeP * 14}px` }}>
          <span>Type</span>
          <span className="pt-lab-kern-pair" data-active={kernP > 0.05 && kernP < 1}>
            <span className="pt-lab-kern-glyph">o</span>
            <span className="pt-lab-kern-glyph" style={{ marginLeft: `${-2 - kernP * 4}px` }}>
              g
            </span>
            {kernP > 0.05 && <span className="pt-lab-kern-badge">{Math.round(-24 * kernP)}</span>}
          </span>
          <span>raphy</span>
        </div>
        <div className="pt-lab-specimen pt-lab-specimen-sub">The quick brown fox jumps</div>
        <div className="pt-lab-controls">
          <div className="pt-lab-control">
            <span>Size</span>
            <div className="pt-mini-slider">
              <div className="pt-mini-slider-fill" style={{ width: `${30 + sizeP * 50}%` }} />
            </div>
          </div>
          <div className="pt-lab-control">
            <span>Tracking</span>
            <div className="pt-mini-slider">
              <div className="pt-mini-slider-fill" style={{ width: "42%" }} />
            </div>
          </div>
        </div>
        <TourCursorLayer motion={motion} />
      </div>
    </div>
  );
}

// ------------------------------------------------------ 4. FEATURE BUILDER

const FEATURE_WAYPOINTS: TourWaypoint[] = [
  { t: 0, cx: 50, cy: 14, highlight: { x: 6, y: 4, w: 88, h: 16 } },
  {
    t: 0.14,
    cx: 50,
    cy: 14,
    tooltip: "Feature Builder — OpenType rules, no code",
    tooltipPos: "bottom",
    highlight: { x: 6, y: 4, w: 88, h: 16 },
  },
  {
    t: 0.34,
    cx: 22,
    cy: 34,
    click: true,
    tooltip: "Pick a rule type: Ligature, Alternate or Swash",
    tooltipPos: "right",
    highlight: { x: 6, y: 24, w: 30, h: 40 },
  },
  {
    t: 0.56,
    cx: 55,
    cy: 56,
    tooltip: "Choose the glyphs the rule combines",
    tooltipPos: "top",
    highlight: { x: 38, y: 40, w: 34, h: 30 },
  },
  {
    t: 0.8,
    cx: 82,
    cy: 30,
    click: true,
    tooltip: "Save — the rule is ready to export",
    tooltipPos: "left",
    highlight: { x: 70, y: 20, w: 24, h: 16 },
  },
  { t: 1, cx: 50, cy: 46 },
];

export function FeatureBuilderScene({ progress }: { progress: number }) {
  const motion = useTourMotion(FEATURE_WAYPOINTS, progress);
  const mergeP = clamp01((progress - 0.52) / (0.74 - 0.52));
  const savedP = clamp01((progress - 0.82) / (0.92 - 0.82));

  return (
    <div className="pt-feature-shell">
      <div className="pt-lab-topbar">
        <Wand2 size={14} /> Feature Builder
      </div>
      <div className="pt-stage pt-stage-feature">
        <div className="pt-feature-rule-types">
          {[
            { id: "liga", label: "Ligature" },
            { id: "salt", label: "Alternate" },
            { id: "swsh", label: "Swash" },
          ].map((r, i) => (
            <div key={r.id} className={`pt-chip pt-feature-rule-chip${i === 0 ? " pt-chip-active" : ""}`}>
              {r.label}
            </div>
          ))}
        </div>
        <div className="pt-feature-merge">
          <div className="pt-feature-glyph" style={{ transform: `translateX(${mergeP * 14}px)` }}>
            f
          </div>
          <div className="pt-feature-plus" style={{ opacity: 1 - mergeP }}>
            +
          </div>
          <div className="pt-feature-glyph" style={{ transform: `translateX(${-mergeP * 14}px)` }}>
            i
          </div>
          <div className="pt-feature-arrow" style={{ opacity: mergeP }}>
            →
          </div>
          <div className="pt-feature-glyph pt-feature-glyph-result" style={{ opacity: mergeP }}>
            fi
          </div>
        </div>
        {savedP > 0.05 && (
          <div className="pt-outline-badge" style={{ opacity: savedP }}>
            <Sparkles size={12} /> Rule created: fi → ﬁ
          </div>
        )}
        <TourCursorLayer motion={motion} />
      </div>
    </div>
  );
}

export const TOUR_SCENES = [
  { id: "brush", title: "Brush", icon: Paintbrush, Component: BrushScene },
  { id: "family", title: "Family", icon: Layers, Component: FamilyScene },
  { id: "testlab", title: "Test Lab", icon: FlaskConical, Component: TestLabScene },
  { id: "feature", title: "Feature Builder", icon: Wand2, Component: FeatureBuilderScene },
] as const;
