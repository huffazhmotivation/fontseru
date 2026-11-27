import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Minus, Plus, Search } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { GlyphRun } from "@/editor/GlyphRun";
import type { GlyphMap } from "@/types/glyph";
import { effectiveKerningPairs, kerningKey, type KerningContext, type KerningPairs } from "@/types/kerning";
import {
  analyseDictionary,
  buildDictionaryGroups,
  needsCheckThreshold,
  pairDeviation,
  pairId,
  type DictGroup,
  type DictGroupId,
  type PairResult,
} from "@/kerning/kerningDictionary";

type Filter = "warn" | "all" | "ok";
const PAGE = 60;
const NUDGE = 10;

interface Item {
  l: string;
  r: string;
  res: PairResult;
  cur: number;
  warn: boolean;
  ok: boolean;
  dev: number;
}

export interface DictPair {
  left: string;
  right: string;
}

/**
 * Test Lab → "Kamus Kerning".
 *
 * Every pair of the glyphs you have drawn, in the standard proofing groups,
 * each shown between control letters (HH·AV·HH). The pairs whose spacing
 * stands out are listed first ("Perlu dicek", see kerning/kerningDictionary).
 * Click a pair to select it — the right-hand Kerning panel then edits that
 * exact pair — nudge it with − / +, take the suggestion, or tick it as done.
 */
