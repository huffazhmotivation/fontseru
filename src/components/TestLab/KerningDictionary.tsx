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
  const beginBulk = useAppStore((s) => s.beginFamilyKerningDrag);
  const setPairLive = useAppStore((s) => s.setFamilyKerningPairLive);
  const endBulk = useAppStore((s) => s.endFamilyKerningDrag);

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
    const list = groupItems.filter((it) => it.warn && !it.ok);
    if (!list.length) return;
    beginBulk(context);
    for (const it of list) setPairLive(context, it.l, it.r, it.res.suggest);
    endBulk(); // one undo step for the whole batch
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
          Jarak pasangan ini menyimpang dari spasi normal huruf-hurufnya. Klik untuk mengatur di panel kanan, pakai saran, lalu tandai ✓ kalau sudah pas.
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
              selected={!!selected && selected.left === it.l && selected.right === it.r}
              onSelect={() => onSelect({ left: it.l, right: it.r })}
              onNudge={(d) => setPair(context, it.l, it.r, it.cur + d)}
              onApply={() => setPair(context, it.l, it.r, it.res.suggest)}
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

const PairCard = memo(function PairCard({
  item,
  frame,
  glyphs,
  pairs,
  selected,
  onSelect,
  onNudge,
  onApply,
  onToggleOk,
}: {
  item: Item;
  frame: [string, string];
  glyphs: GlyphMap;
  pairs: KerningPairs;
  selected: boolean;
  onSelect: () => void;
  onNudge: (delta: number) => void;
  onApply: () => void;
  onToggleOk: () => void;
}) {
  const text = `${frame[0]}${item.l}${item.r}${frame[1]}`;
  const ctrlL = [...frame[0]].length;
  // Control letters are drawn dimmer so the pair itself reads first.
  const dim = useCallback(
    (index: number) => (index < ctrlL || index >= ctrlL + 2 ? "color-mix(in srgb, currentColor 32%, transparent)" : undefined),
    [ctrlL]
  );
  const showSuggest = item.warn && !item.ok && item.res.suggest !== item.cur;
  const fmt = (v: number) => (v > 0 ? `+${v}` : `${v}`);
  return (
    <div className={`fm-kdict-card ${selected ? "selected" : ""} ${item.ok ? "done" : ""}`} data-testid={`kdict-card-${item.l}${item.r}`}>
      <button type="button" className="fm-kdict-spec" onClick={onSelect} title="Pilih pasangan ini untuk diatur di panel kanan">
        <GlyphRun text={text} fontSizePx={44} glyphsOverride={glyphs} kerningPairsOverride={pairs} colorForIndex={dim} ghostEmpty />
      </button>
      <div className="fm-kdict-row">
        <span className="fm-kdict-pair">{item.l}{item.r}</span>
        <span className="fm-kdict-nudge">
          <button type="button" onClick={() => onNudge(-NUDGE)} aria-label="Rapatkan 10 unit" title="Rapatkan 10"><Minus size={11} /></button>
          <span className="v">{fmt(item.cur)}</span>
          <button type="button" onClick={() => onNudge(NUDGE)} aria-label="Renggangkan 10 unit" title="Renggangkan 10"><Plus size={11} /></button>
        </span>
        {showSuggest && (
          <button type="button" className="fm-kdict-suggest" onClick={onApply} title="Pakai nilai saran">
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
