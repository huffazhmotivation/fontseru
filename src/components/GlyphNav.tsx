import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { CheckSquare, Lock, Plus, Search, X, Zap, Globe } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { useAuth } from "@/auth/AuthProvider";
import { GLYPH_GROUPS } from "@/glyph/defaultGlyphs";
import { withoutDrawGlyph } from "@/glyph/drawMode";
import { FONT_STYLES, MAX_CUSTOM_FAMILIES, type Glyph, type GlyphCategory, type GlyphMap } from "@/types/glyph";
import { countDrawnGlyphsCached, hasOutlineCached } from "@/editor/outlineCache";
import { unicodeHex } from "@/utils/unicode";
import { GlyphThumbnail } from "./GlyphThumbnail";
import { DRAWING_DRAG_TYPE } from "./drawingDrag";

// Bold/Italic keep these reserved ids (see the store's defaultCustomFamilies)
// so they can stay PRO-gated like before, even though they're now ordinary
// entries in `customFamilies` rather than permanent built-ins.
function isReservedStyleId(id: string): id is "bold" | "italic" {
  return id === "bold" || id === "italic";
}


interface NavGroup {
  id: GlyphCategory;
  label: string;
  chars: string[];
}

/** Groups the glyph map the way the list shows it: the fixed GLYPH_GROUPS
 *  order first, extras appended to their own category sorted by code
 *  point, anything left over under "Imported". */
function groupGlyphs(glyphs: GlyphMap): NavGroup[] {
  const baseChars = new Set(GLYPH_GROUPS.flatMap((g) => g.chars));
  const extrasByCategory = new Map<string, string[]>();
  for (const [ch, glyph] of Object.entries(glyphs)) {
    if (baseChars.has(ch)) continue;
    const arr = extrasByCategory.get(glyph.category) ?? [];
    arr.push(ch);
    extrasByCategory.set(glyph.category, arr);
  }
  const groups: NavGroup[] = GLYPH_GROUPS.map((g) => ({
    ...g,
    chars: [...g.chars.filter((ch) => Boolean(glyphs[ch])), ...(extrasByCategory.get(g.id) ?? []).sort((a, b) => glyphs[a].unicode - glyphs[b].unicode)],
  })).filter((g) => g.chars.length > 0);
  const assigned = new Set(groups.flatMap((g) => g.chars));
  const remaining = Object.keys(glyphs).filter((ch) => !assigned.has(ch)).sort((a, b) => glyphs[a].unicode - glyphs[b].unicode);
  return remaining.length ? [...groups, { id: "symbols" as const, label: "Imported", chars: remaining }] : groups;
}

/** True when `next` has exactly the same keys as `prev`, each with the
 *  same category and code point — i.e. only outlines/metrics changed, so
 *  the grouping (and its sort) can be reused as-is. O(n), no allocation. */
function sameGrouping(prev: GlyphMap, prevCount: number, next: GlyphMap): boolean {
  let n = 0;
  for (const ch in next) {
    const a = prev[ch];
    const b = next[ch];
    if (!a || a.category !== b.category || a.unicode !== b.unicode) return false;
    n++;
  }
  return n === prevCount;
}

/** Lowercased search fields, cached per glyph object so typing a query
 *  never re-normalizes thousands of unchanged glyphs. */
const searchMetaCache = new WeakMap<Glyph, { lower: string; hex: string; name: string }>();
function searchMetaFor(ch: string, glyph: Glyph) {
  let meta = searchMetaCache.get(glyph);
  if (!meta) {
    meta = { lower: ch.toLowerCase(), hex: unicodeHex(glyph.unicode).toLowerCase(), name: (glyph.name ?? "").toLowerCase() };
    searchMetaCache.set(glyph, meta);
  }
  return meta;
}

/* ------------------------------------------------------------------ *
 * Virtualized list
 *
 * Imported fonts routinely put thousands of glyphs into ONE group, so
 * per-group `content-visibility` never skipped anything: every tile (a
 * button plus an SVG thumbnail) was mounted and diffed on every glyph
 * switch. The list is now flattened into rows — one row per group header
 * and one per line of tiles — and only rows near the viewport are
 * mounted. Row geometry is MEASURED from the real CSS (column count, tile
 * size, row gap, header height incl. margins) through a hidden probe, so
 * the existing media-query breakpoints (3/4/5 columns, tighter gaps)
 * keep working without being duplicated here.
 * ------------------------------------------------------------------ */