export function KerningDictionary({
  context,
  bg,
  selected,
  onSelect,
}: {
  context: KerningContext;
  bg: "dark" | "light";
  selected: DictPair | null;
  onSelect: (pair: DictPair) => void;
}) {
  const styleKey = context === "shared" ? "regular" : context;
  const glyphs = useAppStore((s) => s.glyphsByStyle[styleKey] ?? s.glyphs) as GlyphMap;
  const metrics = useAppStore((s) => s.metrics);
  const sharedPairs = useAppStore((s) => s.kerningPairs);
  const overrides = useAppStore((s) => s.kerningOverridesByStyle);
  const reviewed = useAppStore((s) => s.kerningReviewed);
  const setReviewed = useAppStore((s) => s.setKerningReviewed);
  const setPair = useAppStore((s) => s.setFamilyKerningPair);
  const setPairsBulk = useAppStore((s) => s.setFamilyKerningPairsBulk);

  const pairs: KerningPairs = useMemo(() => effectiveKerningPairs(sharedPairs, overrides, styleKey), [sharedPairs, overrides, styleKey]);
  const [extended, setExtended] = useState(false);
  const groups = useMemo(() => buildDictionaryGroups(glyphs, extended), [glyphs, extended]);
  const [groupId, setGroupId] = useState<DictGroupId>("UU");
  const group: DictGroup | undefined = groups.find((g) => g.id === groupId) ?? groups[0];
  const [filter, setFilter] = useState<Filter>("warn");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  // Measuring runs in small chunks; re-runs only when the drawings change.
  const [results, setResults] = useState<Map<string, PairResult> | null>(null);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const signal = { cancelled: false };
    setProgress(0);
    const t = window.setTimeout(() => {
      void analyseDictionary(glyphs, metrics, groups, (d, n) => setProgress(n ? d / n : 1), signal).then((r) => {
        if (r && !signal.cancelled) setResults(r);
      });
    }, 120);
    return () => {
      signal.cancelled = true;
      window.clearTimeout(t);
    };
  }, [glyphs, metrics, groups]);

  const threshold = needsCheckThreshold(metrics);
  const reviewKey = useCallback((l: string, r: string) => `${context}|${kerningKey(l, r)}`, [context]);

  const itemsByGroup = useMemo(() => {
    const out = new Map<DictGroupId, Item[]>();
    if (!results) return out;
    for (const g of groups) {
      const list: Item[] = [];
      for (const [l, r] of g.pairs) {
        const res = results.get(pairId(l, r));
        if (!res) continue;
        const cur = pairs[kerningKey(l, r)] ?? 0;
        const dev = pairDeviation(res, cur);
        list.push({ l, r, res, cur, dev, warn: dev >= threshold, ok: !!reviewed[reviewKey(l, r)] });
      }
      out.set(g.id, list);
    }
    return out;
  }, [results, groups, pairs, threshold, reviewed, reviewKey]);

  const totals = useMemo(() => {
    let total = 0, ok = 0, warn = 0;
    for (const list of itemsByGroup.values()) for (const it of list) {
      total++;
      if (it.ok) ok++;
      else if (it.warn) warn++;
    }
    return { total, ok, warn };
  }, [itemsByGroup]);

  const groupItems = group ? itemsByGroup.get(group.id) ?? [] : [];
  const counts = useMemo(() => {
    const c = { warn: 0, ok: 0, all: groupItems.length };
    for (const it of groupItems) {
      if (it.ok) c.ok++;
      else if (it.warn) c.warn++;
    }
    return c;
  }, [groupItems]);

  // Which pairs are listed, and in what order, is decided when you open a
  // group / filter (or the measurement finishes) and then held: adjusting a
  // pair updates its card in place instead of making it jump or vanish
  // mid-edit. Switching group or filter refreshes the list.
  const latestItems = useRef(groupItems);
  latestItems.current = groupItems;
  const order = useMemo(() => {
    const q = query.trim();
    let list = latestItems.current;
    if (q) list = list.filter((it) => (it.l + it.r).includes(q));
    if (filter === "warn") list = list.filter((it) => it.warn && !it.ok).sort((a, b) => b.dev - a.dev);
    else if (filter === "ok") list = list.filter((it) => it.ok);
    return list.map((it) => it.l + "\u0000" + it.r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, group?.id, filter, query]);
  const visible = useMemo(() => {
    const byKey = new Map(groupItems.map((it) => [it.l + "\u0000" + it.r, it]));
    return order.map((k) => byKey.get(k)).filter((it): it is Item => !!it);
  }, [order, groupItems]);

  useEffect(() => setShown(PAGE), [groupId, filter, query, extended]);

  const applyAll = () => {
    const list = groupItems.filter((it) => it.warn && !it.ok && it.res.suggest !== it.cur);
    if (!list.length) return;
    // One store update + one undo step for the whole batch.
    setPairsBulk(context, list.map((it) => [it.l, it.r, it.res.suggest] as [string, string, number]));
  };

  const frame = group?.frames[0] ?? ["", ""];
  const done = totals.total ? Math.round(((totals.total - totals.warn) / totals.total) * 100) : 0;
  const busy = !results;

  if (!groups.length) {
    return (
      <div className={`fm-lab-stage fm-kdict ${bg}`} data-testid="kdict">
        <p className="fm-kdict-note">Belum ada glyph yang digambar. Kamus Kerning terisi otomatis setelah huruf, angka atau tanda baca punya outline.</p>
      </div>
    );
  }

  return (
    <div className={`fm-lab-stage fm-kdict ${bg}`} data-testid="kdict">
      <div className="fm-kdict-top">
        <div className="fm-kdict-summary" aria-live="polite">
          {busy ? (
            <span><Loader2 size={12} className="fm-spin" /> Mengukur {Math.round(progress * 100)}%</span>
          ) : (
            <span>
              <b>{totals.warn.toLocaleString("id-ID")}</b> perlu dicek dari {totals.total.toLocaleString("id-ID")} pasangan
            </span>
          )}
          <span className="fm-kdict-meter" aria-hidden="true"><span style={{ width: `${busy ? progress * 100 : done}%` }} /></span>
          {!busy && <span className="fm-kdict-dim">{done}% rapi</span>}
        </div>
        <label className="fm-kdict-toggle">
          <input type="checkbox" checked={extended} onChange={(e) => setExtended(e.target.checked)} data-testid="kdict-extended" />
          Huruf beraksen
        </label>
      </div>

      <nav className="fm-kdict-groups" aria-label="Kelompok pasangan">
        {groups.map((g) => {
          const list = itemsByGroup.get(g.id) ?? [];
          const warn = list.filter((it) => it.warn && !it.ok).length;
          return (
            <button
              key={g.id}
              type="button"
              className={group?.id === g.id ? "active" : ""}
              onClick={() => setGroupId(g.id)}
              data-testid={`kdict-group-${g.id}`}
              title={`${g.pairs.length.toLocaleString("id-ID")} pasangan`}
            >
              {g.label}
              {!busy && warn > 0 && <span className="n">{warn}</span>}
            </button>
          );
        })}
      </nav>

      <div className="fm-kdict-bar">
        <div className="fm-kdict-seg" role="group" aria-label="Tampilkan">
          {(["warn", "all", "ok"] as Filter[]).map((f) => (
            <button key={f} type="button" className={filter === f ? "active" : ""} onClick={() => setFilter(f)} data-testid={`kdict-filter-${f}`}>
              {{ warn: "Perlu dicek", all: "Semua", ok: "Selesai" }[f]} <span>{counts[f].toLocaleString("id-ID")}</span>
            </button>
          ))}
        </div>
        <label className="fm-kdict-search">
          <Search size={13} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari pasangan" aria-label="Cari pasangan" />
        </label>
        <button type="button" className="fm-kdict-applyall" onClick={applyAll} disabled={busy || counts.warn === 0} data-testid="kdict-apply-all">
          Pakai semua saran
        </button>
      </div>

      {filter === "warn" && !busy && (
        <p className="fm-kdict-note">
          Jarak pasangan ini menyimpang dari spasi normal huruf-hurufnya. Geser huruf kanan ke kiri/kanan untuk mengatur jaraknya, atau pakai saran, lalu tandai ✓ kalau sudah pas.
        </p>
      )}

      <div className="fm-kdict-grid" data-testid="kdict-grid">
        {busy && <p className="fm-kdict-note">Mengukur jarak optik tiap pasangan…</p>}
        {!busy && visible.length === 0 && (
          <p className="fm-kdict-note">{filter === "warn" ? "Kelompok ini sudah rapi. Tidak ada yang perlu dicek." : "Belum ada pasangan di sini."}</p>
        )}
        {!busy &&
          visible.slice(0, shown).map((it) => (
            <PairCard
              key={it.l + it.r}
              item={it}
              frame={frame}
              glyphs={glyphs}
              pairs={pairs}
              upm={metrics.unitsPerEm}
              selected={!!selected && selected.left === it.l && selected.right === it.r}
              onSelect={() => onSelect({ left: it.l, right: it.r })}
              onSet={(v) => setPair(context, it.l, it.r, v)}
              onToggleOk={() => setReviewed([reviewKey(it.l, it.r)], !it.ok)}
            />
          ))}
      </div>
      {!busy && visible.length > shown && (
        <button type="button" className="fm-kdict-more" onClick={() => setShown((n) => n + PAGE * 2)}>
          Tampilkan {Math.min(PAGE * 2, visible.length - shown).toLocaleString("id-ID")} lagi
        </button>
      )}
    </div>
  );
}

