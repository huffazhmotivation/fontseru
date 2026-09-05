import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, PenLine, Minus, Highlighter, Feather, Pencil, Zap, Scissors, Trash2, Flame, Grid3x3, Lock, Unlock, ImagePlus, CircleDashed, Droplet, Triangle, Circle, Square } from "lucide-react";
import type { ShapeKind } from "@/editor/shapeBuilder";
import { useAppStore, type NodeRef, type GlyphMetricKey } from "@/glyph/store";
import { GLYPH_GROUPS } from "@/glyph/defaultGlyphs";
import { hasOutline } from "@/types/glyph";
import type { Glyph } from "@/types/glyph";
import { unicodeHex } from "@/utils/unicode";
import { findNode, retypeNode, retypeNodes, deleteNodes, moveNodesBy, setHandlePoint } from "@/editor/nodeOps";
import { objectsBounds, skewObject } from "@/editor/objectOps";
import type { NodeType, PathNode, StrokeCap, VectorObject } from "@/types/geometry";
import { BRUSH_ORDER, BRUSH_PRESETS } from "@/brushes/presets";
import { taperFactor } from "@/brushes/strokeToOutline";
import type { BrushType } from "@/types/brush";
import { GlyphThumbnail } from "./GlyphThumbnail";
import { NumericInput } from "./NumericInput";
import { InfoTip } from "./InfoTip";

const NODE_TYPE_LABEL: Record<NodeType, string> = { corner: "Corner", smooth: "Smooth", symmetric: "Symmetric" };

const BRUSH_ICON: Record<BrushType, typeof PenLine> = {
  round: PenLine, monoline: Minus, marker: Highlighter, calligraphic: Feather, pencil: Pencil, pressureTaper: Zap,
  rough: CircleDashed, grunge: Flame, oilBrush: Droplet, pixel: Grid3x3,
  strong: Triangle, outline: Circle,
};

export function RightPanel() {
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[activeChar]);
  const tool = useAppStore((s) => s.tool);
  const selectedNodes = useAppStore((s) => s.selectedNodes);
  const selectedObjectIds = useAppStore((s) => s.selectedObjectIds);

  if (!glyph) return <div className="fm-rightpanel" />;

  const category = GLYPH_GROUPS.find((g) => g.id === glyph.category)?.label;
  // Select tool: show its panel as soon as the tool is active, not only once
  // something is selected — same pattern Node already uses (see below). This
  // keeps the Select/Transform panel in place across an Undo/Redo that clears
  // the current selection, instead of falling through to the generic Glyph
  // panel and looking like the tool itself was exited.
  const showSelect = tool === "select";
  const showBrush = tool === "brush";
  // Node tool: show its status/properties panel as soon as the tool is
  // active, not only once a node is selected (NodePanel handles the
  // "nothing selected yet" state itself).
  const showNode = tool === "node";
  const showPenLine = tool === "pen";
  const showPencil = tool === "pencil";
  const showShape = tool === "shape";

  return (
    <div className="fm-rightpanel" data-testid="right-panel">
      <div className="fm-panel-header">
        <div className="fm-panel-glyph"><GlyphThumbnail glyph={glyph} /></div>
        <div className="fm-panel-meta">
          <div className="fm-panel-char">{glyph.char}</div>
          <div className="fm-panel-code">{unicodeHex(glyph.unicode)}</div>
          <div className="fm-panel-cat">{category}</div>
        </div>
      </div>

      {showSelect ? (
        <SelectPanel glyph={glyph} selectedObjectIds={selectedObjectIds} />
      ) : showBrush ? (
        <BrushPanel />
      ) : showNode ? (
        <NodePanel char={activeChar} glyph={glyph} selectedNodes={selectedNodes} />
      ) : showPenLine ? (
        <PenPanel />
      ) : showPencil ? (
        <PencilPanel />
      ) : showShape ? (
        <ShapePanel />
      ) : (
        <GlyphPanel char={activeChar} glyph={glyph} />
      )}

      {tool === "home" && (
        <>
          <GlyphMetricsSection char={activeChar} glyph={glyph} />
          <FontMetricsSection />
          <GhostGlyphSection />
        </>
      )}
    </div>
  );
}