interface ListMetrics {
  cols: number;
  tile: number;
  gap: number;
  header: number;
}

const DEFAULT_METRICS: ListMetrics = { cols: 4, tile: 50, gap: 7, header: 38 };
/** Extra pixels mounted above/below the viewport so fast scrolling and
 *  the hover lift never reveal an empty strip. */
const OVERSCAN_PX = 360;

type NavRow =
  | { kind: "header"; key: string; group: NavGroup; top: number; height: number }
  | { kind: "tiles"; key: string; chars: string[]; top: number; height: number };

function buildRows(groups: NavGroup[], m: ListMetrics): { rows: NavRow[]; total: number; rowOfChar: Map<string, number> } {
  const rows: NavRow[] = [];
  const rowOfChar = new Map<string, number>();
  let y = 0;
  groups.forEach((g, gi) => {
    const gk = `${gi}:${g.id}:${g.label}`;
    rows.push({ kind: "header", key: `h:${gk}`, group: g, top: y, height: m.header });
    y += m.header;
    for (let i = 0, r = 0; i < g.chars.length; i += m.cols, r++) {
      if (r > 0) y += m.gap;
      const chars = g.chars.slice(i, i + m.cols);
      const rowIndex = rows.length;
      for (const ch of chars) rowOfChar.set(ch, rowIndex);
      rows.push({ kind: "tiles", key: `t:${gk}:${r}`, chars, top: y, height: m.tile });
      y += m.tile;
    }
  });
  return { rows, total: y, rowOfChar };
}