const SPEC_PX = 52;

const PairCard = memo(function PairCard({
  item,
  frame,
  glyphs,
  pairs,
  upm,
  selected,
  onSelect,
  onSet,
  onToggleOk,
}: {
  item: Item;
  frame: [string, string];
  glyphs: GlyphMap;
  pairs: KerningPairs;
  upm: number;
  selected: boolean;
  onSelect: () => void;
  onSet: (value: number) => void;
  onToggleOk: () => void;
}) {
  const text = `${frame[0]}${item.l}${item.r}${frame[1]}`;
  const chars = useMemo(() => [...text], [text]);
  const ctrlL = [...frame[0]].length;
  const key = kerningKey(item.l, item.r);

  // Drag to kern: grab the pair and slide — the right-hand glyph follows the
  // pointer. While dragging only this card re-renders (a tiny local pair map,
  // no store writes); the value is saved once on release.
  const [drag, setDrag] = useState<{ id: number; x0: number; v0: number; v: number; moved: boolean } | null>(null);
  const value = drag ? drag.v : item.cur;
  const localPairs = useMemo(() => {
    const out: KerningPairs = {};
    for (let i = 0; i + 1 < chars.length; i++) {
      const k = kerningKey(chars[i], chars[i + 1]);
      const v = pairs[k];
      if (v !== undefined) out[k] = v;
    }
    if (drag) out[key] = drag.v;
    return out;
  }, [chars, pairs, drag, key]);

  // Control letters are drawn dimmer so the pair itself reads first.
  const dim = useCallback(
    (index: number) => (index < ctrlL || index >= ctrlL + 2 ? "color-mix(in srgb, currentColor 32%, transparent)" : undefined),
    [ctrlL]
  );
  // Half speed: the glyph moves half as far as the pointer, so ~10 units per
  // screen px at this size — fine enough to place by finger on iPad.
  const unitsPerPx = (upm / SPEC_PX) * 0.5;
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: e.pointerId, x0: e.clientX, v0: item.cur, v: item.cur, moved: false });
    onSelect();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const moved = drag.moved || Math.abs(dx) > 2;
    if (!moved) return;
    // Hold Shift (or Alt) for 1-unit steps; otherwise snap to 5 units.
    const raw = drag.v0 + dx * unitsPerPx;
    const step = e.shiftKey || e.altKey ? 1 : 5;
    const v = Math.round(raw / step) * step;
    if (v !== drag.v || !drag.moved) setDrag({ ...drag, v, moved: true });
  };
  const finish = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { moved, v, v0 } = drag;
    setDrag(null);
    if (moved && v !== v0) onSet(v);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? NUDGE : 1;
    onSet(item.cur + (e.key === "ArrowLeft" ? -step : step));
  };

  const showSuggest = item.warn && !item.ok && item.res.suggest !== item.cur;
  const fmt = (v: number) => (v > 0 ? `+${v}` : `${v}`);
  return (
    <div className={`fm-kdict-card ${selected ? "selected" : ""} ${item.ok ? "done" : ""} ${drag?.moved ? "dragging" : ""}`} data-testid={`kdict-card-${item.l}${item.r}`}>
      <div
        className="fm-kdict-spec"
        role="slider"
        tabIndex={0}
        aria-label={`Kerning ${item.l}${item.r}`}
        aria-valuenow={value}
        title="Geser ke kiri/kanan untuk mengatur jarak (Shift = halus). Panah ← → juga bisa."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onKeyDown={onKeyDown}
        data-testid={`kdict-spec-${item.l}${item.r}`}
      >
        <GlyphRun text={text} fontSizePx={SPEC_PX} glyphsOverride={glyphs} kerningPairsOverride={localPairs} colorForIndex={dim} ghostEmpty />
      </div>
      <div className="fm-kdict-row">
        <span className="fm-kdict-pair">{item.l}{item.r}</span>
        <span className="fm-kdict-nudge">
          <button type="button" onClick={() => onSet(item.cur - NUDGE)} aria-label="Rapatkan 10 unit" title="Rapatkan 10"><Minus size={11} /></button>
          <span className="v">{fmt(value)}</span>
          <button type="button" onClick={() => onSet(item.cur + NUDGE)} aria-label="Renggangkan 10 unit" title="Renggangkan 10"><Plus size={11} /></button>
        </span>
        {showSuggest && !drag?.moved && (
          <button type="button" className="fm-kdict-suggest" onClick={() => onSet(item.res.suggest)} title="Pakai nilai saran">
            saran {fmt(item.res.suggest)}
          </button>
        )}
        <button
          type="button"
          className={`fm-kdict-ok ${item.ok ? "on" : ""}`}
          onClick={onToggleOk}
          aria-pressed={item.ok}
          title={item.ok ? "Batalkan tanda selesai" : "Tandai sudah pas"}
          data-testid={`kdict-ok-${item.l}${item.r}`}
        >
          <Check size={13} />
        </button>
      </div>
    </div>
  );
});