function Section({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`fm-section ${open ? "open" : "closed"}`}>
      <button className="fm-section-head" onClick={() => setOpen((o) => !o)} data-testid={`section-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        <span className="fm-section-title">{title}</span>
        <ChevronDown size={14} className="fm-section-caret" />
      </button>
      {open && <div className="fm-section-body">{children}</div>}
    </div>
  );
}

function SelectPanel({ glyph, selectedObjectIds }: { glyph: Glyph; selectedObjectIds: string[] }) {
  const expandSelectedStrokes = useAppStore((s) => s.expandSelectedStrokes);
  const updateSelectedObject = useAppStore((s) => s.updateSelectedObject);
  const groupSelectedObjects = useAppStore((s) => s.groupSelectedObjects);
  const ungroupSelectedObjects = useAppStore((s) => s.ungroupSelectedObjects);
  const strokeWidthLocked = useAppStore((s) => s.strokeWidthLocked);
  const toggleStrokeWidthLock = useAppStore((s) => s.toggleStrokeWidthLock);

  const objs = glyph.outline.objects.filter((o) => selectedObjectIds.includes(o.id));
  const strokeObjs = objs.filter((o) => o.kind === "line" || o.kind === "brush");
  const capObjs = objs.filter((o) => o.kind === "line" || (o.kind === "brush" && o.brushType === "monoline"));
  const brushObjs = objs.filter((o) => o.kind === "brush");
  // Only one active highlight makes sense when the selection is a single
  // brush type; a mixed multi-brush selection shows no preset as "active"
  // rather than misleadingly highlighting the first object's type.
  const commonBrushType = brushObjs.length > 0 && brushObjs.every((o) => o.brushType === brushObjs[0].brushType)
    ? (brushObjs[0].brushType as BrushType | undefined)
    : undefined;
  const groupIds = new Set(objs.flatMap((o) => (o.groupId ? [o.groupId] : [])));
  const oneGroupId = groupIds.size === 1 ? [...groupIds][0] : null;
  const isSingleGroup = Boolean(oneGroupId && objs.length > 1 && objs.every((o) => o.groupId === oneGroupId));

  // Mirrors NodePanel's own "nothing selected yet" state below: the Select
  // tool stays in charge of the right panel (see `showSelect` above), so an
  // Undo/Redo that clears the selection lands here instead of bouncing back
  // to the generic Glyph panel.
  if (objs.length === 0) {
    return (
      <Section title="Selection">
        <span className="fm-status-pill" data-testid="select-status-empty">
          <span className="fm-status-dot" />
          Nothing selected
        </span>
        <InfoTip>
          Click an object on the canvas to select it, or drag a marquee to select several.
        </InfoTip>
      </Section>
    );
  }

  return (
    <>
      <Section title="Selection">
      {brushObjs.length > 0 && (
        <div className="fm-brush-grid" data-testid="select-brush-grid">
          {BRUSH_ORDER.map((id) => {
            const Icon = BRUSH_ICON[id];
            const p = BRUSH_PRESETS[id];
            return (
              <button
                key={id}
                className={`fm-brush-card ${commonBrushType === id ? "active" : ""}`}
                onClick={() => updateSelectedObject({ brushType: id })}
                title={`Switch to ${p.label}`}
                data-testid={`select-brush-${id}`}
              >
                <span className="fm-brush-icon"><Icon size={17} strokeWidth={1.8} /></span>
                <span className="fm-brush-name">{p.label}</span>
              </button>
            );
          })}
        </div>
      )}
      {strokeObjs.length > 0 && (
        <Slider label="Stroke Width" value={strokeObjs[0].strokeWidth ?? 20} min={1} max={200} directInput
          onChange={(v) => updateSelectedObject({ strokeWidth: v })}
          labelAdornment={
            <button
              type="button"
              className={`fm-lock-btn ${strokeWidthLocked ? "active" : ""}`}
              onClick={toggleStrokeWidthLock}
              title={strokeWidthLocked ? "Stroke width locked — stays the same when scaling" : "Stroke width unlocked — scales with the object"}
              aria-pressed={strokeWidthLocked}
              data-testid="stroke-width-lock"
            >
              {strokeWidthLocked ? <Lock size={12} strokeWidth={2} /> : <Unlock size={12} strokeWidth={2} />}
            </button>
          }
        />
      )}
      {capObjs.length > 0 && (
        <CapControl value={capObjs[0].cap ?? "round"} onChange={(cap) => updateSelectedObject({ cap })} />
      )}

      {objs.length > 1 && (
        <button className="fm-action-btn" onClick={groupSelectedObjects} disabled={isSingleGroup} data-testid="group-btn">
          Group
        </button>
      )}
      {groupIds.size > 0 && (
        <button className="fm-action-btn" onClick={ungroupSelectedObjects} data-testid="ungroup-btn">
          Ungroup
        </button>
      )}

      {strokeObjs.length > 0 && (
        <button className="fm-action-btn accent" onClick={expandSelectedStrokes} data-testid="expand-stroke-btn">
          <Scissors size={14} /> Expand Stroke{strokeObjs.length > 1 ? "s" : ""}
        </button>
      )}
      <InfoTip>
        Drag to move · corner/edge handles resize (Shift = proportional) · top handle rotates (Shift = 15°). Cmd/Ctrl+G groups · Cmd/Ctrl+U ungroups.
      </InfoTip>
      </Section>
      <TransformPanel glyph={glyph} selectedObjectIds={selectedObjectIds} />
    </>
  );
}

function TransformPanel({ glyph, selectedObjectIds }: { glyph: Glyph; selectedObjectIds: string[] }) {
  const skewAngle = useAppStore((s) => s.selectionSkewAngle);
  const skewHandle = useAppStore((s) => s.selectionSkewHandle);
  const setSelectionSkewState = useAppStore((s) => s.setSelectionSkewState);
  const commitOutline = useAppStore((s) => s.commitOutline);
  const activeChar = useAppStore((s) => s.activeChar);

  const applySkewAngle = (rawAngle: number) => {
    if (!Number.isFinite(rawAngle) || selectedObjectIds.length === 0) return;
    const angle = Math.max(-89, Math.min(89, rawAngle));
    const previousShear = Math.tan((skewAngle * Math.PI) / 180);
    const nextShear = Math.tan((angle * Math.PI) / 180);
    const delta = nextShear - previousShear;
    if (Math.abs(delta) < 1e-9) {
      setSelectionSkewState(angle, skewHandle);
      return;
    }

    const bounds = objectsBounds(glyph.outline, selectedObjectIds);
    if (!bounds) return;
    const handle = skewHandle ?? "skew-x-top";
    const horizontal = handle === "skew-x-top" || handle === "skew-x-bottom";
    const topOrRight = handle === "skew-x-top" || handle === "skew-y-right";
    const anchor = horizontal
      ? { x: 0, y: topOrRight ? bounds.minY : bounds.maxY }
      : { x: topOrRight ? bounds.minX : bounds.maxX, y: 0 };

    const objects = glyph.outline.objects.map((obj) =>
      selectedObjectIds.includes(obj.id)
        ? skewObject(obj, anchor, horizontal ? delta : 0, horizontal ? 0 : delta)
        : obj
    );
    commitOutline(activeChar, { objects });
    setSelectionSkewState(angle, handle);
  };

  return (
    <Section title="Transform">
      <div className="fm-field">
        <label htmlFor="transform-skew">Skew</label>
        <div className="fm-angle-control">
          <NumericInput
            id="transform-skew"
            value={Number(skewAngle.toFixed(1))}
            min={-89}
            max={89}
            step={1}
            onChange={applySkewAngle}
            aria-label="Skew angle"
            data-testid="transform-skew"
          />
          <span aria-hidden="true">°</span>
        </div>
      </div>
      <InfoTip>
        Drag a skew handle or enter an angle. The numeric value follows the active skew direction.
      </InfoTip>
    </Section>
  );
}

function GlyphPanel({ char, glyph }: { char: string; glyph: Glyph }) {
  // Outline / object-count section intentionally removed from the sidebar
  // per request. `char`/`glyph` kept in the signature so callers and the
  // conditional render logic in RightPanel don't need to change.
  void char;
  void glyph;
  return null;
}

function GlyphMetricsSection({ char, glyph }: { char: string; glyph: Glyph }) {
  const updateGlyphMetrics = useAppStore((s) => s.updateGlyphMetrics);
  const scope = useAppStore((s) => s.glyphMetricScope);
  const setScope = useAppStore((s) => s.setGlyphMetricScope);
  const focus = useAppStore((s) => s.glyphMetricFocus);
  const setFocus = useAppStore((s) => s.setGlyphMetricFocus);
  const isAuto = useAppStore((s) => s.autoSpacingEnabled);
  const setAutoSpacingEnabled = useAppStore((s) => s.setAutoSpacingEnabled);
  const refs = useRef<Partial<Record<GlyphMetricKey, HTMLInputElement | null>>>({});

  useEffect(() => {
    if (!focus) return;
    const el = refs.current[focus];
    if (!el) return;
    el.focus();
    el.select();
    setFocus(null);
  }, [focus, setFocus]);

  const rows: { key: GlyphMetricKey; label: string; value: number; testid: string }[] = [
    { key: "advanceWidth", label: "Advance Width", value: glyph.advanceWidth, testid: "advance-width" },
    { key: "lsb", label: "Left Side Bearing", value: glyph.lsb, testid: "lsb" },
    { key: "rsb", label: "Right Side Bearing", value: glyph.rsb, testid: "rsb" },
  ];

  return (
    <Section title="Glyph Metrics">
      <div className="fm-field">
        <label>Auto Metrik (whole font)</label>
        <div className="fm-node-type-row fm-spacing-mode" role="group" aria-label="Auto Metrik mode">
          <button
            className={`fm-node-type-btn ${!isAuto ? "active" : ""}`}
            onClick={() => setAutoSpacingEnabled(false)}
            data-testid="spacing-mode-manual"
          >
            Manual
          </button>
          <button
            className={`fm-node-type-btn fm-spacing-auto-btn ${isAuto ? "active" : ""}`}
            onClick={() => setAutoSpacingEnabled(true)}
            data-testid="spacing-mode-auto"
            title="Every glyph's position, LSB, RSB, and advance width follow its own outline automatically, using FontSeru's Pro optical-spacing standard. Also mirrored as the 'Auto Metrik' toggle in the bottom bar, next to Snap, so it stays reachable from any tool."
          >
            <span className="fm-spacing-auto-dot" aria-hidden="true" />
            Auto
          </button>
        </div>
      </div>

      <div className="fm-field">
        <label>Apply changes to</label>
        <div className="fm-node-type-row fm-metric-scope" role="group" aria-label="Glyph metric scope">
          <button
            className={`fm-node-type-btn ${scope === "current" ? "active" : ""}`}
            onClick={() => setScope("current")}
            data-testid="metric-scope-current"
          >
            This Glyph
          </button>
          <button
            className={`fm-node-type-btn ${scope === "all" ? "active" : ""}`}
            onClick={() => setScope("all")}
            data-testid="metric-scope-all"
          >
            All Glyphs
          </button>
        </div>
      </div>

      {rows.map(({ key, label, value, testid }) => {
        const isSidebearing = key === "lsb" || key === "rsb";
        return (
          <div className="fm-field" key={key}>
            <label htmlFor={testid}>
              {label}
              {isAuto && isSidebearing && <span className="fm-spacing-auto-tag">Auto</span>}
            </label>
            <NumericInput
              id={testid}
              ref={(el) => { refs.current[key] = el; }}
              value={value}
              onChange={(next) => {
                if (!Number.isFinite(next)) return;
                // Typing a value by hand is the same "switch to Manual"
                // signal as dragging the canvas handle — so a number the
                // user just typed can never get silently overwritten by
                // the next outline edit on this or any other glyph.
                if (isSidebearing && isAuto) setAutoSpacingEnabled(false);
                updateGlyphMetrics(char, { [key]: next });
              }}
              onFocus={() => setFocus(null)}
              data-testid={testid}
            />
          </div>
        );
      })}

      <InfoTip>
        {isAuto
          ? "Auto Metrik is ON for the whole font: every glyph's horizontal position, LSB, RSB, and advance width are recomputed together from that glyph's own outline — using FontSeru's Pro optical-spacing standard — the instant you draw or edit it, so a glyph drawn off-center or off-size still lands correctly. Dragging a handle or typing a value switches back to Manual."
          : "Manual: drag the LSB / Advance / RSB handles on the canvas, or type exact values above. Switch back to Auto Metrik (here or in the bottom bar) to keep every glyph's position, spacing, and width in sync automatically as you draw."}
      </InfoTip>
    </Section>
  );
}

function FontMetricsSection() {
  const metrics = useAppStore((s) => s.metrics);
  const setFontMetric = useAppStore((s) => s.setFontMetric);
  const metricFocus = useAppStore((s) => s.metricFocus);
  const setMetricFocus = useAppStore((s) => s.setMetricFocus);
  const refs = useRef<Partial<Record<keyof typeof metrics, HTMLInputElement | null>>>({});

  useEffect(() => {
    if (!metricFocus) return;
    const el = refs.current[metricFocus];
    if (!el) return;
    el.focus();
    el.select();
    setMetricFocus(null);
  }, [metricFocus, setMetricFocus]);

  // Narrowed to the exact keys used below (rather than the full `keyof
  // typeof metrics`) so `metrics[key]` stays a plain `number` — `metrics`
  // also has the optional `wordSpacing` field (handled separately, right
  // below), and including it in this union would make every row's value
  // `number | undefined`.
  const rows: { key: "ascender" | "capHeight" | "xHeight" | "baseline" | "descender"; label: string; testid: string }[] = [
    { key: "ascender", label: "Ascender", testid: "font-metric-ascender" },
    { key: "capHeight", label: "Cap Height", testid: "font-metric-capHeight" },
    { key: "xHeight", label: "X-Height", testid: "font-metric-xHeight" },
    { key: "baseline", label: "Baseline", testid: "font-metric-baseline" },
    { key: "descender", label: "Descender", testid: "font-metric-descender" },
  ];

  // Falls back to the same constant the live preview/export already use
  // when wordSpacing hasn't been set explicitly (see FontMetrics.wordSpacing),
  // purely so the field shows a sensible starting number instead of blank/0.
  const wordSpacingValue = metrics.wordSpacing ?? Math.round(metrics.unitsPerEm * 0.27);

  return (
    <Section title="Font Metrics" defaultOpen={true}>
      <div className="fm-font-metrics-grid">
        {rows.map(({ key, label, testid }) => (
          <div className="fm-field fm-metric-field" key={key}>
            <label htmlFor={testid}>{label}</label>
            <NumericInput
              id={testid}
              ref={(el) => { refs.current[key] = el; }}
              value={metrics[key]}
              onChange={(next) => {
                if (Number.isFinite(next)) setFontMetric(key, next);
              }}
              onFocus={() => setMetricFocus(null)}
              data-testid={testid}
            />
          </div>
        ))}
        <div className="fm-field fm-metric-field" key="wordSpacing">
          <label htmlFor="font-metric-wordSpacing">Word Spacing</label>
          <NumericInput
            id="font-metric-wordSpacing"
            ref={(el) => { refs.current.wordSpacing = el; }}
            value={wordSpacingValue}
            onChange={(next) => {
              if (Number.isFinite(next)) setFontMetric("wordSpacing", next);
            }}
            onFocus={() => setMetricFocus(null)}
            data-testid="font-metric-wordSpacing"
          />
        </div>
      </div>
      <InfoTip>
        Drag guides on the canvas for live adjustment · double-click a guide for precise input. Word Spacing is the
        gap typed between words (the keyboard space bar) — separate from any per-letter sidebearing. "Auto" derives a
        width from the letters you've already drawn, so the gap stays proportional to this typeface instead of one
        flat default.
      </InfoTip>
    </Section>
  );
}

function NodePanel({ char, glyph, selectedNodes }: { char: string; glyph: Glyph; selectedNodes: NodeRef[] }) {
  const commitOutline = useAppStore((s) => s.commitOutline);
  const clearSelection = useAppStore((s) => s.clearSelection);

  if (selectedNodes.length === 0) {
    const outlined = hasOutline(glyph);
    return (
      <Section title="Node">
        <span className="fm-status-pill" data-testid="node-status-empty">
          <span className="fm-status-dot" />
          No node selected
        </span>
        <InfoTip>
          {outlined
            ? "Click a node on the canvas to see its position and type here."
            : "This glyph has no outline yet — draw with the Pen (P) or Brush (B) first."}
        </InfoTip>
      </Section>
    );
  }

  if (selectedNodes.length > 1) {
    const nodes = selectedNodes
      .map((ref) => findNode(glyph.outline, ref.contourId, ref.nodeId))
      .filter((node): node is PathNode => Boolean(node));
    const commonType = nodes.length > 0 && nodes.every((node) => node.type === nodes[0].type) ? nodes[0].type : null;

    return (
      <Section title="Nodes">
        <span className="fm-status-pill done"><span className="fm-status-dot" />{selectedNodes.length} nodes selected</span>
        <div className="fm-field" style={{ marginTop: 10 }}>
          <label>Set Selected Node Type</label>
          <div className="fm-node-type-row">
            {(Object.keys(NODE_TYPE_LABEL) as NodeType[]).map((type) => (
              <button
                key={type}
                className={`fm-node-type-btn ${commonType === type ? "active" : ""}`}
                onClick={() => commitOutline(char, retypeNodes(glyph.outline, selectedNodes, type), { skipAutoSpacing: true })}
                data-testid={`nodes-type-${type}`}
              >
                {NODE_TYPE_LABEL[type]}
              </button>
            ))}
          </div>
        </div>
        <InfoTip>Drag any selected node to move the group. Shift-click to add/remove. Arrow keys nudge (Shift = ×10).</InfoTip>
        <button className="fm-action-btn danger" style={{ marginTop: 10 }}
          onClick={() => { commitOutline(char, deleteNodes(glyph.outline, selectedNodes), { skipAutoSpacing: true }); clearSelection(); }} data-testid="delete-nodes-btn">
          <Trash2 size={14} /> Delete {selectedNodes.length} Nodes
        </button>
      </Section>
    );
  }

  const ref = selectedNodes[0];
  const node = findNode(glyph.outline, ref.contourId, ref.nodeId);
  if (!node) return null;

  const moveNodeTo = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const dx = x - node.point.x;
    const dy = y - node.point.y;
    if (dx === 0 && dy === 0) return;
    commitOutline(char, moveNodesBy(glyph.outline, [ref], { x: dx, y: dy }), { skipAutoSpacing: true });
  };

  // Handle length/angle: the numeric complement to dragging the handle dot
  // on canvas — lets a curve's tangent be set to an exact value (e.g. a
  // perfectly horizontal/vertical handle, or matching another node's
  // length) the way FontLab/Glyphs' node inspector does, instead of only
  // ever being eyeballed by dragging.
  const handleReadout = (part: "handleIn" | "handleOut") => {
    const h = node[part];
    if (!h) return null;
    const dx = h.x - node.point.x;
    const dy = h.y - node.point.y;
    const len = Math.hypot(dx, dy);
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    return { len, angleDeg };
  };

  const setHandleLengthAngle = (part: "handleIn" | "handleOut", len: number, angleDeg: number) => {
    if (!Number.isFinite(len) || !Number.isFinite(angleDeg)) return;
    const rad = (angleDeg * Math.PI) / 180;
    const nx = node.point.x + Math.cos(rad) * Math.max(0, len);
    const ny = node.point.y + Math.sin(rad) * Math.max(0, len);
    commitOutline(char, setHandlePoint(glyph.outline, ref.contourId, ref.nodeId, part, { x: nx, y: ny }, node.type), { skipAutoSpacing: true });
  };

  const handleIn = handleReadout("handleIn");
  const handleOut = handleReadout("handleOut");

  return (
    <Section title="Node">
      <div className="fm-field">
        <label>Position</label>
        <div className="fm-node-xy-row">
          <NumericInput
            value={Math.round(node.point.x)}
            onChange={(x) => moveNodeTo(x, node.point.y)}
            data-testid="node-pos-x"
            aria-label="Node X position"
          />
          <NumericInput
            value={Math.round(node.point.y)}
            onChange={(y) => moveNodeTo(node.point.x, y)}
            data-testid="node-pos-y"
            aria-label="Node Y position"
          />
        </div>
      </div>
      <div className="fm-field">
        <label>Node Type</label>
        <div className="fm-node-type-row">
          {(Object.keys(NODE_TYPE_LABEL) as NodeType[]).map((t) => (
            <button key={t} className={`fm-node-type-btn ${node.type === t ? "active" : ""}`}
              onClick={() => commitOutline(char, retypeNode(glyph.outline, ref.contourId, ref.nodeId, t), { skipAutoSpacing: true })} data-testid={`node-type-${t}`}>
              {NODE_TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
      {(handleIn || handleOut) && (
        <div className="fm-field">
          <label>Handles (length · angle)</label>
          {handleIn && (
            <div className="fm-node-handle-row">
              <span className="fm-node-handle-label">In</span>
              <NumericInput
                value={Math.round(handleIn.len)}
                onChange={(len) => setHandleLengthAngle("handleIn", len, handleIn.angleDeg)}
                data-testid="node-handlein-len"
                aria-label="Handle In length"
              />
              <NumericInput
                value={Math.round(handleIn.angleDeg)}
                onChange={(deg) => setHandleLengthAngle("handleIn", handleIn.len, deg)}
                data-testid="node-handlein-angle"
                aria-label="Handle In angle"
              />
              <span className="fm-node-handle-unit">°</span>
            </div>
          )}
          {handleOut && (
            <div className="fm-node-handle-row">
              <span className="fm-node-handle-label">Out</span>
              <NumericInput
                value={Math.round(handleOut.len)}
                onChange={(len) => setHandleLengthAngle("handleOut", len, handleOut.angleDeg)}
                data-testid="node-handleout-len"
                aria-label="Handle Out length"
              />
              <NumericInput
                value={Math.round(handleOut.angleDeg)}
                onChange={(deg) => setHandleLengthAngle("handleOut", handleOut.len, deg)}
                data-testid="node-handleout-angle"
                aria-label="Handle Out angle"
              />
              <span className="fm-node-handle-unit">°</span>
            </div>
          )}
        </div>
      )}
      <button className="fm-action-btn danger" onClick={() => { commitOutline(char, deleteNodes(glyph.outline, [ref]), { skipAutoSpacing: true }); clearSelection(); }} data-testid="delete-node-btn">
        <Trash2 size={14} /> Delete Node
      </button>
      <InfoTip>
        Double-click a node to cycle its type · double-click a segment to insert a node · Cmd/Ctrl-drag a segment to curve it · Alt-drag a handle to break it · Cmd/Ctrl-drag a sharp corner to round it.
      </InfoTip>
    </Section>
  );
}

const SHAPE_KIND_OPTIONS: { kind: ShapeKind; label: string; icon: typeof Square }[] = [
  { kind: "rectangle", label: "Rectangle", icon: Square },
  { kind: "ellipse", label: "Ellipse", icon: Circle },
  { kind: "polygon", label: "Polygon", icon: Triangle },
];

function ShapePanel() {
  const shapeKind = useAppStore((s) => s.shapeKind);
  const setShapeKind = useAppStore((s) => s.setShapeKind);
  return (
    <Section title="Shape">
      <div className="fm-field">
        <label>Kind</label>
        <div className="fm-node-type-row">
          {SHAPE_KIND_OPTIONS.map(({ kind, label, icon: Icon }) => (
            <button
              key={kind}
              className={`fm-node-type-btn ${shapeKind === kind ? "active" : ""}`}
              onClick={() => setShapeKind(kind)}
              data-testid={`shape-panel-kind-${kind}`}
            >
              <Icon size={13} style={{ marginRight: 5, verticalAlign: -2 }} />
              {label}
            </button>
          ))}
        </div>
      </div>
      <InfoTip>
        Click-drag on the canvas to draw. Hold Shift to constrain to a square / circle / regular triangle. Stays on the Shape tool after releasing, so you can keep drawing more shapes in a row — switch to Select when you're ready to move/edit one.
      </InfoTip>
    </Section>
  );
}

function PencilPanel() {
  const pencilSmoothing = useAppStore((s) => s.pencilSmoothing);
  const setPencilSmoothing = useAppStore((s) => s.setPencilSmoothing);
  const pencilPostSmoothing = useAppStore((s) => s.pencilPostSmoothing);
  const setPencilPostSmoothing = useAppStore((s) => s.setPencilPostSmoothing);
  return (
    <Section title="Pencil">
      <Slider
        label="Smoothing"
        value={pencilPostSmoothing}
        min={0}
        max={1}
        step={0.05}
        onChange={setPencilPostSmoothing}
        format={(v) => `${Math.round(v * 100)}%`}
      />
      <Slider
        label="Stabilizer"
        value={pencilSmoothing}
        min={0}
        max={1}
        step={0.05}
        onChange={setPencilSmoothing}
        format={(v) => `${Math.round(v * 100)}%`}
      />
      <InfoTip>
        <strong>Smoothing</strong> — berapa smooth hasil akhir setelah selesai menggambar. Naikkan untuk kurva lebih bersih, turunkan untuk detail lebih tajam.{" "}
        <strong>Stabilizer</strong> — smoothing saat proses menggambar berlangsung. Biarkan rendah agar stroke mengikuti pointer secara natural.
      </InfoTip>
    </Section>
  );
}

function PenPanel() {
  const penMode = useAppStore((s) => s.penMode);
  const setPenMode = useAppStore((s) => s.setPenMode);
  const lineWidth = useAppStore((s) => s.lineWidth);
  const setLineWidth = useAppStore((s) => s.setLineWidth);
  const lineCap = useAppStore((s) => s.lineCap);
  const setLineCap = useAppStore((s) => s.setLineCap);
  const penAutoClose = useAppStore((s) => s.penAutoClose);
  const togglePenAutoClose = useAppStore((s) => s.togglePenAutoClose);
  return (
    <Section title="Pen">
      <div className="fm-field">
        <label>Mode</label>
        <div className="fm-node-type-row">
          <button className={`fm-node-type-btn ${penMode === "shape" ? "active" : ""}`} onClick={() => setPenMode("shape")}>Shape</button>
          <button className={`fm-node-type-btn ${penMode === "line" ? "active" : ""}`} onClick={() => setPenMode("line")}>Line</button>
        </div>
      </div>
      {penMode === "line" ? (
        <>
          <Slider label="Stroke Width" value={lineWidth} min={1} max={200} directInput onChange={setLineWidth} />
          <CapControl value={lineCap} onChange={setLineCap} />
          <InfoTip>Line mode makes an editable open centerline — a true monoline. Width and cap stay editable until you Expand it.</InfoTip>
        </>
      ) : (
        <>
          <label className="fm-checkbox-row" style={{ marginTop: 6 }} data-testid="pen-auto-close-toggle">
            <input type="checkbox" checked={penAutoClose} onChange={togglePenAutoClose} />
            Auto Close Shape
          </label>
          <InfoTip>
            {penAutoClose
              ? "On: previews as closed + filled while you draw. Click near the first node to finish it."
              : "Off: previews as an outline only until you click back onto the first node — then it closes and fills."}
          </InfoTip>
        </>
      )}
    </Section>
  );
}

/** Small set of ready-made taper shapes, the same idea as Figma's stroke
 * "Width profile" presets — pick a shape instead of reasoning about the
 * raw taper sliders. `sharpStart`/`sharpEnd` are what actually make the
 * three "Sharp" shapes true needle points (see taperFactor() in
 * strokeToOutline.ts): they remove that end's small rounded floor
 * entirely, so the ramp set by taperStart/taperEnd reaches genuine ~0
 * width on its own — no manual taper tuning required. The plain "Taper"
 * shapes keep the old soft/rounded floor, on purpose, as a gentler look. */
const WIDTH_PROFILE_PRESETS: { id: string; label: string; taperStart: number; taperEnd: number; sharpStart: boolean; sharpEnd: boolean }[] = [
  { id: "constant", label: "Constant", taperStart: 0, taperEnd: 0, sharpStart: false, sharpEnd: false },
  { id: "taper-start", label: "Taper start", taperStart: 0.28, taperEnd: 0, sharpStart: false, sharpEnd: false },
  { id: "taper-end", label: "Taper end", taperStart: 0, taperEnd: 0.28, sharpStart: false, sharpEnd: false },
  { id: "taper-both", label: "Taper both ends", taperStart: 0.2, taperEnd: 0.2, sharpStart: false, sharpEnd: false },
  { id: "sharp-start", label: "Sharp start", taperStart: 0.34, taperEnd: 0, sharpStart: true, sharpEnd: false },
  { id: "sharp-end", label: "Sharp end", taperStart: 0, taperEnd: 0.34, sharpStart: false, sharpEnd: true },
  { id: "sharp-both", label: "Sharp both ends", taperStart: 0.3, taperEnd: 0.3, sharpStart: true, sharpEnd: true },
];

/** Draws a little top-down preview of the stroke's width profile — reuses
 * the exact same taper curve the real stroke outline uses (including the
 * sharp/needle floors), so the icon is never out of sync with what drawing
 * will actually look like. */
function WidthProfileIcon({ taperStart, taperEnd, sharpStart, sharpEnd }: { taperStart: number; taperEnd: number; sharpStart: boolean; sharpEnd: boolean }) {
  const w = 56;
  const h = 22;
  const cy = h / 2;
  const maxHalf = h / 2 - 2;
  const steps = 28;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const half = maxHalf * taperFactor(t, taperStart, taperEnd, { sharpStart, sharpEnd });
    const x = t * w;
    top.push(`${x.toFixed(1)},${(cy - half).toFixed(1)}`);
    bottom.push(`${x.toFixed(1)},${(cy + half).toFixed(1)}`);
  }
  const points = [...top, ...bottom.reverse()].join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <polygon points={points} fill="currentColor" />
    </svg>
  );
}

/** Preset picker for the stroke's width profile, with the raw taper-length
 * sliders and the needle-sharp toggles tucked behind "Advanced" for anyone
 * who wants to hand-tune a shape none of the presets quite match — the
 * presets set good defaults, the advanced controls just fine-tune them. */
function WidthProfilePicker({ taperStart, taperEnd, sharpStart, sharpEnd, onChange }: {
  taperStart: number;
  taperEnd: number;
  sharpStart: boolean;
  sharpEnd: boolean;
  onChange: (v: { taperStart: number; taperEnd: number; sharpStart: boolean; sharpEnd: boolean }) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const close = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const activeId = WIDTH_PROFILE_PRESETS.find(
    (p) => close(p.taperStart, taperStart) && close(p.taperEnd, taperEnd) && p.sharpStart === sharpStart && p.sharpEnd === sharpEnd
  )?.id;

  return (
    <div className="fm-field">
      <label>Width Profile</label>
      <div className="fm-width-profile-grid" role="group" aria-label="Width profile" data-testid="width-profile-grid">
        {WIDTH_PROFILE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`fm-width-profile-btn ${activeId === p.id ? "active" : ""}`}
            title={p.label}
            aria-label={p.label}
            onClick={() => onChange({ taperStart: p.taperStart, taperEnd: p.taperEnd, sharpStart: p.sharpStart, sharpEnd: p.sharpEnd })}
            data-testid={`width-profile-${p.id}`}
          >
            <WidthProfileIcon taperStart={p.taperStart} taperEnd={p.taperEnd} sharpStart={p.sharpStart} sharpEnd={p.sharpEnd} />
          </button>
        ))}
      </div>
      <button type="button" className="fm-width-profile-advanced-toggle" onClick={() => setAdvancedOpen((o) => !o)}>
        {advancedOpen ? "Hide advanced" : "Edit width profile"}
        <ChevronDown size={12} className={`fm-section-caret ${advancedOpen ? "open" : ""}`} />
      </button>
      {advancedOpen && (
        <div className="fm-width-profile-advanced">
          <Slider label="Taper Start" value={taperStart} min={0} max={0.5} step={0.02}
            onChange={(v) => onChange({ taperStart: v, taperEnd, sharpStart, sharpEnd })} format={(v) => `${Math.round(v * 100)}%`} />
          <Slider label="Taper End" value={taperEnd} min={0} max={0.5} step={0.02}
            onChange={(v) => onChange({ taperStart, taperEnd: v, sharpStart, sharpEnd })} format={(v) => `${Math.round(v * 100)}%`} />
          <label className="fm-checkbox-row">
            <input type="checkbox" checked={sharpStart} onChange={(e) => onChange({ taperStart, taperEnd, sharpStart: e.target.checked, sharpEnd })} />
            Needle-sharp start
          </label>
          <label className="fm-checkbox-row">
            <input type="checkbox" checked={sharpEnd} onChange={(e) => onChange({ taperStart, taperEnd, sharpStart, sharpEnd: e.target.checked })} />
            Needle-sharp end
          </label>
        </div>
      )}
    </div>
  );
}