/** First row whose bottom edge is at or below `y`. */
function firstRowAt(rows: NavRow[], y: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top + rows[mid].height < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface GlyphTileProps {
  ch: string;
  glyph: Glyph;
  active: boolean;
  selected: boolean;
  flashed: boolean;
}

/** One tile. Memoized on primitive props + the (stable) glyph object, so
 *  switching the active glyph re-renders exactly two tiles. Clicks and
 *  drops are handled once on the list container via `data-char`. */
const GlyphTile = memo(function GlyphTile({ ch, glyph, active, selected, flashed }: GlyphTileProps) {
  const done = hasOutlineCached(glyph);
  return (
    <button
      className={`fm-tile ${active ? "active" : ""} ${done ? "done" : ""} ${selected ? "selected" : ""} ${flashed ? "fm-trace-tile-applied" : ""}`}
      title={`${ch === " " ? "Space" : ch} — ${unicodeHex(glyph.unicode)}`}
      data-char={ch}
      data-testid={`glyph-tile-${ch}`}
    >
      {done && <span className="fm-tile-dot" />}
      <span className="fm-tile-thumb"><GlyphThumbnail glyph={glyph} /></span>
    </button>
  );
});

function charFromEvent(e: { target: EventTarget; currentTarget: Element }): string | null {
  const el = (e.target as Element | null)?.closest?.("[data-char]") as HTMLElement | null;
  if (!el || !e.currentTarget.contains(el)) return null;
  return el.dataset.char ?? null;
}

export function GlyphNavInner() {
  const [query, setQuery] = useState("");
  const rawGlyphs = useAppStore((s) => s.glyphs);
  // Drawing Mode keeps its sketch in the glyph map under a reserved key —
  // the glyph list must never show or count it.
  const glyphs = useMemo(() => withoutDrawGlyph(rawGlyphs), [rawGlyphs]);
  const deferredGlyphs = useDeferredValue(glyphs);
  const activeChar = useAppStore((s) => s.activeChar);
  const editorMode = useAppStore((s) => s.editorMode);
  const drawMode = editorMode === "draw";
  const drawTargetChar = useAppStore((s) => s.drawTargetChar);
  const drawApplied = useAppStore((s) => s.drawApplied);
  const applyDrawingToGlyph = useAppStore((s) => s.applyDrawingToGlyph);
  const fontStyle = useAppStore((s) => s.fontStyle);
  const setFontStyle = useAppStore((s) => s.setFontStyle);
  const customFamilies = useAppStore((s) => s.customFamilies);
  const addCustomFamily = useAppStore((s) => s.addCustomFamily);
  const removeCustomFamily = useAppStore((s) => s.removeCustomFamily);
  const generateFromRegular = useAppStore((s) => s.generateFromRegular);
  const openProModal = useAppStore((s) => s.openProModal);
  const addMultilingualGlyphs = useAppStore((s) => s.addMultilingualGlyphs);
  const glyphSelectMode = useAppStore((s) => s.glyphSelectMode);
  const setGlyphSelectMode = useAppStore((s) => s.setGlyphSelectMode);
  const selectedGlyphChars = useAppStore((s) => s.selectedGlyphChars);
  const selectedSet = useMemo(() => new Set(selectedGlyphChars), [selectedGlyphChars]);
  const setGlyphSelection = useAppStore((s) => s.setGlyphSelection);
  const addGlyphsToSelection = useAppStore((s) => s.addGlyphsToSelection);
  const clearGlyphSelection = useAppStore((s) => s.clearGlyphSelection);
  const { isPro } = useAuth();
  const [multilingualStatus, setMultilingualStatus] = useState<string | null>(null);
  const [addingFamily, setAddingFamily] = useState(false);
  const [newFamilyName, setNewFamilyName] = useState("");
  const newFamilyInputRef = useRef<HTMLInputElement>(null);

  const canAddFamily = customFamilies.length < MAX_CUSTOM_FAMILIES;

  const startAddFamily = () => {
    if (!isPro) { openProModal("family"); return; }
    if (!canAddFamily) return;
    setNewFamilyName("");
    setAddingFamily(true);
    window.setTimeout(() => newFamilyInputRef.current?.focus(), 0);
  };

  const cancelAddFamily = () => {
    setAddingFamily(false);
    setNewFamilyName("");
  };

  const submitAddFamily = (event: FormEvent) => {
    event.preventDefault();
    const created = addCustomFamily(newFamilyName);
    if (created) cancelAddFamily();
  };

  const deleteFamily = (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This removes its tab and all drawn glyphs, and cannot be undone.`)) return;
    removeCustomFamily(id);
  };

  const runAddMultilingual = () => {
    const result = addMultilingualGlyphs();
    const parts: string[] = [];
    if (result.created > 0) parts.push(`${result.created} glyph${result.created === 1 ? "" : "s"} added`);
    const markSlots = result.markSlotsAdded + result.symbolSlotsAdded;
    if (markSlots > 0) parts.push(`${markSlots} accent mark${markSlots === 1 ? "" : "s"} ready to draw`);
    if (result.letterSlotsAdded > 0) {
      parts.push(`${result.letterSlotsAdded} letter${result.letterSlotsAdded === 1 ? "" : "s"} ready to draw`);
    }
    setMultilingualStatus(parts.length > 0 ? parts.join(" · ") : "Nothing new — draw more accent marks first");
    window.setTimeout(() => setMultilingualStatus(null), 4000);
  };

  const totalCount = Object.keys(glyphs).length;
  const doneCount = useMemo(() => countDrawnGlyphsCached(glyphs), [glyphs]);

  // Grouping is reused across commits that only change outlines (every
  // stroke), so its sort runs only when glyphs are added/removed/re-coded.
  const groupingRef = useRef<{ glyphs: GlyphMap; count: number; groups: NavGroup[] } | null>(null);
  const allGroups = useMemo(() => {
    const prev = groupingRef.current;
    if (prev && (prev.glyphs === deferredGlyphs || sameGrouping(prev.glyphs, prev.count, deferredGlyphs))) {
      groupingRef.current = { ...prev, glyphs: deferredGlyphs };
      return prev.groups;
    }
    const groups = groupGlyphs(deferredGlyphs);
    groupingRef.current = { glyphs: deferredGlyphs, count: Object.keys(deferredGlyphs).length, groups };
    return groups;
  }, [deferredGlyphs]);

  const deferredQuery = useDeferredValue(query);
  const filteredGroups = useMemo(() => {
    if (!deferredQuery.trim()) return allGroups;
    const q = deferredQuery.trim().toLowerCase();
    return allGroups.map((g) => ({
      ...g,
      chars: g.chars.filter((ch) => {
        const glyph = deferredGlyphs[ch];
        if (!glyph) return false;
        const meta = searchMetaFor(ch, glyph);
        if (meta.lower === q) return true;
        return meta.hex.includes(q) || meta.name.includes(q);
      }),
    })).filter((g) => g.chars.length > 0);
  }, [deferredQuery, allGroups, deferredGlyphs]);

  // ---------------------------------------------------- virtualization
  const listRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<ListMetrics>(DEFAULT_METRICS);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const scrollRafRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    const list = listRef.current;
    const probe = probeRef.current;
    if (!list || !probe) return;
    setViewport((v) => (v.height === list.clientHeight && v.top === list.scrollTop ? v : { top: list.scrollTop, height: list.clientHeight }));
    const header = probe.children[0] as HTMLElement | undefined;
    const grid = probe.children[1] as HTMLElement | undefined;
    const tile = grid?.firstElementChild as HTMLElement | null | undefined;
    if (!header || !grid || !tile) return;
    const tileH = tile.getBoundingClientRect().height;
    // Panel hidden (collapsed mobile drawer): keep the last good numbers.
    if (!(tileH > 0)) return;
    const cs = getComputedStyle(grid);
    const cols = Math.max(1, cs.gridTemplateColumns.split(" ").filter(Boolean).length);
    const gap = parseFloat(cs.rowGap) || 0;
    const headerH = header.getBoundingClientRect().height;
    setMetrics((m) =>
      m.cols === cols && Math.abs(m.tile - tileH) < 0.01 && Math.abs(m.gap - gap) < 0.01 && Math.abs(m.header - headerH) < 0.01
        ? m
        : { cols, tile: tileH, gap, header: headerH }
    );
  }, []);

  useLayoutEffect(() => {
    measure();
    const list = listRef.current;
    if (!list) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(list);
    if (probeRef.current) ro.observe(probeRef.current);
    return () => ro.disconnect();
  }, [measure]);
  // The header probe carries the "Pilih semua" button only in select mode.
  useLayoutEffect(() => { measure(); }, [glyphSelectMode, measure]);

  useEffect(() => () => {
    if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
  }, []);

  const onListScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const list = listRef.current;
      if (!list) return;
      setViewport((v) => (v.top === list.scrollTop && v.height === list.clientHeight ? v : { top: list.scrollTop, height: list.clientHeight }));
    });
  }, []);

  const { rows, total, rowOfChar } = useMemo(() => buildRows(filteredGroups, metrics), [filteredGroups, metrics]);

  const visibleRows = useMemo(() => {
    const out: NavRow[] = [];
    const end = viewport.top + viewport.height + OVERSCAN_PX;
    for (let i = firstRowAt(rows, viewport.top - OVERSCAN_PX); i < rows.length && rows[i].top <= end; i++) out.push(rows[i]);
    return out;
  }, [rows, viewport]);

  // Keep the active glyph in view when it changes from elsewhere (stepper,
  // canvas, keyboard). A tile that is already on screen never moves.
  const focusChar = drawMode ? drawTargetChar : activeChar;
  const layoutRef = useRef({ rows, rowOfChar });
  layoutRef.current = { rows, rowOfChar };
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !focusChar) return;
    const { rows: rs, rowOfChar: idx } = layoutRef.current;
    const ri = idx.get(focusChar);
    if (ri === undefined) return;
    const row = rs[ri];
    const top = list.scrollTop;
    const h = list.clientHeight;
    if (row.top >= top && row.top + row.height <= top + h) return;
    list.scrollTop = row.top < top ? row.top - 8 : row.top + row.height - h + 8;
  }, [focusChar]);

  const onTileClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const ch = charFromEvent(e);
      if (ch === null) return;
      const s = useAppStore.getState();
      if (s.glyphSelectMode && s.editorMode !== "draw") s.toggleGlyphSelected(ch);
      else {
        s.setActiveChar(ch);
        s.closeMobilePanels();
      }
    },
    []
  );
  const onTileDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (charFromEvent(e) === null) return;
    if (e.dataTransfer.types.includes(DRAWING_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);
  const onTileDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      const ch = charFromEvent(e);
      if (ch === null || !e.dataTransfer.types.includes(DRAWING_DRAG_TYPE)) return;
      e.preventDefault();
      applyDrawingToGlyph(ch);
    },
    [applyDrawingToGlyph]
  );

  return (
    <div className="fm-glyphnav" data-testid="glyph-nav">
      <div className="fm-glyphnav-head">
        <div className="fm-glyphnav-eyebrow-row">
          <span className="fm-panel-eyebrow">Glyphs</span>
          <div className="fm-glyphnav-eyebrow-right">
            <span
              className="fm-glyph-count-badge"
              title={`${doneCount} dari ${totalCount} glyph sudah digambar`}
              data-testid="glyph-done-count"
            >
              {doneCount}/{totalCount}
            </span>
            {!drawMode && <button
              type="button"
              className={`fm-glyph-select-toggle ${glyphSelectMode ? "on" : ""}`}
              onClick={() => setGlyphSelectMode(!glyphSelectMode)}
              title={glyphSelectMode ? "Selesai memilih" : "Pilih beberapa glyph sekaligus"}
              data-testid="glyph-select-toggle"
            >
              <CheckSquare size={13} />
              <span>{glyphSelectMode ? "Selesai" : "Select"}</span>
            </button>}
          </div>
        </div>

        <div className="fm-family-tabs" role="tablist" aria-label="Font family style" data-testid="family-tabs">
          {/* Regular is the only permanent tab — always free, never removable. */}
          {FONT_STYLES.map((style) => (
            <button
              key={style.id}
              type="button"
              role="tab"
              aria-selected={fontStyle === style.id}
              className={fontStyle === style.id ? "active" : ""}
              onClick={() => setFontStyle(style.id)}
              data-testid={`family-tab-${style.id}`}
            >
              {style.label}
            </button>
          ))}
          {customFamilies.map((family) => {
            // Bold/Italic keep their PRO gate even though they're just
            // regular family entries now: locked tabs stay visible (dimmed
            // + lock icon) and tapping opens the ProUpsellModal instead of
            // switching styles — the actual switch is also blocked at the
            // store level (setFontStyle) so this is UI polish, not the
            // only line of defense. Any other custom family was already
            // PRO-gated at creation time, so it never needs this here.
            const locked = isReservedStyleId(family.id) && !isPro;
            return (
              <button
                key={family.id}
                type="button"
                role="tab"
                aria-selected={fontStyle === family.id}
                className={`fm-family-tab-custom ${fontStyle === family.id ? "active" : ""} ${locked ? "fm-family-tab-locked" : ""}`}
                onClick={() => (locked ? openProModal("family") : setFontStyle(family.id))}
                title={locked ? `${family.name} (PRO)` : family.name}
                data-testid={`family-tab-${family.id}`}
              >
                <span className="fm-family-tab-custom-label">{family.name}</span>
                {locked && <Lock size={10} className="fm-lock-badge-inline" />}
                {!locked && (
                  <span
                    className="fm-family-tab-remove"
                    role="button"
                    tabIndex={0}
                    title={`Remove ${family.name}`}
                    onClick={(event) => { event.stopPropagation(); deleteFamily(family.id, family.name); }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.stopPropagation();
                        event.preventDefault();
                        deleteFamily(family.id, family.name);
                      }
                    }}
                    data-testid={`family-tab-remove-${family.id}`}
                  >
                    <X size={10} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {addingFamily ? (
          <form className="fm-family-add-form" onSubmit={submitAddFamily} data-testid="add-family-form">
            <input
              ref={newFamilyInputRef}
              value={newFamilyName}
              onChange={(e) => setNewFamilyName(e.target.value)}
              placeholder="Family name…"
              maxLength={40}
              spellCheck={false}
              data-testid="add-family-input"
            />
            <button type="submit" className="fm-family-add-confirm" disabled={!newFamilyName.trim()} title="Create family" data-testid="add-family-confirm">
              <Plus size={13} />
            </button>
            <button type="button" className="fm-family-add-cancel" onClick={cancelAddFamily} title="Cancel" data-testid="add-family-cancel">
              <X size={13} />
            </button>
          </form>
        ) : (
          <button
            type="button"
            className={`fm-action-btn fm-family-add-btn ${!isPro || !canAddFamily ? "fm-action-btn-locked" : ""}`}
            onClick={startAddFamily}
            title={
              !isPro
                ? "Add Family (PRO)"
                : !canAddFamily
                  ? `Maximum ${MAX_CUSTOM_FAMILIES} custom families`
                  : "Add a new Glyph tab"
            }
            data-testid="add-family-btn"
          >
            <Plus size={14} />
            <span>Add Family</span>
            {!isPro && <Lock size={12} className="fm-lock-badge-inline" />}
          </button>
        )}

        {fontStyle !== "regular" && (
          <button
            type="button"
            className={`fm-action-btn accent fm-family-generate ${!isPro ? "fm-action-btn-locked" : ""}`}
            onClick={() => (isPro ? generateFromRegular() : openProModal("family"))}
            data-testid="generate-from-regular"
          >
            <Zap size={15} fill="currentColor" />
            <span>Generate From Regular</span>
            {!isPro && <Lock size={12} className="fm-lock-badge-inline" />}
          </button>
        )}

        <div className="fm-search">
          <Search size={14} />
          <input
            placeholder="Search glyph or U+…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            data-testid="glyph-search"
          />
        </div>
      </div>
      <div className="fm-glyphlist" ref={listRef} onScroll={onListScroll}>
        <div
          className="fm-glyphlist-inner"
          style={{ height: total }}
          onClick={onTileClick}
          onDragOver={drawMode ? onTileDragOver : undefined}
          onDrop={drawMode ? onTileDrop : undefined}
        >
          {/* Hidden probe: one header + one tile row styled by the real CSS,
              read back to size the virtual rows (see "Virtualized list"). */}
          <div className="fm-glyphlist-probe" ref={probeRef} aria-hidden="true">
            <div className="fm-glyphlist-header">
              <div className="fm-group-label-row">
                <div className="fm-group-label">Aa</div>
                {glyphSelectMode && <button type="button" className="fm-group-select-all" tabIndex={-1}>Pilih semua</button>}
              </div>
            </div>
            <div className="fm-grid fm-grid-row">
              <button type="button" className="fm-tile" tabIndex={-1} />
            </div>
          </div>
          {visibleRows.map((row) => {
            if (row.kind === "header") {
              const g = row.group;
              const groupChars = g.chars;
              const allInGroupSelected = glyphSelectMode && groupChars.length > 0 && groupChars.every((ch) => selectedSet.has(ch));
              return (
                <div key={row.key} className="fm-glyphlist-header" style={{ top: row.top, height: row.height }}>
                  <div className="fm-group-label-row">
                    <div className="fm-group-label">{g.label}</div>
                    {glyphSelectMode && groupChars.length > 0 && (
                      <button
                        type="button"
                        className="fm-group-select-all"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (allInGroupSelected) {
                            const inGroup = new Set(groupChars);
                            setGlyphSelection(selectedGlyphChars.filter((ch) => !inGroup.has(ch)));
                          } else addGlyphsToSelection(groupChars);
                        }}
                        data-testid={`glyph-group-select-${g.id}`}
                      >
                        {allInGroupSelected ? "Batal" : "Pilih semua"}
                      </button>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div key={row.key} className="fm-grid fm-grid-row" style={{ top: row.top, height: row.height }}>
                {row.chars.map((ch) => {
                  const info = deferredGlyphs[ch];
                  if (!info) return null;
                  const flashed = drawMode && drawApplied?.char === ch;
                  return (
                    <GlyphTile
                      key={ch + (flashed ? `:${drawApplied?.nonce}` : "")}
                      ch={ch}
                      glyph={info}
                      active={drawMode ? drawTargetChar === ch : activeChar === ch && !glyphSelectMode}
                      selected={selectedSet.has(ch)}
                      flashed={flashed}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
        {filteredGroups.length === 0 && (
          <div className="fm-hint" style={{ padding: "10px 4px" }}>No glyph matches “{query}”.</div>
        )}
      </div>
      {glyphSelectMode && selectedGlyphChars.length > 0 && (
        <div className="fm-glyph-select-hint" data-testid="glyph-select-hint">
          <span className="fm-glyph-batch-count">{selectedGlyphChars.length}</span>
          <span>glyph dipilih — atur brush di panel Brush untuk terapkan ke semuanya sekaligus</span>
          <button type="button" className="fm-glyph-select-clear" onClick={clearGlyphSelection} data-testid="glyph-select-clear">
            Batal pilih
          </button>
        </div>
      )}
      {!drawMode && <div className="fm-glyphnav-foot">
        <button
          type="button"
          className="fm-action-btn accent"
          onClick={runAddMultilingual}
          title="Compose accented letters (É, ü, ñ…) from glyphs you've already drawn"
          data-testid="add-multilingual-btn"
        >
          <Globe size={14} /> + Multilingual Glyphs
        </button>
        {multilingualStatus && (
          <div className="fm-hint" style={{ padding: "6px 4px 0" }} data-testid="add-multilingual-status">
            {multilingualStatus}
          </div>
        )}
      </div>}
    </div>
  );
}

export const GlyphNav = memo(GlyphNavInner);