function BrushPanel() {
  const brush = useAppStore((s) => s.brush);
  const setBrushType = useAppStore((s) => s.setBrushType);
  const setBrush = useAppStore((s) => s.setBrush);
  const brushCap = useAppStore((s) => s.brushCap);
  const setBrushCap = useAppStore((s) => s.setBrushCap);

  return (
    <>
      <Section title="Brush Preset">
        <div className="fm-brush-grid" data-testid="brush-grid">
          {BRUSH_ORDER.map((id) => {
            const Icon = BRUSH_ICON[id];
            const p = BRUSH_PRESETS[id];
            return (
              <button key={id} className={`fm-brush-card ${brush.type === id ? "active" : ""}`} onClick={() => setBrushType(id)}
                data-testid={`brush-${id}`}>
                <span className="fm-brush-icon"><Icon size={17} strokeWidth={1.8} /></span>
                <span className="fm-brush-name">{p.label}</span>
              </button>
            );
          })}
        </div>
      </Section>
      <Section title="Stroke Settings">
        <Slider label="Size" value={brush.size} min={1} max={200} directInput onChange={(v) => setBrush({ size: v })} />
        {brush.type === "monoline" && <CapControl value={brushCap} onChange={setBrushCap} />}
        <Slider label="Stabilizer" value={brush.stabilizer ?? 0} min={0} max={1} step={0.05} onChange={(v) => setBrush({ stabilizer: v })} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Spacing" value={brush.spacing} min={1} max={20} onChange={(v) => setBrush({ spacing: v })} />
        <Slider label="Smoothing" value={brush.smoothing} min={0} max={1} step={0.05} onChange={(v) => setBrush({ smoothing: v })} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Roundness" value={brush.roundness} min={0.1} max={1} step={0.05} onChange={(v) => setBrush({ roundness: v })} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Angle" value={brush.angle} min={0} max={180} onChange={(v) => setBrush({ angle: v })} format={(v) => `${Math.round(v)}°`} />
        <WidthProfilePicker
          taperStart={brush.taperStart}
          taperEnd={brush.taperEnd}
          sharpStart={brush.sharpStart ?? false}
          sharpEnd={brush.sharpEnd ?? false}
          onChange={({ taperStart, taperEnd, sharpStart, sharpEnd }) => setBrush({ taperStart, taperEnd, sharpStart, sharpEnd })}
        />
        <label className="fm-checkbox-row" style={{ marginTop: 6 }}>
          <input type="checkbox" checked={brush.pressureEnabled} onChange={(e) => setBrush({ pressureEnabled: e.target.checked })} />
          Stylus pressure drives width
        </label>
        {brush.pressureEnabled && (
          <>
            <Slider
              label="Pressure Sensitivity"
              value={brush.pressureSensitivity ?? 0}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => setBrush({ pressureSensitivity: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <InfoTip>
              Real pressure only — Apple Pencil and other styluses. Mouse, trackpad, and touch always draw at Size.
            </InfoTip>
          </>
        )}
      </Section>
    </>
  );
}

/** Reads an uploaded ghost reference image into a data URL and its natural
 * width/height ratio, so the custom ghost renders without stretching. */
function readGhostImageFile(file: File): Promise<{ src: string; aspect: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result as string;
      const img = new Image();
      img.onload = () => resolve({ src, aspect: img.naturalWidth / img.naturalHeight || 1 });
      img.onerror = () => resolve({ src, aspect: 1 });
      img.src = src;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function GhostGlyphSection() {
  const ghost = useAppStore((s) => s.ghost);
  const setGhost = useAppStore((s) => s.setGhost);
  const metrics = useAppStore((s) => s.metrics);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  const handleImageFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpe?g)$/.test(file.type)) {
      setImageError("Choose a JPG or PNG image.");
      return;
    }
    try {
      const { src, aspect } = await readGhostImageFile(file);
      setGhost({ imageSrc: src, imageAspect: aspect, mode: "image" });
      setImageError(null);
    } catch {
      setImageError("Unable to read that image.");
    }
  };

  return (
    <Section title="Ghost Reference Canvas" defaultOpen={false}>
      <label className="fm-checkbox-row">
        <input type="checkbox" checked={ghost.enabled} onChange={(e) => setGhost({ enabled: e.target.checked })} data-testid="ghost-enabled" />
        Show ghost reference
      </label>
      {ghost.enabled && (
        <>
          <div className="fm-field">
            <label>Mode</label>
            <div className="fm-kern-mode-toggle fm-ghost-mode-toggle" role="group" aria-label="Ghost reference mode">
              <button
                type="button"
                className={ghost.mode === "sample" ? "active" : ""}
                onClick={() => setGhost({ mode: "sample" })}
                aria-pressed={ghost.mode === "sample"}
                data-testid="ghost-mode-sample"
              >
                Single Ghost
              </button>
              <button
                type="button"
                className={ghost.mode === "family" ? "active" : ""}
                onClick={() => setGhost({ mode: "family" })}
                aria-pressed={ghost.mode === "family"}
                data-testid="ghost-mode-family"
              >
                Family Ghost
              </button>
              <button
                type="button"
                className={ghost.mode === "image" ? "active" : ""}
                onClick={() => setGhost({ mode: "image" })}
                aria-pressed={ghost.mode === "image"}
                data-testid="ghost-mode-image"
              >
                Custom Image
              </button>
            </div>
          </div>
          <Slider label="Opacity" value={ghost.opacity} min={0.02} max={0.4} step={0.01} onChange={(v) => setGhost({ opacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <Slider label="Scale" value={ghost.scale} min={0.5} max={1.5} step={0.02} onChange={(v) => setGhost({ scale: v })} format={(v) => `${Math.round(v * 100)}%`} />
          {/* Offset X/Y used to be hardcoded to ±200 units regardless of the
              font's UPM — on a standard 1000-UPM font that's only ±20% of
              the canvas width, so the ghost letter could never actually
              reach the canvas edges. Tying the range to unitsPerEm instead
              means the full canvas is always reachable, at any UPM. */}
          <Slider label="Offset X" value={ghost.offsetX} min={-metrics.unitsPerEm} max={metrics.unitsPerEm} onChange={(v) => setGhost({ offsetX: v })} />
          <Slider label="Offset Y" value={ghost.offsetY} min={-metrics.unitsPerEm} max={metrics.unitsPerEm} onChange={(v) => setGhost({ offsetY: v })} />

          {ghost.mode === "image" && (
            <div className="fm-field fm-ghost-image-field">
              <label>Custom Ghost Image</label>
              {ghost.imageSrc ? (
                <div className="fm-ghost-image-preview">
                  <img src={ghost.imageSrc} alt="Custom ghost reference" data-testid="ghost-image-preview" />
                  <div className="fm-ghost-image-actions">
                    <button
                      type="button"
                      className="fm-action-btn"
                      onClick={() => fileInputRef.current?.click()}
                      data-testid="ghost-image-replace"
                    >
                      <ImagePlus size={13} /> Replace
                    </button>
                    <button
                      type="button"
                      className="fm-action-btn danger"
                      onClick={() => { setGhost({ imageSrc: null, imageAspect: undefined }); setImageError(null); }}
                      data-testid="ghost-image-remove"
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="fm-action-btn"
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="ghost-image-upload"
                >
                  <ImagePlus size={13} /> Upload Image
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg"
                hidden
                onChange={(e) => {
                  void handleImageFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
                data-testid="ghost-image-input"
              />
              {imageError && <div className="fm-hint fm-ghost-image-error">{imageError}</div>}
            </div>
          )}

          <InfoTip>
            {ghost.mode === "sample"
              ? "One built-in sample reference, centered on the editable canvas."
              : ghost.mode === "family"
                ? "Two side references from matching saved family vectors. Undrawn styles stay empty."
                : "Upload a JPG or PNG to use as a reference behind the canvas. It's for tracing only and never becomes part of your glyph vectors."}
          </InfoTip>
        </>
      )}
    </Section>
  );
}

const CAP_LABELS: Record<StrokeCap, string> = { round: "Round Cap", butt: "Butt Cap", square: "Square Cap" };

function CapControl({ value, onChange }: { value: StrokeCap; onChange: (cap: StrokeCap) => void }) {
  return (
    <div className="fm-field">
      <label>Stroke Cap</label>
      <div className="fm-cap-control" role="group" aria-label="Stroke cap">
        {(["round", "butt", "square"] as StrokeCap[]).map((cap) => (
          <button
            key={cap}
            className={`fm-cap-btn ${value === cap ? "active" : ""}`}
            onClick={() => onChange(cap)}
            title={CAP_LABELS[cap]}
            aria-label={CAP_LABELS[cap]}
            data-testid={`cap-${cap}`}
          >
            <span className={`fm-cap-icon ${cap}`} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}

function NumField({ label, value, onChange, testid }: { label: string; value: number; onChange: (v: number) => void; testid?: string }) {
  return (
    <div className="fm-field">
      <label>{label}</label>
      <NumericInput value={value} onChange={onChange} data-testid={testid} />
    </div>
  );
}

export function Slider({ label, value, min, max, step = 1, onChange, format, directInput = false, labelAdornment }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  directInput?: boolean;
  /** Optional small control (e.g. a lock toggle) rendered right next to the
   * label, on the same side, so the existing label ↔ value space-between
   * layout is untouched. */
  labelAdornment?: ReactNode;
}) {
  const apply = (raw: number) => {
    if (!Number.isFinite(raw)) return;
    onChange(Math.min(max, Math.max(min, raw)));
  };

  return (
    <div className="fm-field">
      <div className="fm-slider-row-label">
        <span className="fm-slider-label-group">
          <label>{label}</label>
          {labelAdornment}
        </span>
        {directInput ? (
          <NumericInput
            className="fm-slider-number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={apply}
            aria-label={`${label} value`}
          />
        ) : (
          <span>{format ? format(value) : Math.round(value)}</span>
        )}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => apply(Number(e.target.value))}
        style={{ ["--fm-range-fill" as string]: `${((Math.min(max, Math.max(min, value)) - min) / (max - min || 1)) * 100}%` }}
      />
    </div>
  );
}
